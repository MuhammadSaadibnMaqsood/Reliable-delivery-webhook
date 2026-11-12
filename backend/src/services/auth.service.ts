import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { AppError, ErrorCodes } from '../utils/app-error.js';
import { signAccessToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import type { LoginInput, RegisterInput } from '../validators/auth.validators.js';

/** The only user shape that ever leaves the service layer — no passwordHash, ever. */
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
} as const;

export async function registerUser(input: RegisterInput) {
  const passwordHash = await hashPassword(input.password);

  try {
    // Uniqueness is enforced by the DB constraint, not check-then-insert:
    // concurrent duplicate registrations are race-safe by construction.
    return await prisma.user.create({
      data: { name: input.name, email: input.email, passwordHash },
      select: SAFE_USER_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('Email is already registered', 409, ErrorCodes.CONFLICT);
    }
    throw err;
  }
}

// Verifying unknown emails against this dummy hash keeps "no such account"
// and "wrong password" time-equivalent — no account enumeration via timing.
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomUUID());
  return dummyHashPromise;
}

export async function loginUser(input: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  if (!user) {
    await verifyPassword(await getDummyHash(), input.password);
    throw AppError.unauthorized('Invalid email or password');
  }

  const passwordValid = await verifyPassword(user.passwordHash, input.password);
  if (!passwordValid) {
    throw AppError.unauthorized('Invalid email or password');
  }

  // Only revealed AFTER the password proved correct — no enumeration leak.
  if (user.status !== 'active') {
    throw AppError.forbidden('Account is disabled');
  }

  return {
    token: signAccessToken(user.id),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
    },
  };
}
