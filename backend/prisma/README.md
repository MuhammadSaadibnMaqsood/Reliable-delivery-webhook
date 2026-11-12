# Database layer — Prisma + PostgreSQL

Implements the approved, frozen database design (9 entities, 6 enums).
`schema.prisma` is the source of truth for everything Prisma can express;
this file documents the parts it cannot, and the rules that keep them safe.

## Connection configuration (NFR-24)

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | application runtime | **Pooled** connection (Neon pooler / Supabase pooler / PgBouncer). Keep `pgbouncer=true` and a small `connection_limit` on serverless. |
| `DIRECT_URL` | Prisma Migrate only | **Direct** connection. Transaction-mode poolers break migrations and advisory locks. |

Copy `.env.example` → `.env` and fill in real values. `.env` is gitignored;
credentials never enter source control.

## Migration workflow — the rules

1. **`prisma db push` is forbidden.** It reconciles the database to
   `schema.prisma` and does not know about the custom SQL objects below, so
   it can silently drop them.
2. New migrations are always created with
   `npm run prisma:migrate:new -- --name <name>` (`migrate dev --create-only`),
   then **reviewed before applying**. If the generated SQL contains a
   `DROP INDEX` or `DROP CONSTRAINT` for anything in the inventory below,
   delete those statements — that is the Prisma schema engine not
   understanding objects it cannot model, not a real schema change.
3. Apply with `npm run prisma:migrate:dev` locally and
   `npm run prisma:migrate:deploy` in CI/production.
4. Enum values may be **added** in later migrations; never rename or remove
   values on populated tables (Prisma regenerates the type with casts).
   A newly added enum value cannot be used in the same migration that adds it
   (PostgreSQL rule); our one-migration-per-change flow satisfies this.

## Custom SQL inventory (lives only in migrations, invisible to the schema engine)

Defined in `migrations/20261112090000_init/migration.sql`, Part 2:

**13 CHECK constraints**

| Constraint | Meaning |
|---|---|
| `deliveries_attempt_count_within_max_check` | `0 <= attempt_count <= max_attempts` |
| `deliveries_max_attempts_min_check` | `max_attempts >= 1` |
| `deliveries_terminal_completed_at_check` | terminal status ⇔ `completed_at` set (manual retry must reset it to NULL) |
| `deliveries_processing_lease_check` | processing ⇒ lease present |
| `deliveries_claim_token_lifecycle_check` | processing ⇔ `claim_token` present (two-sided) |
| `delivery_attempts_attempt_number_min_check` | `attempt_number >= 1` |
| `delivery_attempts_latency_ms_check` | latency non-negative |
| `delivery_attempts_response_status_check` | HTTP status in 100–599 when present |
| `endpoints_url_length_check` | URL ≤ 2048 chars |
| `endpoints_timeout_ms_check` | override in 1000–30000 ms (cap provisional, see migration comment) |
| `endpoints_max_attempts_check` | override ≥ 1 when present |
| `events_idempotency_key_length_check` | key 1–255 chars |
| `event_types_name_length_check` | name 1–200 chars |

**4 partial indexes**

| Index | Purpose |
|---|---|
| `deliveries_pending_next_attempt_at_idx` | claim scan (hottest query) |
| `deliveries_processing_lease_expires_at_idx` | exhausted-lease sweep + expired-lease reclaim |
| `deliveries_pending_endpoint_id_idx` | endpoint/project cancellation |
| `endpoints_live_project_id_idx` | live-endpoint listing and fan-out |

**2 documentation comments** on `deliveries.claim_token` and `deliveries.id`.

## Claim token lifecycle (fencing) — authoritative wording

A claim mints a fresh `claim_token` (and increments `attempt_count`, the only
place it ever increments). **Lease expiry makes a delivery eligible for
reclamation; it does not independently invalidate the current claim token.**
The token becomes invalid only when one of two things replaces or clears it:

- a **new claim** of the same delivery (expired-lease reclaim), or
- the **exhausted-lease sweep** (`processing`, lease expired,
  `attempt_count >= max_attempts` → `dead_lettered`).

Consequently, a worker whose lease has expired but whose delivery has *not*
yet been reclaimed or swept still holds the current token, and its
compare-and-set result write succeeds — correctly, since its result is the
only result. Every worker write is guarded by
`WHERE status = 'processing' AND claim_token = $held_token`; a worker that
loses the CAS writes **nothing** (no delivery update, no attempt row — the
fenced-out attempt appears as a numbering gap, same as a crash).

Duplicate HTTP requests to destinations remain possible under at-least-once
semantics (fencing gives exactly-once *bookkeeping*, not exactly-once
*delivery*); receivers deduplicate using the delivery ID carried in the
signed headers.

## ID policy

All primary keys are **UUIDv7**, generated client-side by Prisma
(`@default(uuid(7))`). There is deliberately **no database-level default**:
every insert flows through application code (the ingestion fan-out uses an
interactive transaction + `createMany` with client-generated IDs, not raw
`INSERT ... SELECT`). Public IDs — notably `deliveries.id` and `events.id` —
are identifiers, **not** authorization credentials: every read/write path
verifies project ownership first (NFR-13/FR-57).

## Raw SQL surface (future worker/ingestion phases)

The claim, sweep, cancellation, and manual-retry statements bypass Prisma's
query API (`$queryRaw`/`$executeRaw`) and therefore MUST set
`updated_at = now()` themselves — `@updatedAt` is client-side and does not
apply to raw SQL.
