import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
} from '../services/subscription.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type {
  CreateSubscriptionInput,
  SubscriptionListParams,
  SubscriptionParams,
} from '../validators/subscription.validators.js';

export async function createSubscriptionHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, endpointId } = req.validated?.params as SubscriptionListParams;
  const subscription = await createSubscription(
    user.id,
    projectId,
    endpointId,
    req.validated?.body as CreateSubscriptionInput,
  );
  sendSuccess(res, { statusCode: 201, message: 'Subscription created', data: { subscription } });
}

export async function listSubscriptionsHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, endpointId } = req.validated?.params as SubscriptionListParams;
  const subscriptions = await listSubscriptions(user.id, projectId, endpointId);
  sendSuccess(res, { message: 'Subscriptions retrieved', data: { subscriptions } });
}

export async function deleteSubscriptionHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, endpointId, subscriptionId } = req.validated?.params as SubscriptionParams;
  await deleteSubscription(user.id, projectId, endpointId, subscriptionId);
  sendSuccess(res, { message: 'Subscription removed', data: { deleted: true } });
}
