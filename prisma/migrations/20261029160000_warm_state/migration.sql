-- WA-WARMING: identity cookie-warming lifecycle (Google/FB 防封门槛).
-- ADDITIVE ONLY. Backfill discipline (work order): EXISTING identities are
-- grandfathered to 'warm' (zero disruption — today's fleet has already been
-- in service); the column DEFAULT 'cold' applies to NEW registrations only
-- (identity provision creates without warmState => cold).

ALTER TABLE "identities" ADD COLUMN "warm_state" TEXT NOT NULL DEFAULT 'cold';
ALTER TABLE "identities" ADD COLUMN "warm_started_at" TIMESTAMP(3);
ALTER TABLE "identities" ADD COLUMN "warm_ready_at" TIMESTAMP(3);

-- Grandfather the existing fleet (rows that existed BEFORE this ALTER carry
-- the applied default 'cold' — every row at migration time is pre-existing).
UPDATE "identities"
  SET "warm_state" = 'warm', "warm_ready_at" = now()
  WHERE "warm_state" = 'cold';

CREATE INDEX "identities_warm_state_idx" ON "identities"("warm_state");
