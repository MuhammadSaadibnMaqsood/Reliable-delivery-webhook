import cors from 'cors';
import express from 'express';
import { corsOrigins, isDevelopment } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { authRouter } from './routes/auth.routes.js';
import { devRouter } from './routes/dev.routes.js';
import { eventRouter } from './routes/event.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { projectRouter } from './routes/project.routes.js';

/**
 * Builds the Express application: middleware chain, routes, terminal handlers.
 * Deliberately separate from server startup (server.ts) so the app can later
 * be exercised in-process (tests) or behind a different runtime.
 *
 * Request lifecycle:
 *   request-id + logging → CORS → JSON parsing (1 MB cap) → route
 *   → 404 (no match) → central error handler (everything thrown)
 */
export function buildApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(requestLogger);
  app.use(cors({ origin: corsOrigins === '*' ? true : corsOrigins }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/health', healthRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/projects', projectRouter);
  app.use('/api/v1/events', eventRouter);

  if (isDevelopment) {
    app.use('/__dev', devRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
