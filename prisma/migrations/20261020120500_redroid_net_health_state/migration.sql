-- R3 (2026-10-20): per-device network health state — the fail-closed
-- watchdog (MD Phase 3) needs its state to SURVIVE container + API
-- restarts. The in-memory state is only the hot path; these columns are
-- the source of truth, written exclusively through the audited
-- persistNet() transition path (redroid-service.js).
--
-- Semantics (MD §5.2/§5.4):
--   net_state               — STOPPED|STARTING|VERIFYING|HEALTHY|DEGRADED|
--                             BLOCKED|FAILED. Default 'STOPPED' = no claim
--                             (legacy devices without a proxy are inert).
--   net_state_since         — when the current state began (auditability).
--   net_checked_at          — last watchdog verification attempt (any leg).
--   net_last_success_at     — last verified-pass timestamp (staleness TTL
--                             anchor: HEALTHY older than the TTL = stale).
--   net_consecutive_failures— per-leg fail counter (resets on any PASS;
--                             DEGRADED at 1, BLOCKED at the threshold).
--   net_last_error_code     — code of the last failing leg (zero-secret:
--                             never the proxy URL).
--   net_last_error_detail   — clipped (<=300 chars) scrubbed detail.
--   net_last_canary         — last canary outcome line (pass/fail reason).
--   net_recoveries          — auto-recovery attempts in the CURRENT
--                             episode (budget counter; resets on HEALTHY /
--                             manual retry).
--   net_last_recovery_at    — last recovery attempt start.
--   net_next_recovery_at    — the persisted backoff anchor: the next auto
--                             attempt may not start before this instant
--                             (deterministic + crash-safe; null = no
--                             schedule; manual retry clears it).
--   net_manual_intervention — FAILED sink flag (MD §5.4.6): true = a human
--                             must act (operator retry / stop / delete).
--   net_recovery_lock_owner — cross-process recovery lease owner (holder
--                             id; the lock makes re-provision single-flight
--                             even with multiple API instances).
--   net_recovery_lock_until — lease expiry (expired lease = free).
--
-- Never stores proxy credentials. Additive only (nullable / safe
-- defaults) — existing rows read as STOPPED/inert.

-- AlterTable
ALTER TABLE "devices" ADD COLUMN "net_state" TEXT NOT NULL DEFAULT 'STOPPED',
ADD COLUMN "net_state_since" TIMESTAMP(3),
ADD COLUMN "net_checked_at" TIMESTAMP(3),
ADD COLUMN "net_last_success_at" TIMESTAMP(3),
ADD COLUMN "net_consecutive_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "net_last_error_code" TEXT,
ADD COLUMN "net_last_error_detail" TEXT,
ADD COLUMN "net_last_canary" TEXT,
ADD COLUMN "net_recoveries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "net_last_recovery_at" TIMESTAMP(3),
ADD COLUMN "net_next_recovery_at" TIMESTAMP(3),
ADD COLUMN "net_manual_intervention" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "net_recovery_lock_owner" TEXT,
ADD COLUMN "net_recovery_lock_until" TIMESTAMP(3);
