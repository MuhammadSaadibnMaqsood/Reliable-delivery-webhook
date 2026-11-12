import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError, type ErrorDetail } from '../utils/app-error.js';

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  headers?: ZodType;
}

const SEGMENTS = ['body', 'query', 'params', 'headers'] as const;

/**
 * Zod-based request validation. All requested segments are validated so a
 * single response reports every problem, not just the first segment's.
 *
 * Parsed (and transformed) values are stored on req.validated; req.body is
 * additionally replaced with its parsed value. req.query/req.params are left
 * untouched because Express 5 exposes them as read-only getters, and
 * req.headers is never replaced — handlers read validated input from
 * req.validated.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const details: ErrorDetail[] = [];
    const validated: NonNullable<Request['validated']> = {};

    for (const segment of SEGMENTS) {
      const schema = schemas[segment];
      if (!schema) continue;

      const result = schema.safeParse(req[segment]);
      if (result.success) {
        validated[segment] = result.data;
      } else {
        details.push(
          ...result.error.issues.map((issue) => ({
            path:
              issue.path.length > 0
                ? `${segment}.${issue.path.map(String).join('.')}`
                : segment,
            message: issue.message,
          })),
        );
      }
    }

    if (details.length > 0) {
      next(AppError.validation(details));
      return;
    }

    req.validated = validated;
    if (validated.body !== undefined) {
      req.body = validated.body;
    }
    next();
  };
}
