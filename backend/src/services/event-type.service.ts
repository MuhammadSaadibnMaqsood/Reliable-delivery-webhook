import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';
import { getOwnedProject } from './project.service.js';
import type { CreateEventTypeInput } from '../validators/event-type.validators.js';

const EVENT_TYPE_SELECT = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
} as const;

export async function createEventType(
  ownerId: string,
  projectId: string,
  input: CreateEventTypeInput,
) {
  await getOwnedProject(ownerId, projectId);

  try {
    // Per-project uniqueness enforced by the (project_id, name) constraint.
    return await prisma.eventType.create({
      data: { projectId, name: input.name, description: input.description ?? null },
      select: EVENT_TYPE_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('Event type already exists in this project', 409, ErrorCodes.CONFLICT);
    }
    throw err;
  }
}

export async function listEventTypes(ownerId: string, projectId: string) {
  await getOwnedProject(ownerId, projectId);
  return prisma.eventType.findMany({
    where: { projectId },
    select: EVENT_TYPE_SELECT,
    orderBy: { name: 'asc' },
  });
}

/**
 * Hard delete is allowed ONLY for unused registry rows. Anything referenced
 * by history (events) or configuration (subscriptions) returns 409 — the
 * RESTRICT foreign keys enforce the same rule at the database layer, and the
 * P2003 catch covers the create-reference-while-deleting race.
 */
export async function deleteEventType(ownerId: string, projectId: string, eventTypeId: string) {
  await getOwnedProject(ownerId, projectId);

  const eventType = await prisma.eventType.findFirst({
    where: { id: eventTypeId, projectId },
    select: { id: true },
  });
  if (!eventType) {
    throw AppError.notFound('Event type not found');
  }

  const [eventCount, subscriptionCount] = await prisma.$transaction([
    prisma.event.count({ where: { eventTypeId } }),
    prisma.subscription.count({ where: { eventTypeId } }),
  ]);
  if (eventCount > 0 || subscriptionCount > 0) {
    throw new AppError('Event type is in use and cannot be deleted', 409, ErrorCodes.CONFLICT, {
      details: [
        { path: 'events', message: `${eventCount} historical event(s) reference it` },
        { path: 'subscriptions', message: `${subscriptionCount} subscription(s) reference it` },
      ],
    });
  }

  try {
    await prisma.eventType.delete({ where: { id: eventTypeId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw new AppError('Event type is in use and cannot be deleted', 409, ErrorCodes.CONFLICT);
    }
    throw err;
  }
}
