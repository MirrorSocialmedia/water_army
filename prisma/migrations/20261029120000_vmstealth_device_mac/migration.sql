-- WA-VMSTEALTH (S2): planned per-device MAC (phone-vendor OUI pool).
-- NULL = pre-feature device / no plan (docker default 02:42:* stays).
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "mac_address" TEXT;

-- Fleet-wide uniqueness: the plan step excludes taken MACs; this is the
-- hard backstop (two concurrent creates can never share a MAC).
CREATE UNIQUE INDEX IF NOT EXISTS "devices_mac_address_key" ON "devices" ("mac_address");
