import { Router } from 'express';
import { manualRetryHandler } from '../controllers/delivery.controller.js';
import { validate } from '../middleware/validate.js';
import { deliveryParamsSchema } from '../validators/delivery.validators.js';

/**
 * Mounted at /api/v1/projects/:projectId/deliveries (inside the project
 * router, which applies requireAuth). Read/list endpoints arrive with the
 * Phase 6 dashboard; this phase ships manual retry (UC-30).
 */
export const deliveryRouter: Router = Router({ mergeParams: true });

deliveryRouter.post(
  '/:deliveryId/retry',
  validate({ params: deliveryParamsSchema }),
  manualRetryHandler,
);
