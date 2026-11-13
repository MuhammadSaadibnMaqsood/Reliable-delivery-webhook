import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app.js';

/**
 * Vercel Function: the entire API (every route except the worker trigger,
 * which /internal/worker/tick rewrites to its own long-duration function).
 *
 * The default export MUST be a literal function declaration: @vercel/node
 * statically analyzes this file's exports, and a computed export like
 * `export default buildApp()` defeats that analysis — the builder then
 * follows the import into src/app.ts, finds no default export there, and
 * fails with "Invalid export found in module …/src/app.js". The app is
 * still built exactly once per warm instance; env validation and the
 * Prisma singleton run at import time, as under `npm run dev`.
 */
const app = buildApp();
// Express apps are (req, res) callables; the cast bridges Express's
// Request/Response types to the plain Node types Vercel hands us.
const invoke = app as unknown as (req: IncomingMessage, res: ServerResponse) => void;

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  invoke(req, res);
}
