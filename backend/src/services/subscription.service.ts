import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';
import { getOwnedProject } from './project.service.js';
import type { CreateSubscriptionInput } from '../validators/subscription.validators.js';

/**
 * Subscriptions are pure fan-out configuration (frozen design): creating one
 * affects FUTURE events only, and removing one never touches existing
 * deliveries or history. Cross-project pairings are rejected here with
 * indistinguishable 404s AND made unrepresentable by the composite FKs.
 */

const SUBSCRIPTION_SELECT = {
  id: true,
  endpointId: true,
  createdAt: true,
  eventType: { select: { id: true, name: true, description: true } },
} as const;

async function getLiveEndpoint(projectId: string, endpointId: string) {
  const endpoint = await prisma.endpoint.findFirst({
    where: { id: endpointId, projectId, deletedAt: null },
    select: { id: true, isActive: true },
  });
  if (!endpoint) {
    throw AppError.notFound('Endpoint not found');
  }
  return endpoint;
}

export async function createSubscription(
  ownerId: string,
  projectId: string,
  endpointId: string,
  input: CreateSubscriptionInput,
) {
  await getOwnedProject(ownerId, projectId);

  const endpoint = await getLiveEndpoint(projectId, endpointId);
  if (!endpoint.isActive) {
    throw new AppError('Endpoint is not active', 409, ErrorCodes.CONFLICT);
  }

  // Same-project check: a foreign event type is indistinguishable from absent.
  const eventType = await prisma.eventType.findFirst({
    where: { id: input.eventTypeId, projectId },
    select: { id: true },
  });
  if (!eventType) {
    throw AppError.notFound('Event type not found');
  }

  try {
    return await prisma.subscription.create({
      data: { projectId, endpointId, eventTypeId: input.eventTypeId },
      select: SUBSCRIPTION_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(
        'Endpoint is already subscribed to this event type',
        409,
        ErrorCodes.CONFLICT,
      );
    }
    throw err;
  }
}

export async function listSubscriptions(ownerId: string, projectId: string, endpointId: string) {
  await getOwnedProject(ownerId, projectId);
  await getLiveEndpoint(projectId, endpointId);

  return prisma.subscription.findMany({
    where: { endpointId, projectId },
    select: SUBSCRIPTION_SELECT,
    orderBy: { createdAt: 'asc' },
  });
}

/** Removes configuration only — historical deliveries are deliberately untouched. */
export async function deleteSubscription(
  ownerId: string,
  projectId: string,
  endpointId: string,
  subscriptionId: string,
) {
  await getOwnedProject(ownerId, projectId);

  const result = await prisma.subscription.deleteMany({
    where: { id: subscriptionId, endpointId, projectId },
  });
  if (result.count === 0) {
    throw AppError.notFound('Subscription not found');
  }
}
