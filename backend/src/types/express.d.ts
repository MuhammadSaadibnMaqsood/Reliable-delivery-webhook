/**
 * Express request augmentation: the validation middleware stores parsed,
 * typed input here. (In Express 5, req.query is a read-only getter, so
 * validated values are never written back onto the native properties
 * except req.body.)
 */
declare global {
  namespace Express {
    interface Request {
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
