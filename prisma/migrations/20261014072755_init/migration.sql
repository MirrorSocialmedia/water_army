-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "TaskRunStatus" AS ENUM ('queued', 'running', 'needs_approval', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'timed_out', 'skipped');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'viewer',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_configs" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider_type" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "model_id" TEXT,
    "encrypted_api_key" TEXT,
    "timeout_ms" INTEGER NOT NULL DEFAULT 120000,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "capabilities_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_definitions" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "task_type" TEXT NOT NULL DEFAULT 'ai',
    "provider_config_id" UUID NOT NULL,
    "prompt_template" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'analysis_only',
    "input_schema_json" JSONB,
    "output_schema_json" JSONB,
    "timeout_ms" INTEGER NOT NULL DEFAULT 120000,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "concurrency_key" TEXT,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_runs" (
    "id" UUID NOT NULL,
    "task_definition_id" UUID,
    "schedule_id" UUID,
    "status" "TaskRunStatus" NOT NULL DEFAULT 'queued',
    "input_json" JSONB,
    "result_json" JSONB,
    "result_text" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "queued_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "requested_by" UUID,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_run_events" (
    "id" UUID NOT NULL,
    "task_run_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "message" TEXT,
    "payload_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "task_definition_id" UUID NOT NULL,
    "schedule_type" TEXT NOT NULL,
    "cron_expression" TEXT,
    "interval_ms" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Taipei',
    "overlap_policy" TEXT NOT NULL DEFAULT 'skip_if_running',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "bullmq_scheduler_id" TEXT,
    "sync_status" TEXT NOT NULL DEFAULT 'synced',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "task_run_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments_json" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "request_id" TEXT,
    "ip" TEXT,
    "status" TEXT,
    "details_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_configs_name_key" ON "provider_configs"("name");

-- CreateIndex
CREATE INDEX "task_definitions_provider_config_id_idx" ON "task_definitions"("provider_config_id");

-- CreateIndex
CREATE INDEX "task_definitions_created_by_idx" ON "task_definitions"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "task_runs_idempotency_key_key" ON "task_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "task_runs_status_idx" ON "task_runs"("status");

-- CreateIndex
CREATE INDEX "task_runs_created_at_idx" ON "task_runs"("created_at");

-- CreateIndex
CREATE INDEX "task_runs_schedule_id_idx" ON "task_runs"("schedule_id");

-- CreateIndex
CREATE INDEX "task_runs_task_definition_id_idx" ON "task_runs"("task_definition_id");

-- CreateIndex
CREATE INDEX "task_runs_requested_by_idx" ON "task_runs"("requested_by");

-- CreateIndex
CREATE INDEX "task_run_events_task_run_id_created_at_idx" ON "task_run_events"("task_run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_name_key" ON "schedules"("name");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_bullmq_scheduler_id_key" ON "schedules"("bullmq_scheduler_id");

-- CreateIndex
CREATE INDEX "schedules_is_enabled_idx" ON "schedules"("is_enabled");

-- CreateIndex
CREATE INDEX "schedules_task_definition_id_idx" ON "schedules"("task_definition_id");

-- CreateIndex
CREATE INDEX "approval_requests_task_run_id_idx" ON "approval_requests"("task_run_id");

-- CreateIndex
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_created_at_idx" ON "audit_events"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_resource_type_resource_id_idx" ON "audit_events"("resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_definitions" ADD CONSTRAINT "task_definitions_provider_config_id_fkey" FOREIGN KEY ("provider_config_id") REFERENCES "provider_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_definition_id_fkey" FOREIGN KEY ("task_definition_id") REFERENCES "task_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_run_events" ADD CONSTRAINT "task_run_events_task_run_id_fkey" FOREIGN KEY ("task_run_id") REFERENCES "task_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_task_definition_id_fkey" FOREIGN KEY ("task_definition_id") REFERENCES "task_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
