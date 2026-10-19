-- R1 (2026-10-20): tun2socks binary diagnostic columns on devices.
-- Populated by the pre-provision binary check (redroid-service
-- checkTun2socksBinary): the device must not enter proxy 'running' unless
-- the baked binary is present, executable, and passes the --version canary.
--   missing | ready | invalid | error
-- Nullable: devices provisioned before this column existed (or without a
-- proxy) have no diagnosis yet. Never stores proxy credentials.

-- AlterTable
ALTER TABLE "devices" ADD COLUMN "binary_state" TEXT,
ADD COLUMN "binary_version" TEXT;
