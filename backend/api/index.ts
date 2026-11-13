import { buildApp } from '../src/app.js';

/**
 * Vercel Function: the entire API (every route except the worker trigger,
 * which /internal/worker/tick rewrites to its own long-duration function).
 *
 * An Express app is a (req, res) handler, so it exports directly. It is
 * built once per warm instance; environment validation and the Prisma
 * singleton run at import time, exactly as under `npm run dev`. Rewrites
 * preserve the original URL, so Express routing is unchanged.
 */
export default buildApp();
