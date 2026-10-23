-- MC P1 (Mobile Console MD §4.1/§8.1, ADR-019 §19.11): additive-only migration.
--
-- Adds: stream_leases table + 3 indexes + 1 PARTIAL UNIQUE INDEX.
--   - stream_leases = per-viewer-session stream lease (PG = source of truth).
--   - partial unique index: ONE active lease per device (MVP-strict, MD §4.1
--     "MVP 可更嚴格地限制每設備一個 viewer session") — the DB constraint is
--     the concurrency guard for same-device double-acquire (2nd inserter gets
--     23505 → STREAM_DEVICE_HELD).
--   - The GLOBAL 5-slot cap is NOT a table here: it reuses resource_leases
--     (resourceType='stream_slot', unique [resource_type, resource_key]
--     already exists) via createLeaseService.acquireSlot — no new constraint.
--
-- Drops nothing, alters no existing column, rewrites no data (MD §9:
-- additive only). Re-run is a no-op (migrate deploy tracks the dir).

CREATE TABLE "stream_leases" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "device_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "version" INTEGER NOT NULL DEFAULT 1,
  "slot_index" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_heartbeat_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "closed_at" TIMESTAMP(3),
  "close_reason" TEXT,
  "correlation_id" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stream_leases_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "stream_leases_device_id_status_idx" ON "stream_leases"("device_id", "status");
CREATE INDEX "stream_leases_status_expires_at_idx" ON "stream_leases"("status", "expires_at");
CREATE INDEX "stream_leases_user_id_idx" ON "stream_leases"("user_id");

-- One active lease per device (PENDING or ACTIVE). Terminal rows (CLOSED/
-- EXPIRED/INTERRUPTED) never block a new acquire on the same device.
CREATE UNIQUE INDEX "stream_leases_device_active_ux"
  ON "stream_leases"("device_id")
  WHERE "status" IN ('PENDING', 'ACTIVE');
