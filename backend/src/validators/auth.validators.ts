import { z } from 'zod';

/** Email: trimmed, lowercased, then format-checked (stored lowercase — DB unique is case-safe). */
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Max length guards argon2 against absurd inputs; no composition rules (NIST-style). */
const passwordSchema = z.string().min(8, 'must be at least 8 characters').max(128);

export const registerSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
