-- R4 (2026-10-20): persist the per-check breakdown (MD §6.2).
--
-- net_last_checks — the LAST verification pass's control/data-plane check
--                  outcomes as FLAT machine-readable values only
--                  (PASS/FAIL/UNKNOWN, alive/dead, up/down/missing,
--                   enforced/broken/unknown, tunnel/direct). buildNetPayload
--                  projects this into the `checks{binary,process,interface,
--                   routePolicy,tcpCanary}` view (API/worker/UI — one
--                  calculation, one schema).
--
-- Additive only (nullable; existing rows read as unknown). Never stores a
-- proxy URL or credential — the values are status vocabulary, not
-- topology (MD §6.2 "不得把實際代理 URI、用戶名、密碼或 token 放在 health
-- payload").

-- AlterTable
ALTER TABLE "devices" ADD COLUMN "net_last_checks" JSONB;
