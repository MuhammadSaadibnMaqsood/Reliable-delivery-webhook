import type { Request, Response } from 'express';
import { currentApiKey } from '../middleware/api-key-auth.js';
import { ingestEvent } from '../services/event.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type {
  IngestEventHeaders,
  IngestEventInput,
} from '../validators/event.validators.js';

export async function ingestEventHandler(req: Request, res: Response): Promise<void> {
  const apiKey = currentApiKey(req); // project identity from the key record only
  const headers = req.validated?.headers as IngestEventHeaders;
  const event = await ingestEvent(
    apiKey.projectId,
    req.validated?.body as IngestEventInput,
    headers['idempotency-key'],
  );
  // 202: accepted and persisted; asynchronous delivery happens later.
  sendSuccess(res, { statusCode: 202, message: 'Event accepted', data: { event } });
}
