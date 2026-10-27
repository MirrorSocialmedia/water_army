-- T2 (ADR-029): identity login state machine + transition audit + explicit
-- identity<->dataDir ownership claim. ADDITIVE ONLY: no dropped/renamed
-- columns, existing rows get the default login state (PENDING_LOGIN = 待登入).

-- 1) identities: login state columns
ALTER TABLE "identities" ADD COLUMN "login_state" TEXT NOT NULL DEFAULT 'PENDING_LOGIN';
ALTER TABLE "identities" ADD COLUMN "login_state_since" TIMESTAMP(3);
CREATE INDEX "identities_login_state_idx" ON "identities"("login_state");

-- 2) transition audit (who / when / evidence)
CREATE TABLE "identity_login_audits" (
  "id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "from_state" TEXT NOT NULL,
  "to_state" TEXT NOT NULL,
  "actor_user_id" UUID,
  "evidence_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_login_audits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "identity_login_audits_identity_id_created_at_idx" ON "identity_login_audits"("identity_id", "created_at");
ALTER TABLE "identity_login_audits" ADD CONSTRAINT "identity_login_audits_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) identity <-> dataDir ownership claim (explicit contract, ADR-029)
CREATE TABLE "identity_data_dir_claims" (
  "id" UUID NOT NULL,
  "data_dir" TEXT NOT NULL,
  "identity_id" UUID NOT NULL,
  "device_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "identity_data_dir_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "identity_data_dir_claims_data_dir_key" ON "identity_data_dir_claims"("data_dir");
CREATE UNIQUE INDEX "identity_data_dir_claims_identity_id_key" ON "identity_data_dir_claims"("identity_id");
ALTER TABLE "identity_data_dir_claims" ADD CONSTRAINT "identity_data_dir_claims_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
