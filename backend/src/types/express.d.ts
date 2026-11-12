import type { AuthenticatedUser } from './auth.js';

/**
 * Express request augmentation.
 * - validated: parsed, typed input stored by the validation middleware.
 *   (In Express 5, req.query is a read-only getter, so validated values are
 *   never written back onto the native properties except req.body.)
 * - user: authenticated principal set by requireAuth.
 */
declare global {
  namespace Express {
    interface Request {
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
      user?: AuthenticatedUser;
      /** Set by requireApiKey: the authenticated key and ITS project (never client-claimed). */
      apiKey?: {
        id: string;
        projectId: string;
      };
    }
  }
}

export {};
