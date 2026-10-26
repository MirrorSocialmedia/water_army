-- W3 (ADR-027, 2026-10-26): identity-level PINNED EGRESS — ADDITIVE-ONLY.
--
-- Adds:
--   - identity_egress_bindings table (1:1 with identities): the pinned
--     egress expectation per identity. proxy_url_encrypted = the identity's
--     egress proxy (AES-256-GCM, same codec as Stage B redroid proxies —
--     ciphertext at rest; the W3 runtime path never decrypts it).
--     expected_egress_ip = the ONE exit IP this identity is allowed to exit
--     from (DB-unique: two identities must never share an exit IP —
--     correlation killer). proxy_url_hash = sha256 of the plaintext URL
--     (one-way; change detection only — preimage resistant).
--   - devices: the device egress state machine columns
--     (egress_state + since/checked/last-match timestamps + failure counter
--      + last error code + last OBSERVED ip — observed ip is egress
--      metadata, never a credential).
--   - 1 index (identity_egress_bindings.identity_id PK covers the join).
--
-- ZERO behaviour change on existing rows:
--   - identity_egress_bindings is a new table (empty at migration time);
--     no existing row references it.
--   - every new devices column is nullable or has a default equal to the
--     inert state (egress_state = 'UNCHECKED' = "no W3 verdict yet";
--     counters 0; timestamps null; codes null).
--   - no existing column/constraint/index is touched.
-- The runtime switch (WA_W3_EGRESS_BINDING_ENABLED, default false) keeps
-- W3 OFF until ADR-027's real-device verification matrix passes; with the
-- switch OFF, every new column stays at its default and the dispatch gate
-- ignores egress entirely (byte-identical behaviour to pre-W3).

-- CreateTable: identity_egress_bindings
CREATE TABLE "identity_egress_bindings" (
    "identity_id" UUID NOT NULL,
    "proxy_url_encrypted" TEXT NOT NULL,
    "proxy_url_hash" TEXT NOT NULL,
    "expected_egress_ip" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "first_verified_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_egress_bindings_pkey" PRIMARY KEY ("identity_id")
);

-- One exit IP per identity fleet-wide (the correlation killer).
CREATE UNIQUE INDEX "identity_egress_bindings_expected_egress_ip_key" ON "identity_egress_bindings"("expected_egress_ip");

-- AddForeignKey (identity is deleted → its binding disappears; devices are
-- unaffected — their identity_id is SET NULL by the W1 constraint, and the
-- watchdog re-derives UNBOUND on the next tick).
ALTER TABLE "identity_egress_bindings" ADD CONSTRAINT "identity_egress_bindings_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: devices (the egress state machine — inert defaults)
ALTER TABLE "devices" ADD COLUMN "egress_state" TEXT NOT NULL DEFAULT 'UNCHECKED';
ALTER TABLE "devices" ADD COLUMN "egress_state_since" TIMESTAMP(3);
ALTER TABLE "devices" ADD COLUMN "egress_checked_at" TIMESTAMP(3);
ALTER TABLE "devices" ADD COLUMN "egress_last_match_at" TIMESTAMP(3);
ALTER TABLE "devices" ADD COLUMN "egress_consecutive_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "devices" ADD COLUMN "egress_last_error_code" TEXT;
ALTER TABLE "devices" ADD COLUMN "egress_last_observed_ip" TEXT;
