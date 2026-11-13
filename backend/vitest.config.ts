import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Vitest defaults NODE_ENV to 'test' (and dotenv never overrides existing
    // vars), but the suite exercises development-gated behavior (the
    // /__dev/apikey-probe stand-in for Phase-5 ingestion). Pin it explicitly;
    // keep logs at warn so request spam stays out of test output.
    env: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      // Delivery-path dev escape hatch so executor tests can hit local mock
      // receivers; registration-time validation ignores it by design, and
      // production boot refuses it.
      DESTINATION_ALLOW_PRIVATE: 'true',
    },
    // Integration tests share one real (Neon) database — run files sequentially
    // to keep connection counts low and rate-limiter state per file.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
