import type { UserRole, UserStatus } from '@prisma/client';

/**
 * The authenticated principal attached to req.user by requireAuth.
 * Always loaded fresh from the database per request — role/status are never
 * trusted from the token, so revocations and role changes apply immediately.
 * Never includes passwordHash.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
}

/** Verified JWT claims the application relies on. */
export interface AccessTokenPayload {
  sub: string;
}
