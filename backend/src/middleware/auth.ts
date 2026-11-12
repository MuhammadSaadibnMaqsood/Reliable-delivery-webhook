import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { AuthenticatedUser } from '../types/auth.js';
import { AppError } from '../utils/app-error.js';
import { verifyAccessToken } from '../utils/jwt.js';

/**
 * Authentication: Bearer token → verified claims → CURRENT user from the
 * database. Role and status are read fresh per request (never trusted from
 * the token or any client-supplied field), so disabling a user or changing
 * a role takes effect immediately. All failures are a uniform 401.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    next(AppError.unauthorized());
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  const payload = token.length > 0 ? verifyAccessToken(token) : null;
  if (!payload) {
    next(AppError.unauthorized());
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, name: true, role: true, status: true },
  });

  if (!user || user.status !== 'active') {
    next(AppError.unauthorized());
    return;
  }

  req.user = user;
  next();
}

/**
 * Role-based authorization (FR-05). Mount AFTER requireAuth, e.g.
 * router.get('/admin-thing', requireAuth, requireRole('admin'), handler).
 * No admin routes exist yet in this phase; this is the reusable guard.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(AppError.forbidden());
      return;
    }
    next();
  };
}

/** Typed accessor for handlers behind requireAuth (narrows the optional away). */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw AppError.unauthorized();
  }
  return req.user;
}
