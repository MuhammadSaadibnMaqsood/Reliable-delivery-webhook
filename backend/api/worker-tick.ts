import express from 'express';
import { errorHandler, notFoundHandler } from '../src/middleware/error-handler.js';
import { requestLogger } from '../src/middleware/request-logger.js';
import { workerRouter } from '../src/routes/worker.routes.js';

/**
 * Vercel Function: the worker trigger ONLY, split out so vercel.json can
 * grant it maxDuration 300 s (Hobby supports this with Fluid Compute)
 * without widening any user-facing function's budget.
 *
 * It reuses the existing router and middleware wholesale — same secret
 * auth, same runTick, same error envelope; no duplicated worker logic.
 * Tick arithmetic: WORKER_BATCH_SIZE (4) × worst-case attempt
 * (30 s timeout cap + overhead) ≈ 130 s, comfortably inside 300 s, while
 * per-item lease renewal keeps every claim's 60 s lease valid throughout.
 */
const app = express();
app.disable('x-powered-by');
app.use(requestLogger);
app.use('/internal/worker', workerRouter);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
