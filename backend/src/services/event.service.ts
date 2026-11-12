import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';
import { canonicalPayloadHash } from '../utils/canonical-json.js';
import type { IngestEventInput } from '../validators/event.validators.js';

export interface IngestedEvent {
  id: string;
  eventType: string;
  receivedAt: Date;
}

export type IngestResult =
  | { kind: 'created'; event: IngestedEvent; deliveriesCreated: number }
  | { kind: 'replay'; event: IngestedEvent };

/**
 * Event ingestion with reliable idempotency (UC-20, AC-01).
 * projectId comes exclusively from the authenticated API key context —
 * never from the client.
 *
 * Idempotency is enforced by the (project_id, idempotency_key) UNIQUE
 * constraint, not by a pre-check: we always ATTEMPT the insert, and on a
 * unique violation fetch the committed winner and compare payload hashes —
 * identical → replay the original event; different → 409, existing event
 * untouched. Two racing requests are therefore safe by construction: the
 * loser's P2002 only surfaces after the winner has committed, so the
 * follow-up read always finds it. Scoping the constraint by project keeps
 * the same key string independent across projects.
 */
export async function ingestEvent(
  projectId: string,
  input: IngestEventInput,
  idempotencyKey: string,
): Promise<IngestResult> {
  // FR-26: the project's event-type registry is the validation source of
  // truth. Scoping by projectId makes a cross-project type indistinguishable
  // from an unknown one.
  const eventType = await prisma.eventType.findFirst({
    where: { projectId, name: input.eventType },
    select: { id: true },
  });
  if (!eventType) {
    throw AppError.validation([
      { path: 'body.eventType', message: 'Unknown event type for this project' },
    ]);
  }

  // Hash the canonical serialization NOW — jsonb storage normalizes key
  // order, so the stored column can never be the hash source.
  const payloadHash = canonicalPayloadHash(input.payload);

  try {
    // Event insert + eligibility query + delivery creation are ONE
    // transaction (UC-20/NFR-05): an event can never commit without its
    // deliveries, and deliveries can never commit without their event.
    // Postgres-as-queue makes this a plain ACID transaction — no outbox.
    return await prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data: {
          projectId,
          eventTypeId: eventType.id,
          payload: input.payload as Prisma.InputJsonValue,
          payloadHash,
          idempotencyKey,
        },
        select: { id: true, createdAt: true },
      });

      const deliveriesCreated = await fanOutDeliveries(tx, projectId, eventType.id, event.id);

      return {
        kind: 'created' as const,
        event: { id: event.id, eventType: input.eventType, receivedAt: event.createdAt },
        deliveriesCreated,
      };
    });
  } catch (err) {
    if (!isIdempotencyKeyConflict(err)) {
      throw err;
    }
    // This losing transaction rolled back in full; the winner committed with
    // its deliveries. The replay path performs NO fan-out, so idempotent
    // retries can never create additional deliveries.
    return resolveIdempotencyConflict(projectId, idempotencyKey, payloadHash);
  }
}

/**
 * Creates exactly one pending delivery per eligible endpoint (FR-24/31):
 * subscribed to this event type AND is_active AND not soft-deleted.
 * max_attempts is snapshotted per the frozen design: endpoint override when
 * configured, otherwise DELIVERY_MAX_ATTEMPTS_DEFAULT. All other initial
 * state comes from schema defaults: status=pending, attempt_count=0,
 * next_attempt_at=now(); lease, lock, claim token, completed_at and
 * last_error all NULL. The (event_id, endpoint_id) unique constraint is the
 * final duplicate guard beneath the code-level per-endpoint dedupe.
 */
async function fanOutDeliveries(
  tx: Prisma.TransactionClient,
  projectId: string,
  eventTypeId: string,
  eventId: string,
): Promise<number> {
  const subscriptions = await tx.subscription.findMany({
    where: {
      projectId,
      eventTypeId,
      endpoint: { isActive: true, deletedAt: null },
    },
    select: { endpointId: true, endpoint: { select: { maxAttempts: true } } },
  });

  if (subscriptions.length === 0) {
    return 0; // events with no matching subscriptions are still stored (AC-01)
  }

  const attemptBudgetByEndpoint = new Map<string, number>();
  for (const subscription of subscriptions) {
    attemptBudgetByEndpoint.set(
      subscription.endpointId,
      subscription.endpoint.maxAttempts ?? env.DELIVERY_MAX_ATTEMPTS_DEFAULT,
    );
  }

  const result = await tx.delivery.createMany({
    data: [...attemptBudgetByEndpoint.entries()].map(([endpointId, maxAttempts]) => ({
      projectId,
      eventId,
      endpointId,
      maxAttempts,
    })),
  });
  return result.count;
}

/** True only for a P2002 on the (project_id, idempotency_key) constraint. */
function isIdempotencyKeyConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('idempotency'));
}

async function resolveIdempotencyConflict(
  projectId: string,
  idempotencyKey: string,
  incomingPayloadHash: string,
): Promise<IngestResult> {
  const existing = await prisma.event.findUnique({
    where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    select: {
      id: true,
      createdAt: true,
      payloadHash: true,
      eventType: { select: { name: true } },
    },
  });

  if (!existing) {
    // Only reachable if the winning row vanished between the constraint
    // violation and this read — events are never deleted, so this is a
    // genuine invariant breach, not an operational case.
    throw new AppError('Could not resolve idempotency conflict', 500, ErrorCodes.INTERNAL_ERROR, {
      isOperational: false,
    });
  }

  if (existing.payloadHash === incomingPayloadHash) {
    // Scenario 2: identical payload (canonical hash) → replay, no new event.
    return {
      kind: 'replay',
      event: {
        id: existing.id,
        eventType: existing.eventType.name,
        receivedAt: existing.createdAt,
      },
    };
  }

  // Scenario 3: same key, different payload → conflict; existing untouched.
  throw new AppError(
    'Idempotency key was already used with a different payload',
    409,
    ErrorCodes.CONFLICT,
    {
      details: [
        {
          path: 'headers.idempotency-key',
          message:
            'This idempotency key was previously used with a different payload for this project',
        },
      ],
    },
  );
}
