import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config/env.js';
import type { ApiError } from '../types/api.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';
import { buildErrorBody } from '../utils/api-response.js';
import { logger } from '../utils/logger.js';

/** Terminal 404 for anything no route matched. Runs after all routes, before the error handler. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

/** Shape of body-parser failures surfaced by express.json(). */
interface BodyParserError extends Error {
  type?: string;
  statusCode?: number;
}

function isBodyParserError(err: unknown, type: string): err is BodyParserError {
  return err instanceof Error && (err as BodyParserError).type === type;
}

/** Normalize anything thrown anywhere into an AppError. */
function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return AppError.validation(
      err.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }

  if (isBodyParserError(err, 'entity.parse.failed')) {
    return new AppError('Request body is not valid JSON', 400, ErrorCodes.MALFORMED_JSON);
  }

  if (isBodyParserError(err, 'entity.too.large')) {
    return new AppError('Request body too large', 413, ErrorCodes.PAYLOAD_TOO_LARGE);
  }

  // Unexpected error (including database errors): opaque to the client.
  // Internals — Prisma messages, stack traces, connection details — are
  // logged server-side only and never serialized into the response.
  return new AppError('Something went wrong', 500, ErrorCodes.INTERNAL_ERROR, {
    isOperational: false,
    cause: err,
  });
}

/**
 * Central Express error handler: every error funnels here and leaves as the
 * standard error envelope. Must stay the LAST middleware.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError = toAppError(err);

  const log = req.log ?? logger;
  if (appError.statusCode >= 500 || !appError.isOperational) {
    log.error({ err: appError.cause ?? appError }, appError.message);
  }

  if (res.headersSent) {
    // Response already streaming; nothing safe left to send.
    res.end();
    return;
  }

  const body: ApiError = buildErrorBody(appError.message, appError.code, appError.details);

  // Development aid only: never in production, never for 4xx.
  if (!isProduction && appError.statusCode >= 500) {
    const cause = appError.cause instanceof Error ? appError.cause : undefined;
    body.error.debug = {
      message: cause?.message ?? appError.message,
      ...(cause?.stack ?? appError.stack ? { stack: cause?.stack ?? appError.stack } : {}),
    };
  }

  res.status(appError.statusCode).json(body);
}
