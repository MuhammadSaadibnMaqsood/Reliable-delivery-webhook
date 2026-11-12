import type { Request, Response } from 'express';
import { getHealthReport } from '../services/health.service.js';
import { sendError, sendSuccess } from '../utils/api-response.js';
import { ErrorCodes } from '../utils/app-error.js';

/** GET /health — 200 when fully healthy, 503 when degraded (monitor-friendly). */
export async function getHealth(_req: Request, res: Response): Promise<void> {
  const report = await getHealthReport();

  if (report.status === 'ok') {
    sendSuccess(res, { message: 'Service healthy', data: report });
    return;
  }

  sendError(res, {
    statusCode: 503,
    message: 'Service degraded',
    code: ErrorCodes.SERVICE_UNAVAILABLE,
    details: [{ path: 'checks.database', message: 'Database unreachable' }],
  });
}
