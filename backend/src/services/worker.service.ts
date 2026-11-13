import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { executeClaimedDelivery, type ExecutionOutcome } from './delivery-executor.service.js';
import {
  claimDueDeliveries,
  sweepExhaustedExpiredLeases,
  type ClaimedDelivery,
} from './delivery-queue.service.js';

/**
 * Delivery worker — one bounded processing tick (NFR-36: scheduled, bounded
 * executions; NFR-25: pure logic, independent of how it is triggered, so the
 * same worker runs under a serverless tick today or a persistent process
 * later): sweep → claim → execute each claim (signed, pinned HTTP POST) →
 * record results under the fencing token.
 */

export interface WorkerOptions {
  batchSize?: number;
  leaseMs?: number;
}

export interface WorkerTickResult {
  workerId: string;
  /** Exhausted expired-lease deliveries moved to dead_lettered before claiming. */
  swept: number;
  claimed: ClaimedDelivery[];
  /** Execution outcome per claimed delivery id. */
  outcomes: Record<string, ExecutionOutcome>;
}

export interface DeliveryWorker {
  readonly workerId: string;
  runTick(): Promise<WorkerTickResult>;
}

/** Unique per worker instance: host + pid + random suffix. */
function generateWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

export function createWorker(options: WorkerOptions = {}): DeliveryWorker {
  const workerId = generateWorkerId();
  const batchSize = options.batchSize ?? env.WORKER_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? env.WORKER_LEASE_MS;

  return {
    workerId,

    async runTick(): Promise<WorkerTickResult> {
      const swept = await sweepExhaustedExpiredLeases();
      if (swept > 0) {
        logger.warn({ workerId, swept }, 'Dead-lettered exhausted expired-lease deliveries');
      }

      const claimed = await claimDueDeliveries(workerId, batchSize, leaseMs);

      // Sequential on purpose: the batch is already bounded (NFR-04), and
      // serial execution keeps per-attempt timeouts comfortably inside the
      // lease. executeClaimedDelivery never throws.
      const outcomes: Record<string, ExecutionOutcome> = {};
      for (const claim of claimed) {
        outcomes[claim.id] = await executeClaimedDelivery(claim);
      }

      logger.info(
        { workerId, swept, claimed: claimed.length, outcomes },
        'Worker tick complete',
      );
      return { workerId, swept, claimed, outcomes };
    },
  };
}
