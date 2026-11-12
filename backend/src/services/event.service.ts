import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';
import { canonicalPayloadHash } from '../utils/canonical-json.js';
import type { IngestEventInput } from '../validators/event.validators.js';

/**
 * Event ingestion (UC-20, Phase 5A.1 scope: validate + persist).
 * projectId comes exclusively from the authenticated API key context —
 * never from the client. Delivery fan-out and the full idempotency
 * duplicate semantics (identical-payload replay vs 409 mismatch via
 * payload_hash) are Phase 5A.2.
 */
export async function ingestEvent(
  projectId: string,
  input: IngestEventInput,
  idempotencyKey: string,
) {
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
    return { id: event.id, eventType: input.eventType, receivedAt: event.createdAt };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Defensive placeholder: the DB constraint fires on reused keys today.
      // Phase 5A.2 replaces this with the approved UC-20 semantics
      // (identical payload → replay original response; different → 409).
      throw new AppError(
        'Idempotency key already used for this project',
        409,
        ErrorCodes.CONFLICT,
      );
    }
    throw err;
  }
}
