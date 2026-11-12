import type { Request, Response } from 'express';
import { loginUser, registerUser } from '../services/auth.service.js';
import { sendSuccess } from '../utils/api-response.js';
import type { LoginInput, RegisterInput } from '../validators/auth.validators.js';

// req.validated.body is guaranteed by the validate() middleware on these
// routes; the casts restate what the route wiring already enforces.

export async function register(req: Request, res: Response): Promise<void> {
  const user = await registerUser(req.validated?.body as RegisterInput);
  sendSuccess(res, { statusCode: 201, message: 'Account created', data: { user } });
}

export async function login(req: Request, res: Response): Promise<void> {
  const result = await loginUser(req.validated?.body as LoginInput);
  sendSuccess(res, { message: 'Login successful', data: result });
}
