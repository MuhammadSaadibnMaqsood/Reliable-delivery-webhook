import { Prisma } from '@prisma/client';
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
  | { kind: 'created'; event: IngestedEvent }
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
    const event = await prisma.event.create({
      data: {
        projectId,
        eventTypeId: eventType.id,
        payload: input.payload as Prisma.InputJsonValue,
        payloadHash,
        idempotencyKey,
      },
      select: { id: true, createdAt: true },
    });
    return {
      kind: 'created',
      event: { id: event.id, eventType: input.eventType, receivedAt: event.createdAt },
    };
  } catch (err) {
    if (!isIdempotencyKeyConflict(err)) {
      throw err;
    }
    return resolveIdempotencyConflict(projectId, idempotencyKey, payloadHash);
  }
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
