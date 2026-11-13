import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration (NFR-24): parsed and validated once at startup.
 * The process refuses to boot with an invalid configuration, and validation
 * failures never echo variable VALUES (they may contain credentials) — only
 * variable names and what is wrong with them.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  // --- Authentication (secrets never logged; validation errors never echo values) ---
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters of random data'),
  JWT_EXPIRES_IN: z
    .string()
    .regex(/^\d+(ms|s|m|h|d)$/, 'must look like 900s, 15m, 12h or 1d')
    .default('1d'),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(900_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  // AES-256-GCM key for signing secrets at rest. Dedicated key: never the
  // JWT secret, never an API key hash. Boot fails rather than storing plaintext.
  SECRET_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters (a 32-byte AES-256 key)'),
  // PROVISIONAL platform default for a delivery's attempt budget, snapshotted
  // onto each delivery at fan-out when the endpoint has no override
  // (max_attempts). Final value is a pending Phase-0 retry-policy decision.
  DELIVERY_MAX_ATTEMPTS_DEFAULT: z.coerce.number().int().min(1).max(20).default(5),
  // Worker tick bounds (NFR-04: bounded batches within serverless limits).
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  // Claim lease duration; must stay comfortably above the endpoint timeout
  // cap (30 s) so expiry means "worker is gone", not "request is slow".
  WORKER_LEASE_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
  // Per-attempt HTTP timeout when the endpoint has no timeout_ms override.
  DELIVERY_TIMEOUT_MS_DEFAULT: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  // DEV-ONLY escape hatch: lets the DELIVERY path dispatch to private/HTTP
  // destinations (local receivers, integration tests). Registration-time
  // validation NEVER honors it, and production boot refuses it outright.
  DESTINATION_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // eslint-disable-next-line no-console -- logger cannot exist before config does
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}

export const env = parsed.data;

if (env.NODE_ENV === 'production' && env.DESTINATION_ALLOW_PRIVATE) {
  // eslint-disable-next-line no-console -- logger cannot exist before config does
  console.error('DESTINATION_ALLOW_PRIVATE must never be enabled in production. Refusing to start.');
  process.exit(1);
}

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';

/** Parsed CORS allow-list: '*' means reflect any origin. */
export const corsOrigins: '*' | string[] =
  env.CORS_ORIGINS.trim() === '*'
    ? '*'
    : env.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
