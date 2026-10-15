-- CreateTable
CREATE TABLE "redroid_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "android_version" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1080,
    "height" INTEGER NOT NULL DEFAULT 1920,
    "dpi" INTEGER NOT NULL DEFAULT 440,
    "fps" INTEGER NOT NULL DEFAULT 30,
    "gpu_mode" TEXT NOT NULL DEFAULT 'swiftshader_indirect',
    "privileged" BOOLEAN NOT NULL DEFAULT false,
    "privileged_reason" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "redroid_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" UUID NOT NULL,
    "adb_port" INTEGER NOT NULL,
    "data_dir" TEXT NOT NULL,
    "container_name" TEXT NOT NULL,
    "container_id" TEXT,
    "image" TEXT NOT NULL,
    "android_version" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "dpi" INTEGER NOT NULL,
    "fps" INTEGER NOT NULL,
    "gpu_mode" TEXT NOT NULL,
    "container_state" TEXT NOT NULL DEFAULT 'unknown',
    "adb_state" TEXT NOT NULL DEFAULT 'unknown',
    "gpu_status" TEXT NOT NULL DEFAULT 'unknown',
    "last_diagnosed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "redroid_templates_name_key" ON "redroid_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "devices_name_key" ON "devices"("name");

-- CreateIndex
CREATE UNIQUE INDEX "devices_adb_port_key" ON "devices"("adb_port");

-- CreateIndex
CREATE INDEX "devices_template_id_idx" ON "devices"("template_id");

-- CreateIndex
CREATE INDEX "devices_container_state_idx" ON "devices"("container_state");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "redroid_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
