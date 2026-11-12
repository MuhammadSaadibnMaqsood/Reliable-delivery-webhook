import { pino } from 'pino';
import { env, isDevelopment } from '../config/env.js';

/**
 * Application-wide structured logger (NFR-26).
 * Pretty-printed in development; raw JSON lines everywhere else.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  ...(isDevelopment
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});
