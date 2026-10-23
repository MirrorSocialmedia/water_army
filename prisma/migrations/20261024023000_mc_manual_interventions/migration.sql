-- MC P4 (Mobile Console MD Phase 4 / §6/§9): additive-only migration.
--
-- Adds:
--   - manual_interventions table (human-intervention event; MD §6.2 schema)
--   - manual_intervention_history table (append-only transition/audit trail)
--   - 4 indexes + 1 PARTIAL UNIQUE INDEX (the dedupe open-episode race guard)
--
-- Design (MD §6.3):
--   - ONE open episode per device+category+source. The partial unique index
--     on (dedupe_key) WHERE status IN ('open','acknowledged','in_progress')
--     is the DB-level race guard: under concurrent signals exactly one creator
--     wins, the loser gets 23505 → refetch + re-escalate (no oversubscribe,
--     no notification storm). Terminal rows (resolved/dismissed) leave the
--     window, so a LATER signal creates a NEW episode — a stale late signal
--     can never auto-reopen a terminal event (MD §6.3).
--   - device_id is a nullable FK (ON DELETE SET NULL): when a device row is
--     removed the event is KEPT and stays readable via device_name_snapshot
--     (MD §6.2 "設備已移除時保留可讀的 deviceNameSnapshot").
--   - version = CAS counter for the operator state machine (ack/assign/
--     resolve/dismiss/reopen) — every transition is a single-statement
--     updateMany carrying the expected version + status (MD §6.2/§9.6 style).
--
-- Secrets: none stored in plaintext. title/summary/evidence are scrubbed by
-- the writer (scrubObject) before insert; evidence holds only redacted
-- summaries + event ids + error codes — never screen pixels, full logcat,
-- cookies, passwords or proxy URLs (MD §6.2/§13).
--
-- Drops nothing, alters no existing table, rewrites no data (MD §9:
-- additive only). Re-run is a no-op (migrate deploy tracks the dir).

CREATE TABLE "manual_interventions" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "device_id" UUID,
  "device_name_snapshot" TEXT,
  "source" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'warning',
  "status" TEXT NOT NULL DEFAULT 'open',
  "automation_disposition" TEXT NOT NULL DEFAULT 'not_applicable',
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "evidence" JSONB,
  "heuristic" BOOLEAN NOT NULL DEFAULT false,
  "signal_count" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "resolution_summary" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "acknowledged_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "assignee_user_id" UUID,
  "dedupe_key" TEXT NOT NULL,
  "related_task_run_id" UUID,
  CONSTRAINT "manual_interventions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "manual_interventions_status_severity_updated_at_idx" ON "manual_interventions"("status", "severity", "updated_at");
CREATE INDEX "manual_interventions_device_id_status_category_idx" ON "manual_interventions"("device_id", "status", "category");
CREATE INDEX "manual_interventions_assignee_user_id_idx" ON "manual_interventions"("assignee_user_id");

-- Dedupe open-episode race guard (MD §6.3). Only non-terminal (open-episode)
-- rows participate; a resolved/dismissed row never blocks a new episode.
CREATE UNIQUE INDEX "manual_interventions_dedupe_open_ux"
  ON "manual_interventions"("dedupe_key")
  WHERE "status" IN ('open', 'acknowledged', 'in_progress');

CREATE TABLE "manual_intervention_history" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "intervention_id" UUID NOT NULL,
  "from_status" TEXT,
  "to_status" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actor_user_id" UUID,
  "note" TEXT,
  "details_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manual_intervention_history_intervention_id_fkey" FOREIGN KEY ("intervention_id") REFERENCES "manual_interventions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "manual_intervention_history_intervention_id_created_at_idx" ON "manual_intervention_history"("intervention_id", "created_at");
