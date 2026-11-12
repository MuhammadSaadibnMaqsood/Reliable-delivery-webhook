import { Router } from 'express';
import { ingestEventHandler } from '../controllers/event.controller.js';
import { requireApiKey } from '../middleware/api-key-auth.js';
import { validate } from '../middleware/validate.js';
import {
  ingestEventHeadersSchema,
  ingestEventSchema,
} from '../validators/event.validators.js';

/**
 * Producer-facing ingestion API (X-API-Key auth, NOT JWT).
 * Auth runs before validation: credentials are judged before request shape.
 */
export const eventRouter: Router = Router();

eventRouter.post(
  '/',
  requireApiKey,
  validate({ body: ingestEventSchema, headers: ingestEventHeadersSchema }),
  ingestEventHandler,
);
