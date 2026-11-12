import { isDatabaseReachable } from '../db/prisma.js';

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    api: 'ok';
    database: 'connected' | 'unreachable';
  };
}

/** Basic platform health (NFR-29): API process + database connectivity. */
export async function getHealthReport(): Promise<HealthReport> {
  const databaseUp = await isDatabaseReachable();

  return {
    status: databaseUp ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      api: 'ok',
      database: databaseUp ? 'connected' : 'unreachable',
    },
  };
}
