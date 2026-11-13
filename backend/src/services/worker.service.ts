import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { executeClaimedDelivery, type ExecutionOutcome } from './delivery-executor.service.js';
import {
  claimDueDeliveries,
  extendLease,
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

      // Sequential on purpose (NFR-04 bounded batches, no parallelism).
      //
      // Lease discipline: claiming leases the WHOLE batch at claim time, but
      // execution drains serially — so a later item's lease would otherwise
      // tick away while it waits its turn, and under a frequent scheduler a
      // competing tick would legitimately reclaim it, guaranteeing a
      // duplicate HTTP send. Renewing the lease (CAS on the fencing token)
      // immediately before EACH item fixes that: the lease now only ever
      // needs to cover ONE in-flight attempt (env enforces
      // WORKER_LEASE_MS > the 30 s endpoint timeout cap), and a renewal
      // that returns false means the claim was already lost — the item is
      // skipped WITHOUT sending, which strictly reduces duplicates.
      const outcomes: Record<string, ExecutionOutcome> = {};
      for (const claim of claimed) {
        const stillOwned = await extendLease(
          { deliveryId: claim.id, claimToken: claim.claimToken },
          leaseMs,
        );
        if (!stillOwned) {
          outcomes[claim.id] = 'stale'; // lost while queued: write and send nothing
          continue;
        }
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
