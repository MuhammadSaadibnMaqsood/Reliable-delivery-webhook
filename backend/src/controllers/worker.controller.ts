import type { Request, Response } from 'express';
import type { ExecutionOutcome } from '../services/delivery-executor.service.js';
import { createWorker } from '../services/worker.service.js';
import { sendSuccess } from '../utils/api-response.js';

/**
 * POST /internal/worker/tick — runs ONE bounded tick via the existing
 * worker service (no duplicated logic). Overlapping triggers are safe by
 * design: SKIP LOCKED claiming and lease fencing already partition work
 * between concurrent ticks.
 *
 * The response is a minimal operational summary: counts only — no delivery
 * ids, no endpoint URLs, no payloads, no errors beyond category counts.
 */
export async function workerTickHandler(_req: Request, res: Response): Promise<void> {
  const result = await createWorker().runTick();

  const outcomes: Partial<Record<ExecutionOutcome, number>> = {};
  for (const outcome of Object.values(result.outcomes)) {
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }

  sendSuccess(res, {
    message: 'Worker tick completed',
    data: {
      workerId: result.workerId,
      swept: result.swept,
      claimed: result.claimed.length,
      outcomes,
    },
  });
}
