import type { Response } from 'express';
import type { ApiError, ApiSuccess } from '../types/api.js';
import type { ErrorCode, ErrorDetail } from './app-error.js';

/** Send the standard success envelope. */
export function sendSuccess<T>(
  res: Response,
  options: { data: T; message?: string; statusCode?: number },
): void {
  const body: ApiSuccess<T> = {
    success: true,
    message: options.message ?? 'Operation successful',
    data: options.data,
  };
  res.status(options.statusCode ?? 200).json(body);
}

/** Build the standard error envelope (shared by sendError and the central handler). */
export function buildErrorBody(
  message: string,
  code: ErrorCode,
  details: ErrorDetail[] = [],
): ApiError {
  return { success: false, message, error: { code, details } };
}

/** Send the standard error envelope (for handlers that report, rather than throw, errors). */
export function sendError(
  res: Response,
  options: { statusCode: number; message: string; code: ErrorCode; details?: ErrorDetail[] },
): void {
  res.status(options.statusCode).json(buildErrorBody(options.message, options.code, options.details));
}
