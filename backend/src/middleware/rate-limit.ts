import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';

/**
 * Credential-guessing throttle for the auth endpoints.
 * Deliberately in-memory and per-process: no extra infrastructure (per the
 * frozen architecture, no Redis). On multi-instance/serverless deployments
 * this is best-effort per instance — platform-wide rate limiting (FR-55) is
 * a later phase with its own decision.
 */
export const authRateLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(new AppError('Too many attempts, please try again later', 429, ErrorCodes.RATE_LIMITED)),
});
