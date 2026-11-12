import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db/prisma.js';
import {
  API_KEY_HEADER,
  apiKeyHashesEqual,
  extractKeyPrefix,
  hashApiKey,
} from '../utils/api-key.js';
import { AppError } from '../utils/app-error.js';
import { logger } from '../utils/logger.js';

/**
 * Developer API-key authentication (X-API-Key) — deliberately SEPARATE from
 * the JWT middleware: this authenticates an external application as a
 * project, not a dashboard user as a person.
 *
 * Project identity comes ONLY from the key record — nothing client-supplied
 * is trusted. Every failure (malformed, unknown prefix, wrong secret,
 * revoked, project deleted) returns the same generic 401, so responses never
 * reveal whether a prefix exists or why a key stopped working.
 */

// Compared against when the prefix has no record, so unknown-prefix and
// wrong-secret take the same code path (no existence oracle via timing).
const DUMMY_HASH = hashApiKey('dummy-comparison-target');

const invalidKey = (): AppError => AppError.unauthorized('Invalid API key');

export async function requireApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers[API_KEY_HEADER];
  const presented = typeof header === 'string' ? header.trim() : '';
  if (presented.length === 0) {
    next(AppError.unauthorized('API key required'));
    return;
  }

  const keyPrefix = extractKeyPrefix(presented);
  if (!keyPrefix) {
    next(invalidKey());
    return;
  }

  const record = await prisma.apiKey.findUnique({
    where: { keyPrefix },
    select: {
      id: true,
      keyHash: true,
      revokedAt: true,
      lastUsedAt: true,
      projectId: true,
      project: { select: { deletedAt: true } },
    },
  });

  const presentedHash = hashApiKey(presented);
  const hashMatches = record
    ? apiKeyHashesEqual(presentedHash, record.keyHash)
    : apiKeyHashesEqual(presentedHash, DUMMY_HASH) && false;

  if (!record || !hashMatches || record.revokedAt !== null || record.project.deletedAt !== null) {
    next(invalidKey());
    return;
  }

  req.apiKey = { id: record.id, projectId: record.projectId };
  touchLastUsed(record.id, record.lastUsedAt);
  next();
}

/**
 * last_used_at is observability, not authentication state: update at most
 * once per minute, fire-and-forget, so the hot path never waits on it.
 */
const LAST_USED_THROTTLE_MS = 60_000;

function touchLastUsed(apiKeyId: string, lastUsedAt: Date | null): void {
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_THROTTLE_MS) {
    return;
  }
  void prisma.apiKey
    .update({ where: { id: apiKeyId }, data: { lastUsedAt: new Date() } })
    .catch((err: unknown) => logger.warn({ err, apiKeyId }, 'Failed to update api key last_used_at'));
}
