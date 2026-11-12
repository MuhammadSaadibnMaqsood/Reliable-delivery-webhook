import { prisma } from '../db/prisma.js';
import { AppError } from '../utils/app-error.js';
import { encryptSecret, generateSigningSecret } from '../utils/crypto.js';
import { validateDestinationUrl } from '../utils/destination-url.js';
import { getOwnedProject } from './project.service.js';
import type {
  RegisterEndpointInput,
  UpdateEndpointInput,
} from '../validators/endpoint.validators.js';

/**
 * Endpoint lifecycle per the frozen design. Every entry point resolves the
 * project through getOwnedProject (foreign/deleted project ⇒ 404), and every
 * endpoint predicate carries { projectId } so cross-project rows are
 * indistinguishable from absent. signing_secret (encrypted) is NEVER in any
 * select — the plaintext leaves exactly once, from registerEndpoint.
 */

const ENDPOINT_SELECT = {
  id: true,
  url: true,
  description: true,
  isActive: true,
  timeoutMs: true,
  maxAttempts: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function assertPublicDestination(url: string): Promise<void> {
  const result = await validateDestinationUrl(url);
  if (!result.valid) {
    throw AppError.validation([{ path: 'body.url', message: result.reason }]);
  }
}

export async function registerEndpoint(
  ownerId: string,
  projectId: string,
  input: RegisterEndpointInput,
) {
  await getOwnedProject(ownerId, projectId);
  await assertPublicDestination(input.url);

  const signingSecret = generateSigningSecret();

  const endpoint = await prisma.endpoint.create({
    data: {
      projectId,
      url: input.url,
      description: input.description ?? null,
      timeoutMs: input.timeoutMs ?? null,
      maxAttempts: input.maxAttempts ?? null,
      signingSecret: encryptSecret(signingSecret),
      // isActive defaults to true in the schema.
    },
    select: ENDPOINT_SELECT,
  });

  // The ONLY place the plaintext signing secret ever surfaces.
  return { endpoint, signingSecret };
}

export async function listEndpoints(ownerId: string, projectId: string) {
  await getOwnedProject(ownerId, projectId);
  return prisma.endpoint.findMany({
    where: { projectId, deletedAt: null },
    select: ENDPOINT_SELECT,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getEndpoint(ownerId: string, projectId: string, endpointId: string) {
  await getOwnedProject(ownerId, projectId);
  const endpoint = await prisma.endpoint.findFirst({
    where: { id: endpointId, projectId, deletedAt: null },
    select: ENDPOINT_SELECT,
  });
  if (!endpoint) {
    throw AppError.notFound('Endpoint not found');
  }
  return endpoint;
}

export async function updateEndpoint(
  ownerId: string,
  projectId: string,
  endpointId: string,
  input: UpdateEndpointInput,
) {
  await getOwnedProject(ownerId, projectId);
  if (input.url !== undefined) {
    await assertPublicDestination(input.url); // every URL change re-validates
  }

  const result = await prisma.endpoint.updateMany({
    where: { id: endpointId, projectId, deletedAt: null },
    data: {
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    },
  });
  if (result.count === 0) {
    throw AppError.notFound('Endpoint not found');
  }
  return getEndpoint(ownerId, projectId, endpointId);
}

/** Activation never touches deliveries and never resurrects deleted endpoints. */
export async function activateEndpoint(ownerId: string, projectId: string, endpointId: string) {
  await getOwnedProject(ownerId, projectId);
  const result = await prisma.endpoint.updateMany({
    where: { id: endpointId, projectId, deletedAt: null },
    data: { isActive: true },
  });
  if (result.count === 0) {
    throw AppError.notFound('Endpoint not found'); // includes soft-deleted
  }
  return getEndpoint(ownerId, projectId, endpointId);
}

export interface EndpointCancellationSummary {
  pendingDeliveriesCancelled: number;
}

/**
 * Approved deactivation rule, atomic: flag flip + pending-delivery
 * cancellation in ONE transaction. processing deliveries are untouched —
 * they may finish their in-flight attempt; the worker's record-time rules
 * and pre-send gate prevent further retries. History is never modified.
 */
export async function deactivateEndpoint(ownerId: string, projectId: string, endpointId: string) {
  await getOwnedProject(ownerId, projectId);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const endpoint = await tx.endpoint.updateMany({
      where: { id: endpointId, projectId, deletedAt: null },
      data: { isActive: false },
    });
    if (endpoint.count === 0) {
      throw AppError.notFound('Endpoint not found');
    }

    const cancelled = await tx.delivery.updateMany({
      where: { endpointId, status: 'pending' },
      data: { status: 'cancelled', completedAt: now, lastError: 'cancelled: endpoint deactivated' },
    });

    const updated = await tx.endpoint.findFirst({
      where: { id: endpointId, projectId },
      select: ENDPOINT_SELECT,
    });
    return { endpoint: updated, pendingDeliveriesCancelled: cancelled.count };
  });
}

/**
 * Approved soft deletion: deleted_at + is_active=false + pending cancellation,
 * one transaction. Endpoint row and all history survive (FR-47..49).
 */
export async function softDeleteEndpoint(ownerId: string, projectId: string, endpointId: string) {
  await getOwnedProject(ownerId, projectId);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const endpoint = await tx.endpoint.updateMany({
      where: { id: endpointId, projectId, deletedAt: null },
      data: { deletedAt: now, isActive: false },
    });
    if (endpoint.count === 0) {
      throw AppError.notFound('Endpoint not found');
    }

    const cancelled = await tx.delivery.updateMany({
      where: { endpointId, status: 'pending' },
      data: { status: 'cancelled', completedAt: now, lastError: 'cancelled: endpoint deleted' },
    });

    return { pendingDeliveriesCancelled: cancelled.count };
  });
}
