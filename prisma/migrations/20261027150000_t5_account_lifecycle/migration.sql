-- T5 (ADR-030): Gmail account lifecycle (sibling machine to login_state) +
-- transition audit + encrypted credential vault + provisioning throttle.
-- ADDITIVE ONLY: nothing dropped/renamed; login_state (T2) untouched.

-- 1) account lifecycle row per identity (one pipeline per identity)
CREATE TABLE "account_lifecycles" (
  "id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PREPARING',
  "state_since" TIMESTAMP(3),
  "current_step" TEXT,
  "awaiting_deadline_at" TIMESTAMP(3),
  "intervention_id" UUID,
  "failure_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "account_lifecycles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_lifecycles_identity_id_key" ON "account_lifecycles"("identity_id");
CREATE INDEX "account_lifecycles_state_idx" ON "account_lifecycles"("state");
ALTER TABLE "account_lifecycles" ADD CONSTRAINT "account_lifecycles_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) transition audit (who / when / why; detailsJson = scrubbed reason codes)
CREATE TABLE "account_lifecycle_audits" (
  "id" UUID NOT NULL,
  "lifecycle_id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "from_state" TEXT NOT NULL,
  "to_state" TEXT NOT NULL,
  "actor_user_id" UUID,
  "actor_kind" TEXT NOT NULL DEFAULT 'system',
  "reason_code" TEXT,
  "details_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_lifecycle_audits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "account_lifecycle_audits_identity_id_created_at_idx" ON "account_lifecycle_audits"("identity_id", "created_at");
ALTER TABLE "account_lifecycle_audits" ADD CONSTRAINT "account_lifecycle_audits_lifecycle_id_fkey"
  FOREIGN KEY ("lifecycle_id") REFERENCES "account_lifecycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) credential vault (AES-256-GCM ciphertexts; masked columns only readable shape)
CREATE TABLE "gmail_accounts" (
  "id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "email_masked" TEXT,
  "email_cipher" TEXT,
  "password_cipher" TEXT,
  "recovery_email_cipher" TEXT,
  "recovery_email_masked" TEXT,
  "profile_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gmail_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gmail_accounts_identity_id_key" ON "gmail_accounts"("identity_id");
ALTER TABLE "gmail_accounts" ADD CONSTRAINT "gmail_accounts_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) provisioning throttle counters (per scope per UTC day + global interval stamp)
CREATE TABLE "gmail_provision_counters" (
  "id" UUID NOT NULL,
  "scope_key" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "last_started_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gmail_provision_counters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gmail_provision_counters_scope_key_day_key" ON "gmail_provision_counters"("scope_key", "day");
