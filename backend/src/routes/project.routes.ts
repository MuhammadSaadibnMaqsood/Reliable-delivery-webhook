import { Router } from 'express';
import {
  createProjectHandler,
  deleteProjectHandler,
  getProjectHandler,
  listProjectsHandler,
  updateProjectHandler,
} from '../controllers/project.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { apiKeyRouter } from './api-key.routes.js';
import { deliveryRouter } from './delivery.routes.js';
import { endpointRouter } from './endpoint.routes.js';
import { eventTypeRouter } from './event-type.routes.js';
import {
  createProjectSchema,
  listProjectsQuerySchema,
  projectIdParamsSchema,
  updateProjectSchema,
} from '../validators/project.validators.js';

export const projectRouter: Router = Router();

// Everything below requires an authenticated, active user.
projectRouter.use(requireAuth);

// Project-scoped API key management (Phase 4A).
projectRouter.use('/:projectId/api-keys', apiKeyRouter);

// Endpoint management + subscriptions, and event types (Phase 4B).
projectRouter.use('/:projectId/endpoints', endpointRouter);
projectRouter.use('/:projectId/event-types', eventTypeRouter);

// Delivery operations: manual retry (Phase 5B.4); read APIs come with Phase 6.
projectRouter.use('/:projectId/deliveries', deliveryRouter);

projectRouter.post('/', validate({ body: createProjectSchema }), createProjectHandler);
projectRouter.get('/', validate({ query: listProjectsQuerySchema }), listProjectsHandler);
projectRouter.get('/:projectId', validate({ params: projectIdParamsSchema }), getProjectHandler);
projectRouter.patch(
  '/:projectId',
  validate({ params: projectIdParamsSchema, body: updateProjectSchema }),
  updateProjectHandler,
);
projectRouter.delete(
  '/:projectId',
  validate({ params: projectIdParamsSchema }),
  deleteProjectHandler,
);
