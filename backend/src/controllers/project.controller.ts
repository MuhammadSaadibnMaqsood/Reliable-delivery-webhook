import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import {
  createProject,
  getOwnedProject,
  listProjects,
  softDeleteProject,
  updateProject,
} from '../services/project.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type {
  CreateProjectInput,
  ListProjectsQuery,
  ProjectIdParams,
  UpdateProjectInput,
} from '../validators/project.validators.js';

export async function createProjectHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const project = await createProject(user.id, req.validated?.body as CreateProjectInput);
  sendSuccess(res, { statusCode: 201, message: 'Project created', data: { project } });
}

export async function listProjectsHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const result = await listProjects(user.id, req.validated?.query as ListProjectsQuery);
  sendSuccess(res, { message: 'Projects retrieved', data: result });
}

export async function getProjectHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const project = await getOwnedProject(user.id, projectId);
  sendSuccess(res, { message: 'Project retrieved', data: { project } });
}

export async function updateProjectHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const project = await updateProject(user.id, projectId, req.validated?.body as UpdateProjectInput);
  sendSuccess(res, { message: 'Project updated', data: { project } });
}

export async function deleteProjectHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const summary = await softDeleteProject(user.id, projectId);
  sendSuccess(res, { message: 'Project deleted', data: { summary } });
}
