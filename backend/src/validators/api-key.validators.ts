import { z } from 'zod';

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();

export const apiKeyParamsSchema = z.object({
  projectId: z.uuid(),
  keyId: z.uuid(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type ApiKeyParams = z.infer<typeof apiKeyParamsSchema>;
