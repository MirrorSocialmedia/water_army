-- Stage B (2026-10-19): per-device egress proxy (gost + tun2socks).
-- Template: optional fleet egress proxy URL, stored encrypted at rest
-- (AES-256-GCM, provider-key pattern). Device: per-device binding —
-- proxy override (encrypted), dedicated gost host port (unique, range
-- 20080–20179, bound to 172.17.0.1), and proxy state machine
-- (off|provisioning|running|stopped|error).

-- AlterTable
ALTER TABLE "redroid_templates" ADD COLUMN "proxy_url_encrypted" TEXT;

-- AlterTable
ALTER TABLE "devices" ADD COLUMN "proxy_url_encrypted" TEXT,
ADD COLUMN "gost_port" INTEGER,
ADD COLUMN "proxy_state" TEXT NOT NULL DEFAULT 'off';

-- CreateIndex
CREATE UNIQUE INDEX "devices_gost_port_key" ON "devices"("gost_port");
