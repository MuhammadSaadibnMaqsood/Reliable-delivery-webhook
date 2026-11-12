/** Stable machine-readable error codes used in API error responses. */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MALFORMED_JSON: 'MALFORMED_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** One entry in an error response's `error.details` array. */
export interface ErrorDetail {
  path?: string;
  message: string;
}

interface AppErrorOptions {
  details?: ErrorDetail[];
  /** false marks programmer errors / unknown failures (always logged loudly). */
  isOperational?: boolean;
  cause?: unknown;
}

/**
 * The application's error type. Anything thrown that is NOT an AppError is
 * treated as an unexpected error by the central handler: logged in full,
 * returned to the client as an opaque 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[];
  readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: ErrorCode, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details ?? [];
    this.isOperational = options.isOperational ?? true;
    Error.captureStackTrace?.(this, AppError);
  }

  static notFound(message: string): AppError {
    return new AppError(message, 404, ErrorCodes.NOT_FOUND);
  }

  /** Deliberately generic: auth failures never explain which part failed. */
  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(message, 401, ErrorCodes.UNAUTHORIZED);
  }

  static forbidden(message = 'Insufficient permissions'): AppError {
    return new AppError(message, 403, ErrorCodes.FORBIDDEN);
  }

  static validation(details: ErrorDetail[]): AppError {
    return new AppError('Request validation failed', 400, ErrorCodes.VALIDATION_ERROR, { details });
  }
}
