import type { ErrorCode, ErrorDetail } from '../utils/app-error.js';

/** Envelope for every successful response. */
export interface ApiSuccess<T> {
  success: true;
  message: string;
  data: T;
}

export interface ApiErrorPayload {
  code: ErrorCode;
  details: ErrorDetail[];
  /** Present only outside production, and only for 5xx responses. */
  debug?: {
    message: string;
    stack?: string;
  };
}

/** Envelope for every error response. */
export interface ApiError {
  success: false;
  message: string;
  error: ApiErrorPayload;
}
