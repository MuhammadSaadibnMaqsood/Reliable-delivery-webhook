import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';

/**
 * Scheduler authentication for /internal/worker/tick: a dedicated shared
 * secret in the X-Worker-Secret header (its own credential and its own
 * middleware — this is machine-to-machine, not a user JWT and not a
 * project API key).
 *
 * Both sides are SHA-256-digested before timingSafeEqual: the comparison is
 * constant-time AND length-independent (timingSafeEqual itself throws on
 * unequal lengths, which would leak the secret's length). The header is in
 * the request logger's redaction list, and this module never logs it.
 */

export const WORKER_TRIGGER_HEADER = 'x-worker-secret';

const EXPECTED_DIGEST = createHash('sha256').update(env.WORKER_TRIGGER_SECRET, 'utf8').digest();

export function requireWorkerTriggerSecret(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const presented = req.headers[WORKER_TRIGGER_HEADER];
  if (typeof presented !== 'string' || presented.length === 0) {
    next(AppError.unauthorized('Worker trigger secret required'));
    return;
  }

  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest();
  if (!timingSafeEqual(presentedDigest, EXPECTED_DIGEST)) {
    next(AppError.unauthorized('Invalid worker trigger secret'));
    return;
  }

  next();
}
