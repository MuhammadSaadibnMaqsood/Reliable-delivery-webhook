import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import {
  activateEndpoint,
  deactivateEndpoint,
  getEndpoint,
  listEndpoints,
  registerEndpoint,
  softDeleteEndpoint,
  updateEndpoint,
} from '../services/endpoint.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type {
  EndpointParams,
  RegisterEndpointInput,
  UpdateEndpointInput,
} from '../validators/endpoint.validators.js';
import type { ProjectIdParams } from '../validators/project.validators.js';

export async function registerEndpointHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const result = await registerEndpoint(
    user.id,
    projectId,
    req.validated?.body as RegisterEndpointInput,
  );
  sendSuccess(res, {
    statusCode: 201,
    message: 'Endpoint registered — store the signing secret now, it will not be shown again',
    data: result,
  });
}

export async function listEndpointsHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const endpoints = await listEndpoints(user.id, projectId);
  sendSuccess(res, { message: 'Endpoints retrieved', data: { endpoints } });
}

export async function getEndpointHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, endpointId } = req.validated?.params as EndpointParams;
  const endpoint = await getEndpoint(user.id, projectId, endpointId);
  sendSuccess(res, { message: 'Endpoint retrieved', data: { endpoint } });
}

export async function updateEndpointHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, endpointId } = req.validated?.params as EndpointParams;
  const endpoint = await updateEndpoint(
    user.id,
    projectId,
    endpointId,
    req.validated?.body as UpdateEndpointInput,
  );
  sendSuccess(res, { message: 'Endpoint updated', data: { endpoint } });
}

export async function activateEndpointHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, endpointId } = req.validated?.params as EndpointParams;
  const endpoint = await activateEndpoint(user.id, projectId, endpointId);
  sendSuccess(res, { message: 'Endpoint activated', data: { endpoint } });
}

export async function deactivateEndpointHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, endpointId } = req.validated?.params as EndpointParams;
  const result = await deactivateEndpoint(user.id, projectId, endpointId);
  sendSuccess(res, { message: 'Endpoint deactivated', data: result });
}

export async function deleteEndpointHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, endpointId } = req.validated?.params as EndpointParams;
  const summary = await softDeleteEndpoint(user.id, projectId, endpointId);
  sendSuccess(res, { message: 'Endpoint deleted', data: { summary } });
}
