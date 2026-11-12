import { Router } from 'express';
import { login, register } from '../controllers/auth.controller.js';
import { authRateLimiter } from '../middleware/rate-limit.js';
import { validate } from '../middleware/validate.js';
import { loginSchema, registerSchema } from '../validators/auth.validators.js';

export const authRouter: Router = Router();

authRouter.use(authRateLimiter);

authRouter.post('/register', validate({ body: registerSchema }), register);
authRouter.post('/login', validate({ body: loginSchema }), login);
