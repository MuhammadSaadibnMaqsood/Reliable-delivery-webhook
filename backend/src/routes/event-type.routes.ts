import { Router } from 'express';
import {
  createEventTypeHandler,
  deleteEventTypeHandler,
  listEventTypesHandler,
} from '../controllers/event-type.controller.js';
import { validate } from '../middleware/validate.js';
import {
  createEventTypeSchema,
  eventTypeParamsSchema,
} from '../validators/event-type.validators.js';
import { projectIdParamsSchema } from '../validators/project.validators.js';

/** Mounted at /api/v1/projects/:projectId/event-types (requireAuth inherited). */
export const eventTypeRouter: Router = Router({ mergeParams: true });

eventTypeRouter.post(
  '/',
  validate({ params: projectIdParamsSchema, body: createEventTypeSchema }),
  createEventTypeHandler,
);
eventTypeRouter.get('/', validate({ params: projectIdParamsSchema }), listEventTypesHandler);
eventTypeRouter.delete(
  '/:eventTypeId',
  validate({ params: eventTypeParamsSchema }),
  deleteEventTypeHandler,
);
