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
  const result = await ingestEvent(
    apiKey.projectId,
    req.validated?.body as IngestEventInput,
    headers['idempotency-key'],
  );

  if (result.kind === 'replay') {
    // Same key + same canonical payload: return the ORIGINAL event, 200.
    sendSuccess(res, {
      statusCode: 200,
      message: 'Event already accepted (idempotent replay)',
      data: { event: result.event, idempotentReplay: true },
    });
    return;
  }

  // 202: accepted and persisted with its delivery jobs; the worker (Phase 5B)
  // processes them asynchronously.
  sendSuccess(res, {
    statusCode: 202,
    message: 'Event accepted',
    data: {
      event: result.event,
      idempotentReplay: false,
      deliveriesCreated: result.deliveriesCreated,
    },
  });
}
