import { z } from 'zod';

/**
 * .strict() everywhere: unknown keys are rejected outright, which is also
 * what guarantees protected fields (userId, deletedAt, …) can never ride in
 * through a create/update body.
 */

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    // null clears the description; absent leaves it untouched.
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const projectIdParamsSchema = z.object({
  projectId: z.uuid(),
});

export const listProjectsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ProjectIdParams = z.infer<typeof projectIdParamsSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
