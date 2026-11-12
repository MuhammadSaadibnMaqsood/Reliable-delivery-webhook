import { z } from 'zod';

/**
 * Bounds mirror the database CHECK constraints (url ≤ 2048, timeout
 * 1000–30000 ms, max_attempts ≥ 1). The 1–20 ceiling on maxAttempts is a
 * provisional app-level bound (DB allows any ≥ 1) pending the Phase-0 retry
 * policy decision. Deep URL/SSRF validation happens in the service via
 * validateDestinationUrl — these schemas check shape only.
 */

const urlField = z.string().trim().min(1).max(2048);
const timeoutField = z.number().int().min(1000).max(30_000);
const maxAttemptsField = z.number().int().min(1).max(20);

export const registerEndpointSchema = z
  .object({
    url: urlField,
    description: z.string().trim().max(500).optional(),
    timeoutMs: timeoutField.optional(),
    maxAttempts: maxAttemptsField.optional(),
  })
  .strict();

export const updateEndpointSchema = z
  .object({
    url: urlField.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    // null clears an override back to the platform default.
    timeoutMs: timeoutField.nullable().optional(),
    maxAttempts: maxAttemptsField.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const endpointParamsSchema = z.object({
  projectId: z.uuid(),
  endpointId: z.uuid(),
});

export type RegisterEndpointInput = z.infer<typeof registerEndpointSchema>;
export type UpdateEndpointInput = z.infer<typeof updateEndpointSchema>;
export type EndpointParams = z.infer<typeof endpointParamsSchema>;
