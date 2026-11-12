import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Centralized Prisma client — the ONLY place a PrismaClient is constructed.
 * Every module imports { prisma } from here; constructing additional clients
 * multiplies connection pools, which the pooled serverless setup cannot afford.
 *
 * Prisma reads DATABASE_URL (pooled, runtime) from the environment via
 * schema.prisma; DIRECT_URL is used exclusively by Prisma Migrate.
 */
function createPrismaClient() {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  // Route Prisma's own warnings/errors through the structured logger.
  // Never log query events: query parameters could contain payload data (NFR-16).
  client.$on('warn', (event) => logger.warn({ prisma: true }, event.message));
  client.$on('error', (event) => logger.error({ prisma: true }, event.message));

  return client;
}

type AppPrismaClient = ReturnType<typeof createPrismaClient>;

// Survive dev-server hot reloads (tsx watch) without leaking clients.
const globalForPrisma = globalThis as unknown as { __webhookPrisma?: AppPrismaClient };

export const prisma: AppPrismaClient = globalForPrisma.__webhookPrisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.__webhookPrisma = prisma;
}

/** Explicitly open the connection pool (otherwise Prisma connects lazily on first query). */
export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Lightweight connectivity probe for the health endpoint (NFR-29).
 * Never throws; bounded so a black-holed connection cannot stall /health.
 */
export async function isDatabaseReachable(timeoutMs = 2_000): Promise<boolean> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Database probe timed out')), timeoutMs);
        timer.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}
