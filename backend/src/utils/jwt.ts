import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { AccessTokenPayload } from '../types/auth.js';

/**
 * Access-token helpers — the only module that touches JWT_SECRET.
 * HS256 is pinned on sign AND verify (no algorithm-confusion downgrades),
 * and the secret itself is never logged or serialized anywhere.
 */

const payloadSchema = z.object({ sub: z.uuid() });

export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_SECRET, {
    subject: userId,
    algorithm: 'HS256',
    // Format is enforced by the env schema (e.g. 900s / 15m / 12h / 1d).
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  });
}

/**
 * Returns verified claims, or null for ANY failure (bad signature, expired,
 * malformed payload). Callers treat null as a generic 401 — never a reason.
 */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    const parsed = payloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
