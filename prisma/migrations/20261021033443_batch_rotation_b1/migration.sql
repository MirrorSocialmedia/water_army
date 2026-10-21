-- BR-B1 (Batch Rotation, MD §9): additive-only migration.
-- Creates: identities, batches, batch_identities, resource_leases, state_events
-- Extends: task_runs (+6 nullable/defaulted columns, +3 indexes)
-- Drops nothing, alters no existing column, rewrites no data (MD §9: additive only).
-- Idempotent by construction: Prisma records this file in _prisma_migrations
-- after a successful apply; a second `migrate deploy` is a no-op.
--
-- Status columns are TEXT (not Postgres ENUMs) on purpose, following the R3
-- precedent (devices.net_state / proxy_state): the legal state set is defined
-- in packages/shared/src/batch-constants.js and the central transition
-- services — extending a state must not require an enum-type migration.

-- ---------------------------------------------------------------- identities
CREATE TABLE "identities" (
    "id" UUID NOT NULL,
    "external_ref" TEXT,
    "display_name" TEXT NOT NULL,
    "identity_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "data_path" TEXT NOT NULL,
    "metadata_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "identities_external_ref_key" ON "identities"("external_ref");
CREATE UNIQUE INDEX "identities_data_path_key" ON "identities"("data_path");
CREATE INDEX "identities_status_idx" ON "identities"("status");
CREATE INDEX "identities_identity_type_idx" ON "identities"("identity_type");

-- ------------------------------------------------------------------ batches
CREATE TABLE "batches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "batch_no" INT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "batch_size" INT NOT NULL,
    "max_active_containers" INT NOT NULL,
    "failure_policy" TEXT NOT NULL,
    "config_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "idempotency_key" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- MD §9.2: unique batch_no WITHIN the same cycle.
CREATE UNIQUE INDEX "batches_cycle_id_batch_no_key" ON "batches"("cycle_id", "batch_no");
CREATE UNIQUE INDEX "batches_idempotency_key_key" ON "batches"("idempotency_key");
CREATE INDEX "batches_status_idx" ON "batches"("status");
CREATE INDEX "batches_cycle_id_idx" ON "batches"("cycle_id");

-- ------------------------------------------------------------ batch_identities
CREATE TABLE "batch_identities" (
    "batch_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "position" INT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skip_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_identities_pkey" PRIMARY KEY ("batch_id", "identity_id")
);

-- MD §9.3: one position per identity per batch.
CREATE UNIQUE INDEX "batch_identities_batch_id_position_key" ON "batch_identities"("batch_id", "position");
CREATE INDEX "batch_identities_identity_id_idx" ON "batch_identities"("identity_id");

ALTER TABLE "batch_identities" ADD CONSTRAINT "batch_identities_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_identities" ADD CONSTRAINT "batch_identities_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------ resource_leases
CREATE TABLE "resource_leases" (
    "id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_key" TEXT NOT NULL,
    "owner_run_id" UUID,
    "owner_label" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "resource_leases_pkey" PRIMARY KEY ("id")
);

-- MD §9.6: one live holder per (type, key).
CREATE UNIQUE INDEX "resource_leases_resource_type_resource_key_key" ON "resource_leases"("resource_type", "resource_key");
CREATE INDEX "resource_leases_lease_expires_at_idx" ON "resource_leases"("lease_expires_at");
CREATE INDEX "resource_leases_owner_run_id_idx" ON "resource_leases"("owner_run_id");

-- -------------------------------------------------------------- state_events
-- Append-only from/to state event store (MD §9.5). Generic over entity type;
-- separate from task_run_events (run-scoped, cascade-deletes with the run).
-- No API surface updates or deletes these rows (service-layer append-only,
-- same convention as audit_events).
CREATE TABLE "state_events" (
    "id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "reason" TEXT,
    "actor" TEXT,
    "correlation_id" TEXT,
    "details_json" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "state_events_entity_type_entity_id_created_at_idx" ON "state_events"("entity_type", "entity_id", "created_at");
CREATE INDEX "state_events_correlation_id_idx" ON "state_events"("correlation_id");
CREATE INDEX "state_events_to_state_idx" ON "state_events"("to_state");

-- ------------------------------------------------------------ task_runs (extend)
-- MD §9.4: batch/identity lineage + lease/heartbeat. All nullable (or
-- defaulted) — pre-existing rows are untouched.
ALTER TABLE "task_runs" ADD COLUMN "batch_id" UUID;
ALTER TABLE "task_runs" ADD COLUMN "identity_id" UUID;
ALTER TABLE "task_runs" ADD COLUMN "lease_owner" TEXT;
ALTER TABLE "task_runs" ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6);
ALTER TABLE "task_runs" ADD COLUMN "heartbeat_at" TIMESTAMPTZ(6);
-- Columnized max_attempts for batch runs (MD §9.4). inputJson.maxAttempts
-- remains the runtime source for pre-existing ad-hoc runs (untouched data).
ALTER TABLE "task_runs" ADD COLUMN "max_attempts" INT NOT NULL DEFAULT 3;

ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "task_runs_batch_id_idx" ON "task_runs"("batch_id");
CREATE INDEX "task_runs_identity_id_idx" ON "task_runs"("identity_id");
CREATE INDEX "task_runs_lease_expires_at_idx" ON "task_runs"("lease_expires_at");
