import type { AttemptOutcome } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { decryptSecret } from '../utils/crypto.js';
import { validateDestinationUrl } from '../utils/destination-url.js';
import { logger } from '../utils/logger.js';
import { computeRetryDelayMs } from '../utils/retry-policy.js';
import { dispatchWebhook } from './delivery-http.service.js';
import {
  cancelClaimedDelivery,
  failClaimedDeliveryWithoutAttempt,
  recordAttemptResult,
  type AttemptTransition,
  type ClaimedDelivery,
} from './delivery-queue.service.js';

/**
 * Executes ONE claimed delivery end-to-end (UC-23):
 *   load context → pre-send gate → re-validate destination → sign → POST
 *   over a PINNED connection → record result under the fencing token.
 *
 * Every terminal write is CAS-guarded; a lost claim means this worker
 * writes nothing. Errors never escape — one bad destination can never
 * crash a tick (the caller just moves to the next claim).
 */

export type ExecutionOutcome =
  | 'succeeded'
  | 'retrying' // retryable failure, budget left → pending with backoff
  | 'dead_lettered' // retryable failure, budget exhausted
  | 'failed' // permanent failure
  | 'cancelled'
  | 'stale' // claim lost before recording — nothing written
  | 'error'; // unexpected internal error, delivery left to lease recovery

/**
 * The approved post-failure decision (AC-03): permanent → failed; retryable
 * with budget left → pending + jittered exponential backoff; retryable with
 * the snapshotted max_attempts spent → dead_lettered.
 */
function resolveFailureTransition(
  retryable: boolean,
  claimed: ClaimedDelivery,
): AttemptTransition {
  if (!retryable) {
    return { to: 'failed' };
  }
  if (claimed.attemptCount < claimed.maxAttempts) {
    return { to: 'pending', nextAttemptInMs: computeRetryDelayMs(claimed.attemptCount) };
  }
  return { to: 'dead_lettered' };
}

const outcomeOfTransition = (transition: AttemptTransition): ExecutionOutcome =>
  transition.to === 'pending' ? 'retrying' : transition.to;

export interface ExecutionOptions {
  /** Test seam; defaults to the (production-refused) env flag. */
  allowPrivateDestinations?: boolean;
}

export async function executeClaimedDelivery(
  claimed: ClaimedDelivery,
  options: ExecutionOptions = {},
): Promise<ExecutionOutcome> {
  const guard = { deliveryId: claimed.id, claimToken: claimed.claimToken };
  const allowPrivate = options.allowPrivateDestinations ?? env.DESTINATION_ALLOW_PRIVATE;

  try {
    const delivery = await prisma.delivery.findUnique({
      where: { id: claimed.id },
      select: {
        event: {
          select: { id: true, payload: true, eventType: { select: { name: true } } },
        },
        endpoint: {
          select: {
            url: true,
            isActive: true,
            deletedAt: true,
            timeoutMs: true,
            signingSecret: true,
          },
        },
      },
    });
    if (!delivery) {
      logger.error({ deliveryId: claimed.id }, 'Claimed delivery vanished');
      return 'error';
    }
    const { event, endpoint } = delivery;

    // --- Pre-send gate (frozen design): no HTTP to dead endpoints, ever. ---
    if (endpoint.deletedAt !== null) {
      const applied = await cancelClaimedDelivery(guard, 'cancelled: endpoint deleted');
      return applied ? 'cancelled' : 'stale';
    }
    if (!endpoint.isActive) {
      const applied = await cancelClaimedDelivery(guard, 'cancelled: endpoint inactive');
      return applied ? 'cancelled' : 'stale';
    }

    // --- Signing secret (never logged). ---
    let signingSecret: string;
    try {
      signingSecret = decryptSecret(endpoint.signingSecret);
    } catch {
      const applied = await failClaimedDeliveryWithoutAttempt(
        guard,
        'configuration: signing secret unavailable',
      );
      logger.error({ deliveryId: claimed.id }, 'Signing secret could not be decrypted');
      return applied ? 'failed' : 'stale';
    }

    // The EXACT bytes that are signed and sent.
    const rawBody = JSON.stringify(event.payload);
    const timeoutMs = endpoint.timeoutMs ?? env.DELIVERY_TIMEOUT_MS_DEFAULT;
    const startedAt = new Date();

    // --- Delivery-time SSRF re-validation (never trust registration time). ---
    const validation = await validateDestinationUrl(endpoint.url, { allowPrivate });
    if (!validation.valid) {
      // DNS blips are transient → retry policy; SSRF/policy rejections are
      // permanent (FR-41).
      const category = validation.reason.toLowerCase().includes('resolv') ? 'dns' : 'ssrf_blocked';
      const retryable = category === 'dns';
      const transition = resolveFailureTransition(retryable, claimed);
      const applied = await recordAttemptResult(guard, transition, {
        attemptNumber: claimed.attemptCount,
        outcome: retryable ? 'failed_retryable' : 'failed_permanent',
        responseStatus: null,
        latencyMs: 0,
        errorCategory: category,
        errorMessage: validation.reason,
        requestUrl: endpoint.url,
        startedAt,
        finishedAt: new Date(),
      });
      return applied ? outcomeOfTransition(transition) : 'stale';
    }

    // --- Signed POST over a connection pinned to the vetted addresses. ---
    const result = await dispatchWebhook({
      url: endpoint.url,
      addresses: validation.addresses,
      rawBody,
      signingSecret,
      deliveryId: claimed.id,
      eventId: event.id,
      eventType: event.eventType.name,
      attemptNumber: claimed.attemptCount,
      timeoutMs,
    });
    const finishedAt = new Date();

    if (result.ok) {
      const applied = await recordAttemptResult(guard, { to: 'succeeded' }, {
        attemptNumber: claimed.attemptCount,
        outcome: 'success',
        responseStatus: result.statusCode,
        latencyMs: result.latencyMs,
        errorCategory: null,
        errorMessage: null,
        requestUrl: endpoint.url,
        startedAt,
        finishedAt,
      });
      return applied ? 'succeeded' : 'stale';
    }

    // FR-41 classification drives the retry decision (AC-03).
    const retryable =
      result.errorCategory === 'timeout' ||
      result.errorCategory === 'connection' ||
      result.errorCategory === 'dns' ||
      result.errorCategory === 'http_5xx' ||
      result.statusCode === 408 ||
      result.statusCode === 429;
    const outcome: AttemptOutcome = retryable ? 'failed_retryable' : 'failed_permanent';
    const transition = resolveFailureTransition(retryable, claimed);

    const applied = await recordAttemptResult(guard, transition, {
      attemptNumber: claimed.attemptCount,
      outcome,
      responseStatus: result.statusCode,
      latencyMs: result.latencyMs,
      errorCategory: result.errorCategory,
      errorMessage: result.errorMessage,
      requestUrl: endpoint.url,
      startedAt,
      finishedAt,
    });
    return applied ? outcomeOfTransition(transition) : 'stale';
  } catch (err) {
    // Unexpected internal failure: leave the delivery to lease recovery —
    // never let one delivery take down the tick.
    logger.error({ err, deliveryId: claimed.id }, 'Delivery execution error');
    return 'error';
  }
}
