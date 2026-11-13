import { z } from 'zod';

export const deliveryParamsSchema = z.object({
  projectId: z.uuid(),
  deliveryId: z.uuid(),
});

export type DeliveryParams = z.infer<typeof deliveryParamsSchema>;
