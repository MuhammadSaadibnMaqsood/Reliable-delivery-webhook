import { disconnectDatabase } from './db/prisma.js';
import { createWorker } from './services/worker.service.js';
import { logger } from './utils/logger.js';

/**
 * Worker execution entry point — ONE bounded tick, then exit (NFR-36).
 * This is the unit a scheduler invokes: an external cron hitting a thin
 * trigger, a serverless scheduled function, or (later, NFR-25) a persistent
 * process looping over it. Usage:
 *
 *   npm run worker:tick        (built)
 *   npm run worker:tick:dev    (tsx, local development)
 *
 * Exit code 0 on a completed tick (whatever the per-delivery outcomes were),
 * 1 on an unexpected tick-level failure.
 */
async function main(): Promise<void> {
  const worker = createWorker();
  try {
    const result = await worker.runTick();
    logger.info(
      {
        workerId: result.workerId,
        swept: result.swept,
        claimed: result.claimed.length,
        outcomes: result.outcomes,
      },
      'Worker tick finished',
    );
  } catch (err) {
    logger.error({ err }, 'Worker tick failed');
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

void main();
