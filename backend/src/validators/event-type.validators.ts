import { z } from 'zod';

/**
 * Event type names follow the conventional dotted style (order.paid,
 * user.signup_completed): segments of [a-z0-9_-] joined by dots. This is the
 * app-level format convention FR-26 leaves to us; the DB only bounds length.
 */
const EVENT_TYPE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/i;

export const createEventTypeSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(
        EVENT_TYPE_NAME_PATTERN,
        'must be dot-separated segments of letters, digits, _ or - (e.g. order.paid)',
      ),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const eventTypeParamsSchema = z.object({
  projectId: z.uuid(),
  eventTypeId: z.uuid(),
});

export type CreateEventTypeInput = z.infer<typeof createEventTypeSchema>;
export type EventTypeParams = z.infer<typeof eventTypeParamsSchema>;
