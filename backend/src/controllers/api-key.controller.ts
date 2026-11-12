import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/api-key.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type { ApiKeyParams, CreateApiKeyInput } from '../validators/api-key.validators.js';
import type { ProjectIdParams } from '../validators/project.validators.js';

export async function createApiKeyHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const result = await createApiKey(user.id, projectId, req.validated?.body as CreateApiKeyInput);
  sendSuccess(res, {
    statusCode: 201,
    message: 'API key created — store it now, it will not be shown again',
    data: result,
  });
}

export async function listApiKeysHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const apiKeys = await listApiKeys(user.id, projectId);
  sendSuccess(res, { message: 'API keys retrieved', data: { apiKeys } });
}

export async function revokeApiKeyHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, keyId } = req.validated?.params as ApiKeyParams;
  const apiKey = await revokeApiKey(user.id, projectId, keyId);
  sendSuccess(res, { message: 'API key revoked', data: { apiKey } });
}
