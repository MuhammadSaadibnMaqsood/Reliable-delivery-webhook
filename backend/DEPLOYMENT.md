# Deploying to Vercel (Hobby)

The backend deploys as two Vercel Functions, with no persistent server
process:

| Function | Serves | maxDuration |
|---|---|---|
| `api/index.ts` | the whole Express API (rewrite `/(.*)`) | 30 s |
| `api/worker-tick.ts` | `POST /internal/worker/tick` only | 300 s |

`vercel.json` rewrites preserve original URLs, so Express routing is
unchanged. The worker function is split out so only the scheduler-facing
tick gets the long budget. **maxDuration 300 on Hobby requires Fluid
Compute** (enabled by default on new projects — check Project Settings →
Functions if the deploy warns about duration limits).

## Project settings

- **Root Directory:** `backend` (this folder, inside the repository).
- **Framework preset:** Other. No build output is served; only `api/`
  functions. `postinstall` runs `prisma generate` on every install, so the
  Prisma client always matches Vercel's build environment.
- **Node.js:** 20+ (from `engines`).

## Required environment variables

Set these in Vercel → Project → Settings → Environment Variables:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string (`-pooler` host), with `sslmode=require&pgbouncer=true&connection_limit=5` |
| `DIRECT_URL` | Neon direct connection. Used only by `prisma migrate deploy` (run from CI/local, not by the functions) — set it anyway so builds that validate the schema succeed |
| `JWT_SECRET` | ≥ 32 random chars |
| `SECRET_ENCRYPTION_KEY` | 64 hex chars (AES-256) — same value that encrypted existing endpoint secrets |
| `WORKER_TRIGGER_SECRET` | ≥ 32 random chars; the scheduler sends it as `X-Worker-Secret` |
| `NODE_ENV` | `production` |
| `CORS_ORIGINS` | comma-separated dashboard origins |

Optional overrides (validated defaults apply when unset): `JWT_EXPIRES_IN`
(1d), `LOG_LEVEL` (info), `AUTH_RATE_LIMIT_WINDOW_MS`/`AUTH_RATE_LIMIT_MAX`
(900000/20), `DELIVERY_MAX_ATTEMPTS_DEFAULT` (5), `WORKER_BATCH_SIZE` (4),
`WORKER_LEASE_MS` (60000), `DELIVERY_TIMEOUT_MS_DEFAULT` (10000),
`DELIVERY_RETRY_INITIAL_DELAY_MS` (30000), `DELIVERY_RETRY_MAX_DELAY_MS`
(3600000).

Never set `DESTINATION_ALLOW_PRIVATE` in production — the app refuses to
boot with it enabled.

## Deploy steps

1. Apply migrations to Neon once per schema change, from a trusted
   environment: `npm run prisma:migrate:deploy` (uses `DIRECT_URL`).
2. Push to the connected Git branch (or `vercel --prod`). The build runs
   `npm install` → `postinstall: prisma generate` → `tsc` (artifact unused
   by the functions, but it gates the deploy on type errors).
3. Smoke-check: `GET /health` → 200 with `database: connected`;
   `POST /internal/worker/tick` with `X-Worker-Secret` → 200 counts summary;
   without the header → 401.
4. Point the external scheduler at
   `POST https://<deployment>/internal/worker/tick` with the
   `X-Worker-Secret` header, per-minute cadence. (Scheduler configuration is
   deliberately a separate step.)

## Serverless fitness notes

- **No in-memory state affects correctness.** Queue state, leases, fencing
  tokens and idempotency all live in Postgres; the Prisma client is a
  per-instance singleton; `server.ts` (listen/graceful shutdown) is not used
  on Vercel. The only in-memory behaviors are best-effort conveniences and
  are documented as such: the auth rate limiter counts per instance, and
  `last_used_at` throttling may write slightly more often across instances.
- **Tick arithmetic:** batch 4 × worst-case attempt (30 s cap + overhead)
  ≈ 130 s < 300 s maxDuration, and per-item lease renewal keeps each claim's
  60 s lease valid regardless of batch position. Overlapping scheduler ticks
  remain safe (SKIP LOCKED + leases + fencing).
- **Cold starts** add latency to the first request of an instance (NFR-01
  excludes them by design). Neon's pooled connection string keeps
  connection counts within free-tier limits.
