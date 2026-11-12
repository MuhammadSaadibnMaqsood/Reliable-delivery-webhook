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
import {
  createProjectSchema,
  listProjectsQuerySchema,
  projectIdParamsSchema,
  updateProjectSchema,
} from '../validators/project.validators.js';

export const projectRouter: Router = Router();

// Everything below requires an authenticated, active user.
projectRouter.use(requireAuth);

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
