import { Router } from 'express';
import {
  activateEndpointHandler,
  deactivateEndpointHandler,
  deleteEndpointHandler,
  getEndpointHandler,
  listEndpointsHandler,
  registerEndpointHandler,
  updateEndpointHandler,
} from '../controllers/endpoint.controller.js';
import {
  createSubscriptionHandler,
  deleteSubscriptionHandler,
  listSubscriptionsHandler,
} from '../controllers/subscription.controller.js';
import { validate } from '../middleware/validate.js';
import {
  endpointParamsSchema,
  registerEndpointSchema,
  updateEndpointSchema,
} from '../validators/endpoint.validators.js';
import { projectIdParamsSchema } from '../validators/project.validators.js';
import {
  createSubscriptionSchema,
  subscriptionListParamsSchema,
  subscriptionParamsSchema,
} from '../validators/subscription.validators.js';

/**
 * Mounted at /api/v1/projects/:projectId/endpoints (inside the project
 * router, which applies requireAuth). Activation state has dedicated
 * operations — it is not PATCHable.
 */
export const endpointRouter: Router = Router({ mergeParams: true });

endpointRouter.post(
  '/',
  validate({ params: projectIdParamsSchema, body: registerEndpointSchema }),
  registerEndpointHandler,
);
endpointRouter.get('/', validate({ params: projectIdParamsSchema }), listEndpointsHandler);
endpointRouter.get('/:endpointId', validate({ params: endpointParamsSchema }), getEndpointHandler);
endpointRouter.patch(
  '/:endpointId',
  validate({ params: endpointParamsSchema, body: updateEndpointSchema }),
  updateEndpointHandler,
);
endpointRouter.post(
  '/:endpointId/activate',
  validate({ params: endpointParamsSchema }),
  activateEndpointHandler,
);
endpointRouter.post(
  '/:endpointId/deactivate',
  validate({ params: endpointParamsSchema }),
  deactivateEndpointHandler,
);
endpointRouter.delete(
  '/:endpointId',
  validate({ params: endpointParamsSchema }),
  deleteEndpointHandler,
);

// --- Subscriptions (nested under an endpoint) ------------------------------
endpointRouter.post(
  '/:endpointId/subscriptions',
  validate({ params: subscriptionListParamsSchema, body: createSubscriptionSchema }),
  createSubscriptionHandler,
);
endpointRouter.get(
  '/:endpointId/subscriptions',
  validate({ params: subscriptionListParamsSchema }),
  listSubscriptionsHandler,
);
endpointRouter.delete(
  '/:endpointId/subscriptions/:subscriptionId',
  validate({ params: subscriptionParamsSchema }),
  deleteSubscriptionHandler,
);
