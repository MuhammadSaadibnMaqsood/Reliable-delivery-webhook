import type { AttemptOutcome, ErrorCategory } from '@prisma/client';
import { prisma } from '../db/prisma.js';

/**
 * Database-level delivery queue (frozen design, UC-23 / NFR-18).
 *
 * This module is the ONLY place that touches the queue columns with raw SQL
 * (Prisma's API cannot express FOR UPDATE SKIP LOCKED or UPDATE…FROM…
 * RETURNING). Every statement sets updated_at = now() explicitly, because
 * @updatedAt does not apply to raw SQL.
 *
 * ── Fencing contract ─────────────────────────────────────────────────────
 * A claim mints a fresh claim_token and increments attempt_count (the only
 * place it ever increments). Every later write about that claim must be a
 * compare-and-swap on (id, status='processing', claim_token=<held token>);
 * zero affected rows means THE CLAIM IS LOST and the caller must write
 * nothing further. Lease expiry alone does NOT invalidate a token — the
 * token dies only when a newer claim replaces it or the exhausted-lease
 * sweep clears it. Consequently a slow-but-alive worker whose delivery was
 * never reclaimed still owns its claim, and its CAS correctly succeeds.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface ClaimedDelivery {
  id: string;
  claimToken: string;
  attemptCount: number;
  maxAttempts: number;
  eventId: string;
  endpointId: string;
  projectId: string;
  leaseExpiresAt: Date;
}

/** The pair a worker must present for every post-claim write. */
export interface ClaimGuard {
  deliveryId: string;
  claimToken: string;
}

/**
 * Sweep BEFORE claiming: a processing delivery whose lease expired on its
 * final attempt has no attempts left to reclaim with — it dead-letters
 * directly (clearing the lease, worker id and token, which is what fences
 * out the crashed-but-maybe-still-running worker). This is also the one
 * transition that writes no delivery_attempt row: attempts record real HTTP
 * outcomes only, and the crashed attempt is the numbering gap.
 */
export async function sweepExhaustedExpiredLeases(): Promise<number> {
  return prisma.$executeRaw`
    UPDATE deliveries
    SET status = 'dead_lettered',
        completed_at = now(),
        updated_at = now(),
        lease_expires_at = NULL,
        locked_by = NULL,
        claim_token = NULL,
        last_error = COALESCE(last_error, 'processor crashed on final attempt')
    WHERE status = 'processing'
      AND lease_expires_at < now()
      AND attempt_count >= max_attempts
  `;
}

/**
 * Atomically claim up to batchSize due deliveries (UC-23):
 *   - pending and due, OR processing with an expired lease (crash reclaim)
 *   - never past the attempt budget (top-level conjunct: no claim can ever
 *     violate the attempt_count <= max_attempts CHECK)
 * FOR UPDATE SKIP LOCKED makes concurrent workers skip each other's rows,
 * so two workers can never claim the same delivery; the persisted
 * status/lease carry that exclusivity across transactions.
 */
export async function claimDueDeliveries(
  workerId: string,
  batchSize: number,
  leaseMs: number,
): Promise<ClaimedDelivery[]> {
  return prisma.$queryRaw<ClaimedDelivery[]>`
    WITH claimable AS (
      SELECT id FROM deliveries
      WHERE attempt_count < max_attempts
        AND (
          (status = 'pending' AND next_attempt_at <= now())
          OR (status = 'processing' AND lease_expires_at < now())
        )
      ORDER BY next_attempt_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE deliveries d
    SET status = 'processing',
        attempt_count = d.attempt_count + 1,
        claim_token = gen_random_uuid(),
        lease_expires_at = now() + ${leaseMs} * interval '1 millisecond',
        locked_by = ${workerId},
        updated_at = now()
    FROM claimable
    WHERE d.id = claimable.id
    RETURNING d.id,
              d.claim_token   AS "claimToken",
              d.attempt_count AS "attemptCount",
              d.max_attempts  AS "maxAttempts",
              d.event_id      AS "eventId",
              d.endpoint_id   AS "endpointId",
              d.project_id    AS "projectId",
              d.lease_expires_at AS "leaseExpiresAt"
  `;
}

/**
 * Lease heartbeat — the canonical CAS write. Returns false when the claim
 * was lost (reclaimed or swept); the caller must then stop touching this
 * delivery entirely.
 */
export async function extendLease(guard: ClaimGuard, leaseMs: number): Promise<boolean> {
  const affected = await prisma.$executeRaw`
    UPDATE deliveries
    SET lease_expires_at = now() + ${leaseMs} * interval '1 millisecond',
        updated_at = now()
    WHERE id = ${guard.deliveryId}::uuid
      AND status = 'processing'
      AND claim_token = ${guard.claimToken}::uuid
  `;
  return affected === 1;
}

export interface AttemptResultRecord {
  attemptNumber: number;
  outcome: AttemptOutcome;
  responseStatus: number | null;
  latencyMs: number;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  requestUrl: string;
  startedAt: Date;
  finishedAt: Date;
}

/**
 * Persist an attempt's result: the CAS delivery transition and the
 * delivery_attempts insert happen in ONE transaction, so an attempt row
 * exists if and only if its writer held the claim when it was recorded.
 * Zero CAS rows ⇒ claim lost ⇒ the transaction rolls back having written
 * NOTHING (the fenced-out worker leaves no trace — its attempt shows as the
 * same numbering gap a crash leaves).
 *
 * Phase 5B.2 transitions: success → succeeded, any failure → failed (retry
 * scheduling arrives in 5B.3). Terminal transitions clear lease/worker/
 * token, satisfying the claim_token lifecycle CHECK.
 */
export async function recordAttemptResult(
  guard: ClaimGuard,
  nextStatus: 'succeeded' | 'failed',
  attempt: AttemptResultRecord,
): Promise<boolean> {
  const lastError =
    nextStatus === 'succeeded'
      ? null
      : `${attempt.errorCategory ?? 'error'}: ${attempt.errorMessage ?? 'delivery failed'}`.slice(
          0,
          500,
        );

  return prisma.$transaction(async (tx) => {
    const affected = await tx.$executeRaw`
      UPDATE deliveries
      SET status = ${nextStatus}::delivery_status,
          completed_at = now(),
          last_error = ${lastError},
          claim_token = NULL,
          lease_expires_at = NULL,
          locked_by = NULL,
          updated_at = now()
      WHERE id = ${guard.deliveryId}::uuid
        AND status = 'processing'
        AND claim_token = ${guard.claimToken}::uuid
    `;
    if (affected === 0) {
      return false; // claim lost — write nothing at all
    }

    await tx.deliveryAttempt.create({
      data: {
        deliveryId: guard.deliveryId,
        attemptNumber: attempt.attemptNumber,
        trigger: 'automatic',
        outcome: attempt.outcome,
        responseStatus: attempt.responseStatus,
        latencyMs: attempt.latencyMs,
        errorCategory: attempt.errorCategory,
        errorMessage: attempt.errorMessage?.slice(0, 500) ?? null,
        requestUrl: attempt.requestUrl,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
      },
    });
    return true;
  });
}

/**
 * Pre-send gate outcome (frozen design): a claimed delivery whose endpoint
 * turned inactive/deleted between fan-out and execution transitions to
 * cancelled WITHOUT an attempt row — no HTTP happened, and attempts record
 * real HTTP outcomes only.
 */
export async function cancelClaimedDelivery(guard: ClaimGuard, reason: string): Promise<boolean> {
  const affected = await prisma.$executeRaw`
    UPDATE deliveries
    SET status = 'cancelled',
        completed_at = now(),
        last_error = ${reason.slice(0, 500)},
        claim_token = NULL,
        lease_expires_at = NULL,
        locked_by = NULL,
        updated_at = now()
    WHERE id = ${guard.deliveryId}::uuid
      AND status = 'processing'
      AND claim_token = ${guard.claimToken}::uuid
  `;
  return affected === 1;
}

/**
 * Terminal failure without an HTTP attempt (e.g. the signing secret cannot
 * be decrypted): CAS to failed, no attempt row.
 */
export async function failClaimedDeliveryWithoutAttempt(
  guard: ClaimGuard,
  reason: string,
): Promise<boolean> {
  const affected = await prisma.$executeRaw`
    UPDATE deliveries
    SET status = 'failed',
        completed_at = now(),
        last_error = ${reason.slice(0, 500)},
        claim_token = NULL,
        lease_expires_at = NULL,
        locked_by = NULL,
        updated_at = now()
    WHERE id = ${guard.deliveryId}::uuid
      AND status = 'processing'
      AND claim_token = ${guard.claimToken}::uuid
  `;
  return affected === 1;
}
