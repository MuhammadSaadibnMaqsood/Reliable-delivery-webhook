-- ===========================================================================
-- Initial migration — Reliable Webhook Delivery & Automation Platform
--
-- Part 1 is generated from prisma/schema.prisma (prisma migrate diff).
-- Part 2 is HAND-WRITTEN custom SQL for objects Prisma cannot express:
--   CHECK constraints, partial indexes, and documentation comments.
-- Future migrations: always `prisma migrate dev --create-only`, review the
-- generated SQL, and never let it drop the Part 2 objects. `prisma db push`
-- is forbidden in this repository. See prisma/README.md.
-- ===========================================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'processing', 'succeeded', 'failed', 'dead_lettered', 'cancelled');

-- CreateEnum
CREATE TYPE "attempt_trigger" AS ENUM ('automatic', 'manual');

-- CreateEnum
CREATE TYPE "attempt_outcome" AS ENUM ('success', 'failed_retryable', 'failed_permanent');

-- CreateEnum
CREATE TYPE "error_category" AS ENUM ('timeout', 'connection', 'dns', 'tls', 'http_4xx', 'http_5xx', 'ssrf_blocked', 'other');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'user',
    "status" "user_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "endpoints" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "signing_secret" TEXT NOT NULL,
    "timeout_ms" INTEGER,
    "max_attempts" INTEGER,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_types" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_type_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "event_type_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMPTZ(6),
    "claim_token" UUID,
    "locked_by" TEXT,
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "trigger" "attempt_trigger" NOT NULL DEFAULT 'automatic',
    "triggered_by_user_id" UUID,
    "outcome" "attempt_outcome" NOT NULL,
    "response_status" INTEGER,
    "latency_ms" INTEGER,
    "error_category" "error_category",
    "error_message" TEXT,
    "request_url" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "projects_user_id_idx" ON "projects"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_prefix_key" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "endpoints_id_project_id_key" ON "endpoints"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_types_project_id_name_key" ON "event_types"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "event_types_id_project_id_key" ON "event_types"("id", "project_id");

-- CreateIndex
CREATE INDEX "subscriptions_event_type_id_idx" ON "subscriptions"("event_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_endpoint_id_event_type_id_key" ON "subscriptions"("endpoint_id", "event_type_id");

-- CreateIndex
CREATE INDEX "events_project_id_created_at_idx" ON "events"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "events_project_id_event_type_id_created_at_idx" ON "events"("project_id", "event_type_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "events_project_id_idempotency_key_key" ON "events"("project_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "events_id_project_id_key" ON "events"("id", "project_id");

-- CreateIndex
CREATE INDEX "deliveries_project_id_status_created_at_idx" ON "deliveries"("project_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "deliveries_endpoint_id_created_at_idx" ON "deliveries"("endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_event_id_endpoint_id_key" ON "deliveries"("event_id", "endpoint_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_delivery_id_attempt_number_key" ON "delivery_attempts"("delivery_id", "attempt_number");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_types" ADD CONSTRAINT "event_types_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_endpoint_id_project_id_fkey" FOREIGN KEY ("endpoint_id", "project_id") REFERENCES "endpoints"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_event_type_id_project_id_fkey" FOREIGN KEY ("event_type_id", "project_id") REFERENCES "event_types"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_event_type_id_project_id_fkey" FOREIGN KEY ("event_type_id", "project_id") REFERENCES "event_types"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_project_id_fkey" FOREIGN KEY ("event_id", "project_id") REFERENCES "events"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_endpoint_id_project_id_fkey" FOREIGN KEY ("endpoint_id", "project_id") REFERENCES "endpoints"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Part 2 — custom SQL (NOT managed by the Prisma schema engine)
--
-- Inventory (keep in sync with prisma/README.md):
--   13 CHECK constraints, 4 partial indexes, 2 documentation comments.
-- Any future auto-generated migration that tries to DROP one of these
-- objects must be edited before it is applied.
-- ===========================================================================

-- ---- CHECK constraints: deliveries state machine -------------------------

-- The attempt counter can never pass its cap (the claim query's top-level
-- guard `attempt_count < max_attempts` is what keeps increments legal).
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_attempt_count_within_max_check"
    CHECK ("attempt_count" >= 0 AND "attempt_count" <= "max_attempts");

ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_max_attempts_min_check"
    CHECK ("max_attempts" >= 1);

-- Terminal statuses and completed_at imply each other; manual retry must
-- therefore reset completed_at to NULL when re-opening a delivery.
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_terminal_completed_at_check"
    CHECK (("status" IN ('succeeded', 'failed', 'dead_lettered', 'cancelled')) = ("completed_at" IS NOT NULL));

-- A processing delivery always carries a lease.
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_processing_lease_check"
    CHECK ("status" <> 'processing' OR "lease_expires_at" IS NOT NULL);

-- claim_token lifecycle: held exactly while processing (two-sided).
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_claim_token_lifecycle_check"
    CHECK (("status" = 'processing') = ("claim_token" IS NOT NULL));

-- ---- CHECK constraints: delivery_attempts ---------------------------------

ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_attempt_number_min_check"
    CHECK ("attempt_number" >= 1);

ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_latency_ms_check"
    CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0);

ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_response_status_check"
    CHECK ("response_status" IS NULL OR ("response_status" BETWEEN 100 AND 599));

-- ---- CHECK constraints: endpoints -----------------------------------------

ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_url_length_check"
    CHECK (char_length("url") <= 2048);

-- Upper bound 30000 ms is a provisional cap pending the scheduler/runtime
-- decision; adjust in a later migration if that decision changes it.
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_timeout_ms_check"
    CHECK ("timeout_ms" IS NULL OR ("timeout_ms" BETWEEN 1000 AND 30000));

ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_max_attempts_check"
    CHECK ("max_attempts" IS NULL OR "max_attempts" >= 1);

-- ---- CHECK constraints: events / event_types ------------------------------

ALTER TABLE "events" ADD CONSTRAINT "events_idempotency_key_length_check"
    CHECK (char_length("idempotency_key") BETWEEN 1 AND 255);

ALTER TABLE "event_types" ADD CONSTRAINT "event_types_name_length_check"
    CHECK (char_length("name") BETWEEN 1 AND 200);

-- ---- Partial indexes (queue hot paths) ------------------------------------

-- Claim scan: the live queue slice only.
CREATE INDEX "deliveries_pending_next_attempt_at_idx"
    ON "deliveries" ("next_attempt_at") WHERE "status" = 'pending';

-- Expired-lease sweep and reclaim branch.
CREATE INDEX "deliveries_processing_lease_expires_at_idx"
    ON "deliveries" ("lease_expires_at") WHERE "status" = 'processing';

-- Endpoint/project cancellation: cost tracks the endpoint's pending jobs,
-- not the global queue.
CREATE INDEX "deliveries_pending_endpoint_id_idx"
    ON "deliveries" ("endpoint_id") WHERE "status" = 'pending';

-- Live-endpoint listing and fan-out.
CREATE INDEX "endpoints_live_project_id_idx"
    ON "endpoints" ("project_id") WHERE "deleted_at" IS NULL;

-- ---- Documentation comments ------------------------------------------------

COMMENT ON COLUMN "deliveries"."claim_token" IS
    'Fencing token minted by each claim (gen_random_uuid() in the claim statement). Lease expiry makes the delivery ELIGIBLE FOR RECLAMATION; it does not by itself invalidate this token. The token becomes invalid only when a new claim replaces it or the exhausted-lease sweep clears it. Every worker write must compare-and-set on (status = ''processing'' AND claim_token = <held token>) and write nothing when it loses.';

COMMENT ON COLUMN "deliveries"."id" IS
    'Public delivery identifier (UUIDv7, sent in signed webhook headers for receiver-side deduplication, NFR-07/27). An identifier, NOT an authorization credential: every access path must verify project ownership (NFR-13/FR-57).';
