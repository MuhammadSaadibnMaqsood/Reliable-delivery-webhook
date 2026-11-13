import { Router } from 'express';
import { workerTickHandler } from '../controllers/worker.controller.js';
import { requireWorkerTriggerSecret } from '../middleware/worker-trigger-auth.js';

/**
 * Internal, scheduler-facing surface (mounted at /internal/worker).
 * Only POST /tick exists; any other method or path falls through to the
 * global 404 handler.
 */
export const workerRouter: Router = Router();

workerRouter.post('/tick', requireWorkerTriggerSecret, workerTickHandler);
