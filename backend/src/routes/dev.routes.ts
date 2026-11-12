import { Router } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/api-key-auth.js';
import { validate } from '../middleware/validate.js';
import { sendSuccess } from '../utils/api-response.js';

/**
 * Development-only verification routes — mounted ONLY when
 * NODE_ENV=development (see app.ts). They exist so this phase's middleware
 * (Zod validation, centralized error handling) can be exercised end-to-end
 * before any business routes exist; Phase 3+ routes supersede them.
 * They are NOT part of the API surface and never run in production.
 */
export const devRouter: Router = Router();

const validationDemoSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().positive(),
});

devRouter.post('/validation-demo', validate({ body: validationDemoSchema }), (req, res) => {
  sendSuccess(res, { message: 'Validation passed', data: req.validated?.body ?? null });
});

devRouter.get('/boom', async () => {
  // Express 5 forwards rejected promises to the central error handler.
  throw new Error('Simulated unexpected failure (dev-only route)');
});

// Stand-in for the Phase-5 ingestion endpoints: proves X-API-Key auth
// end-to-end (the attached project identity comes from the key record only).
devRouter.get('/apikey-probe', requireApiKey, (req, res) => {
  sendSuccess(res, {
    message: 'API key accepted',
    data: { projectId: req.apiKey?.projectId, apiKeyId: req.apiKey?.id },
  });
});
