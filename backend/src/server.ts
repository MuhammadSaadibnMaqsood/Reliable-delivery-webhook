import http from 'node:http';
import { buildApp } from './app.js';
import { env, isProduction } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db/prisma.js';
import { logger } from './utils/logger.js';

/**
 * Server entry point: owns process lifecycle (startup, signals, shutdown).
 * Application wiring lives in app.ts; this file only starts and stops it.
 */
async function main(): Promise<void> {
  try {
    await connectDatabase();
    logger.info('Database connection established');
  } catch (err) {
    // Fail fast in production; in development keep serving so /health can
    // report the degraded state while the developer fixes the database.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Database connection failed at startup',
    );
    if (isProduction) {
      process.exit(1);
    }
    logger.warn('Continuing without database (development only) — /health will report degraded');
  }

  const app = buildApp();
  const server = http.createServer(app);

  server.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  let shuttingDown = false;

  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down gracefully');

    // Hard deadline: never hang forever on stuck connections.
    const forceTimer = setTimeout(() => {
      logger.error('Shutdown grace period exceeded — forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    server.close((closeErr) => {
      void (async () => {
        if (closeErr) {
          logger.error({ err: closeErr }, 'Error while closing HTTP server');
        }
        await disconnectDatabase().catch((err: unknown) =>
          logger.error({ err }, 'Error during database disconnect'),
        );
        logger.info('Shutdown complete');
        process.exit(exitCode);
      })();
    });
  }

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

void main();
