import { prisma } from '../db/prisma.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';
import { getOwnedProject } from './project.service.js';

/**
 * Manual retry (UC-30, frozen design):
 *   - eligible source states: failed, dead_lettered, cancelled — the last
 *     only while its endpoint is active again (approved decision)
 *   - grants EXACTLY ONE additional attempt: max_attempts = attempt_count+1
 *     (never resets attempt_count — history is truth)
 *   - re-opens the delivery: pending, next_attempt_at = now() (server
 *     clock), completed_at = NULL, claim/lease/worker cleared
 *   - previous delivery_attempts rows are never touched
 *
 * The single guarded UPDATE is the authority: the state predicate plus the
 * endpoint-liveness EXISTS run inside one atomic statement, so concurrent
 * duplicate retry requests collapse to one winner (the loser matches zero
 * rows and reports the new state), and a worker that claimed the delivery
 * in between can never be clobbered (its status is no longer eligible).
 */

const RETRYABLE_STATES = new Set(['failed', 'dead_lettered', 'cancelled']);

const RETRY_RESULT_SELECT = {
  id: true,
  status: true,
  attemptCount: true,
  maxAttempts: true,
  nextAttemptAt: true,
  lastError: true,
} as const;

export async function manualRetryDelivery(ownerId: string, projectId: string, deliveryId: string) {
  await getOwnedProject(ownerId, projectId);

  const delivery = await prisma.delivery.findFirst({
    where: { id: deliveryId, projectId },
    select: {
      status: true,
      endpoint: { select: { isActive: true, deletedAt: true } },
    },
  });
  if (!delivery) {
    throw AppError.notFound('Delivery not found'); // includes foreign projects
  }

  // Friendly conflict messages for the common ineligible states…
  if (delivery.status === 'succeeded') {
    throw new AppError('Delivery already succeeded and cannot be retried', 409, ErrorCodes.CONFLICT);
  }
  if (delivery.status === 'processing') {
    throw new AppError('Delivery is currently being processed', 409, ErrorCodes.CONFLICT);
  }
  if (delivery.status === 'pending') {
    throw new AppError('Delivery is already scheduled for retry', 409, ErrorCodes.CONFLICT);
  }
  if (delivery.endpoint.deletedAt !== null || !delivery.endpoint.isActive) {
    throw new AppError(
      'Endpoint is not active; reactivate it before retrying',
      409,
      ErrorCodes.CONFLICT,
    );
  }

  // …and the guarded, atomic transition as the final authority.
  const affected = await prisma.$executeRaw`
    UPDATE deliveries d
    SET status = 'pending',
        next_attempt_at = now(),
        max_attempts = d.attempt_count + 1,
        completed_at = NULL,
        claim_token = NULL,
        lease_expires_at = NULL,
        locked_by = NULL,
        updated_at = now()
    WHERE d.id = ${deliveryId}::uuid
      AND d.project_id = ${projectId}::uuid
      AND d.status IN ('failed', 'dead_lettered', 'cancelled')
      AND EXISTS (
        SELECT 1 FROM endpoints e
        WHERE e.id = d.endpoint_id AND e.is_active AND e.deleted_at IS NULL
      )
  `;

  if (affected === 0) {
    // Lost a race (concurrent retry, claim, or endpoint change).
    const current = await prisma.delivery.findFirst({
      where: { id: deliveryId, projectId },
      select: { status: true },
    });
    throw new AppError(
      current?.status === 'pending'
        ? 'Delivery is already scheduled for retry'
        : 'Delivery state changed; retry is not applicable',
      409,
      ErrorCodes.CONFLICT,
    );
  }

  const updated = await prisma.delivery.findFirst({
    where: { id: deliveryId, projectId },
    select: RETRY_RESULT_SELECT,
  });
  if (!updated) {
    throw AppError.notFound('Delivery not found');
  }
  return updated;
}

/** Visible for tests/documentation. */
export const MANUALLY_RETRYABLE_STATES = RETRYABLE_STATES;
