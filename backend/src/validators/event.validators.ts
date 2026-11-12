import { z } from 'zod';
import { EVENT_TYPE_NAME_PATTERN } from './event-type.validators.js';

export const ingestEventSchema = z
  .object({
    eventType: z.string().trim().min(1).max(200).regex(EVENT_TYPE_NAME_PATTERN),
    // Any JSON object (arrays/scalars rejected); values are inherently
    // JSON-safe because they arrive through express.json().
    payload: z.looseObject({}),
  })
  .strict();

/**
 * Validated against req.headers (Node lowercases header names). Non-strict:
 * other headers pass through untouched; only this one is picked out.
 */
export const ingestEventHeadersSchema = z.object({
  'idempotency-key': z
    .string({ error: 'Idempotency-Key header is required' })
    .trim()
    .min(1, 'Idempotency-Key header must not be empty')
    .max(255, 'Idempotency-Key header must be at most 255 characters'),
});

export type IngestEventInput = z.infer<typeof ingestEventSchema>;
export type IngestEventHeaders = z.infer<typeof ingestEventHeadersSchema>;
