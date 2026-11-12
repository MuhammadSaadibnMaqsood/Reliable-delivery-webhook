import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import {
  createEventType,
  deleteEventType,
  listEventTypes,
} from '../services/event-type.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type {
  CreateEventTypeInput,
  EventTypeParams,
} from '../validators/event-type.validators.js';
import type { ProjectIdParams } from '../validators/project.validators.js';

export async function createEventTypeHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const eventType = await createEventType(
    user.id,
    projectId,
    req.validated?.body as CreateEventTypeInput,
  );
  sendSuccess(res, { statusCode: 201, message: 'Event type created', data: { eventType } });
}

export async function listEventTypesHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId } = req.validated?.params as ProjectIdParams;
  const eventTypes = await listEventTypes(user.id, projectId);
  sendSuccess(res, { message: 'Event types retrieved', data: { eventTypes } });
}

export async function deleteEventTypeHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, eventTypeId } = req.validated?.params as EventTypeParams;
  await deleteEventType(user.id, projectId, eventTypeId);
  sendSuccess(res, { message: 'Event type deleted', data: { deleted: true } });
}
