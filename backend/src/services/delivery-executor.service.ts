import type { AttemptOutcome } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { decryptSecret } from '../utils/crypto.js';
import { validateDestinationUrl } from '../utils/destination-url.js';
import { logger } from '../utils/logger.js';
import { dispatchWebhook } from './delivery-http.service.js';
import {
  cancelClaimedDelivery,
  failClaimedDeliveryWithoutAttempt,
  recordAttemptResult,
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
  | 'failed'
  | 'cancelled'
  | 'stale' // claim lost before recording — nothing written
  | 'error'; // unexpected internal error, delivery left to lease recovery

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
      const category = validation.reason.toLowerCase().includes('resolv') ? 'dns' : 'ssrf_blocked';
      const applied = await recordAttemptResult(guard, 'failed', {
        attemptNumber: claimed.attemptCount,
        // DNS blips are transient (retryable once 5B.3 lands); policy
        // rejections are permanent.
        outcome: category === 'dns' ? 'failed_retryable' : 'failed_permanent',
        responseStatus: null,
        latencyMs: 0,
        errorCategory: category,
        errorMessage: validation.reason,
        requestUrl: endpoint.url,
        startedAt,
        finishedAt: new Date(),
      });
      return applied ? 'failed' : 'stale';
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
      const applied = await recordAttemptResult(guard, 'succeeded', {
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

    // Truthful FR-41 classification on the ATTEMPT (5B.3 uses it for retry
    // decisions); the DELIVERY transition in this phase is always `failed`.
    const retryable =
      result.errorCategory === 'timeout' ||
      result.errorCategory === 'connection' ||
      result.errorCategory === 'dns' ||
      result.errorCategory === 'http_5xx' ||
      result.statusCode === 408 ||
      result.statusCode === 429;
    const outcome: AttemptOutcome = retryable ? 'failed_retryable' : 'failed_permanent';

    const applied = await recordAttemptResult(guard, 'failed', {
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
    return applied ? 'failed' : 'stale';
  } catch (err) {
    // Unexpected internal failure: leave the delivery to lease recovery —
    // never let one delivery take down the tick.
    logger.error({ err, deliveryId: claimed.id }, 'Delivery execution error');
    return 'error';
  }
}
