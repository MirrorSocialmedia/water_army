-- W1 (ADR-025, 2026-10-26): identity-level device fingerprint profile — ADDITIVE-ONLY.
--
-- Adds:
--   - identity_fingerprints table (1:1 with identities; DB-unique guards on
--     fingerprint/serial/displayId = fail-closed fleet collision enforcement)
--   - devices.identity_id (nullable, FK SET NULL) + devices.ro_overrides_json
--     (snapshot of the EXACT merged prop map injected at create)
--   - redroid_templates.ro_overrides (JSONB, default '{}' = today's behaviour)
--   - 2 indexes (devices.identity_id, identity_fingerprints(brand,model))
--
-- ZERO behaviour change on existing rows: every new column is nullable or has
-- a default equal to current behaviour; no existing column/constraint is
-- touched. The runtime switch (WA_REDROID_RO_OVERRIDES_ENABLED, default false)
-- keeps injection OFF until ADR-025 V3 real-device verification passes.

-- AlterTable: redroid_templates
ALTER TABLE "redroid_templates" ADD COLUMN "ro_overrides" JSONB NOT NULL DEFAULT '{}';

-- AlterTable: devices
ALTER TABLE "devices" ADD COLUMN "identity_id" UUID;
ALTER TABLE "devices" ADD COLUMN "ro_overrides_json" JSONB NOT NULL DEFAULT '{}';

-- CreateTable: identity_fingerprints
CREATE TABLE "identity_fingerprints" (
    "identity_id" UUID NOT NULL,
    "profile_json" JSONB NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "android_release" TEXT NOT NULL,
    "build_id" TEXT NOT NULL,
    "display_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "carrier_name" TEXT NOT NULL,
    "carrier_mcc" TEXT NOT NULL,
    "carrier_mnc" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_fingerprints_pkey" PRIMARY KEY ("identity_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identity_fingerprints_display_id_key" ON "identity_fingerprints"("display_id");
CREATE UNIQUE INDEX "identity_fingerprints_fingerprint_key" ON "identity_fingerprints"("fingerprint");
CREATE UNIQUE INDEX "identity_fingerprints_serial_key" ON "identity_fingerprints"("serial");
CREATE INDEX "identity_fingerprints_brand_model_idx" ON "identity_fingerprints"("brand", "model");
CREATE INDEX "devices_identity_id_idx" ON "devices"("identity_id");

-- AddForeignKey
ALTER TABLE "identity_fingerprints" ADD CONSTRAINT "identity_fingerprints_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
