import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';
import { generateApiKey } from '../utils/api-key.js';
import { getOwnedProject } from './project.service.js';
import type { CreateApiKeyInput } from '../validators/api-key.validators.js';

/**
 * Everything here runs behind JWT auth AND ownership: each entry point first
 * resolves the project through getOwnedProject(ownerId, projectId), which
 * 404s for foreign or soft-deleted projects — so deleted projects can never
 * mint keys, and another user's keys are indistinguishable from absent.
 * The stored key_hash never leaves this module (selects are explicit).
 */

const API_KEY_LIST_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

export async function createApiKey(ownerId: string, projectId: string, input: CreateApiKeyInput) {
  await getOwnedProject(ownerId, projectId);

  // key_prefix is UNIQUE; a 48-bit collision is near-impossible but cheap to
  // absorb — regenerate and retry rather than surfacing a 500.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generated = generateApiKey();
    try {
      const record = await prisma.apiKey.create({
        data: {
          projectId,
          name: input.name,
          keyPrefix: generated.keyPrefix,
          keyHash: generated.keyHash,
        },
        select: { id: true, name: true, keyPrefix: true, createdAt: true },
      });
      // The ONLY place the plaintext ever surfaces.
      return { apiKey: record, plaintextKey: generated.plaintext };
    } catch (err) {
      const isUniqueCollision =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!isUniqueCollision || attempt === 2) throw err;
    }
  }

  throw new AppError('Could not generate API key', 500, ErrorCodes.INTERNAL_ERROR, {
    isOperational: false,
  });
}

export async function listApiKeys(ownerId: string, projectId: string) {
  await getOwnedProject(ownerId, projectId);

  return prisma.apiKey.findMany({
    where: { projectId },
    select: API_KEY_LIST_SELECT,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Idempotent revocation: first call sets revoked_at, repeats return the same
 * terminal state. Keys are never hard-deleted (audit history).
 */
export async function revokeApiKey(ownerId: string, projectId: string, keyId: string) {
  await getOwnedProject(ownerId, projectId);

  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, projectId },
    select: { id: true, revokedAt: true },
  });
  if (!key) {
    throw AppError.notFound('API key not found');
  }

  if (key.revokedAt === null) {
    // Guarded update: a concurrent revoke makes this a no-op, not a clobber.
    await prisma.apiKey.updateMany({
      where: { id: keyId, projectId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  const revoked = await prisma.apiKey.findFirst({
    where: { id: keyId, projectId },
    select: API_KEY_LIST_SELECT,
  });
  if (!revoked) {
    throw AppError.notFound('API key not found');
  }
  return revoked;
}
