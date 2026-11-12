import { Router } from 'express';
import {
  createApiKeyHandler,
  listApiKeysHandler,
  revokeApiKeyHandler,
} from '../controllers/api-key.controller.js';
import { validate } from '../middleware/validate.js';
import { apiKeyParamsSchema, createApiKeySchema } from '../validators/api-key.validators.js';
import { projectIdParamsSchema } from '../validators/project.validators.js';

/**
 * Mounted at /api/v1/projects/:projectId/api-keys (inside the project router,
 * which already applies requireAuth). mergeParams carries :projectId down.
 */
export const apiKeyRouter: Router = Router({ mergeParams: true });

apiKeyRouter.post(
  '/',
  validate({ params: projectIdParamsSchema, body: createApiKeySchema }),
  createApiKeyHandler,
);
apiKeyRouter.get('/', validate({ params: projectIdParamsSchema }), listApiKeysHandler);
apiKeyRouter.delete('/:keyId', validate({ params: apiKeyParamsSchema }), revokeApiKeyHandler);
