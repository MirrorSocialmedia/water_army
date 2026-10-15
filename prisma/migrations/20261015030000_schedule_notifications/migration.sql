-- CreateTable
CREATE TABLE "schedule_notifications" (
    "id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_notifications_run_id_key" ON "schedule_notifications"("run_id");

-- CreateIndex
CREATE INDEX "schedule_notifications_schedule_id_idx" ON "schedule_notifications"("schedule_id");

-- CreateIndex
CREATE INDEX "schedule_notifications_is_read_created_at_idx" ON "schedule_notifications"("is_read", "created_at");
