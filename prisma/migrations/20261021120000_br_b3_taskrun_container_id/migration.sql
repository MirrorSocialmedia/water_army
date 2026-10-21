-- BR-B3 (Batch Rotation Phase 3, MD §9.4): additive-only migration.
-- Extends: task_runs (+1 nullable column "container_id" + 1 index).
--
-- container_id = the Docker container id the batch run owns (written by the
-- B3 lifecycle service at create time, cleared/kept at terminal). It is the
-- DB HALF of the MD §4.3 double-ownership check: the other half is the
-- container's com.mirrorsocialmedia.water-army.* labels. An operation is
-- accepted only when BOTH agree — a mismatch is rejected
-- (CONTAINER_OWNERSHIP_MISMATCH), never "fixed" in place.
--
-- Drops nothing, alters no existing column, rewrites no data (MD §9:
-- additive only). Second `migrate deploy` is a no-op.

ALTER TABLE "task_runs" ADD COLUMN "container_id" TEXT;
CREATE INDEX "task_runs_container_id_idx" ON "task_runs"("container_id");
