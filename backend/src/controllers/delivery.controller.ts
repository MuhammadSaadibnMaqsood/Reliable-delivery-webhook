import type { Request, Response } from 'express';
import { currentUser } from '../middleware/auth.js';
import { manualRetryDelivery } from '../services/delivery.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type { DeliveryParams } from '../validators/delivery.validators.js';

export async function manualRetryHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { projectId, deliveryId } = req.validated?.params as DeliveryParams;
  const delivery = await manualRetryDelivery(user.id, projectId, deliveryId);
  sendSuccess(res, {
    message: 'Delivery scheduled for retry (one additional attempt granted)',
    data: { delivery },
  });
}
