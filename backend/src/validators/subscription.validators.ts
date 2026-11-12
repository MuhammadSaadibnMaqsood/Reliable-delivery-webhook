import { z } from 'zod';

export const createSubscriptionSchema = z
  .object({
    eventTypeId: z.uuid(),
  })
  .strict();

export const subscriptionListParamsSchema = z.object({
  projectId: z.uuid(),
  endpointId: z.uuid(),
});

export const subscriptionParamsSchema = z.object({
  projectId: z.uuid(),
  endpointId: z.uuid(),
  subscriptionId: z.uuid(),
});

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type SubscriptionListParams = z.infer<typeof subscriptionListParamsSchema>;
export type SubscriptionParams = z.infer<typeof subscriptionParamsSchema>;
