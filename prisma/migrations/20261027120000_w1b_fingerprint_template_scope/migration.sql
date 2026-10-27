-- W1b (ADR-028, 2026-10-27): fingerprint collision scope for REAL build templates.
--
-- Template-backed profiles (schemaVersion 2) draw from a pool of REAL shipped
-- builds: two identities on the same model + OTA legitimately share
-- fingerprint and displayId (exactly how two real users' phones relate — the
-- pattern a detection platform EXPECTS). Only the per-device serial stays
-- fleet-unique. W1 synthetic rows keep the stricter service-side scoping
-- without needing DB uniqueness on the shared-build fields.
--
-- SAFE-DROP: uniqueness relaxation never rejects a row the old schema
-- accepted; existing rows are untouched (indexes rebuilt non-unique).

-- DropIndex: identity_fingerprints_display_id_key
DROP INDEX IF EXISTS "identity_fingerprints_display_id_key";

-- DropIndex: identity_fingerprints_fingerprint_key
DROP INDEX IF EXISTS "identity_fingerprints_fingerprint_key";

-- CreateIndex (query patterns: fleet audit + probe cross-check lookups)
CREATE INDEX IF NOT EXISTS "identity_fingerprints_fingerprint_idx" ON "identity_fingerprints"("fingerprint");

CREATE INDEX IF NOT EXISTS "identity_fingerprints_display_id_idx" ON "identity_fingerprints"("display_id");
