# R4 Phase 4 — LIVE verification evidence (2026-10-20)

Scope: MD §6 — proxyState / API / worker / UI state consistency (P0). R4's job was to
project the R3 authoritative state core (`redroid-health.js` state machine +
`net_*` DB persistence) onto every boundary (API payload, worker gate, UI text,
audit) and prove it live on a real container.

Host: runc, RTX 3090×2 (driver 580.178.04), GPU = **host** passthrough
(swiftshader_indirect crash-loops surfaceflinger on this host — R3 finding,
unchanged). Image: `water-army/redroid:14.0.0-240527-matrixa-r3`.
binder: loaded (`/etc/modules` + `/etc/fstab` persist).

## Isolated R4 live environment (zero compose-stack / zero forbidden-port touch)

| component | where | port(s) |
|---|---|---|
| postgres 17.6 (`r4-pg`, db `wa_r4`, user `app`) | docker container | 127.0.0.1:16543 |
| redis (`r4-redis`) | docker container | 127.0.0.1:16379 |
| API host process (`node apps/api/src/server.js`) | nohup setsid | 127.0.0.1:16300 |
| web SPA (S5 UI rebuild) | static serve | 127.0.0.1:16310 |
| mock-socks5 (proxy leg) | node | 172.17.0.1:16095 |
| mock-echo (canary target) | node | 172.17.0.1:16090 |
| device `redroid-matrix-r4-live` (adb) | redroid container | 127.0.0.1:16100 |
| gost (device→proxy bridge) | redroid-gost container | 172.17.0.1:20080 |

Device: `redroid-matrix-r4-live`, adbPort 16100, gost 20080, gpuMode=host,
BOOT_TIMEOUT 2400000, ADB binary `/home/kenneth/.openclaw/workspace/tools/platform-tools/adb`
(R3 live env used the same; host has no `/usr/bin/adb`).

## Result: full lifecycle observed UI-visible, all boundaries consistent

Two live drivers ran the same physical device:
- `stage2` (API-level episodes + worker-gate assertions) — `evidence-stage2.json`, `timeline.jsonl`
- `ui-episode` (browser-driven, text-verified screenshots) — `evidence-ui-episode.json`, `01..06*.png`

### Episode 1 — boot → HEALTHY (fresh `/data`)
create → STARTING → VERIFYING (tunnel-process-up) → **HEALTHY** (verification-passed).
All 5 checks PASS, `networkReady=true`, `stale=false`, legacy `proxy.state=running`.
Worker gate (service-token `redroid.get_device_status`): `dispatch=ALLOWED`.

### Episode 2 — kill tun2socks → BLOCKED → recovery → HEALTHY (hard failure)
kill → **BLOCKED +~2s** (cf=1, `TUNNEL_PROCESS_DEAD`, definite-loss → immediate
BLOCKED, threshold bypass). UI text badge: **"BLOCKED (hard failure —
fail-closed)"**, dispatch=BLOCKED, checks `process=FAIL interface=FAIL
routePolicy=FAIL tcpCanary=UNKNOWN`. Worker gate: **`dispatch=BLOCKED`**
(network task dispatch deterministically refused). Legacy projection:
`proxy.state=error` (fail-closed — never 'running' while not HEALTHY).
Recovery (10s backoff anchor): BLOCKED → STARTING (recovery-reprovision) →
VERIFYING → **HEALTHY** (verification-passed), cf reset 0, legacy back to
`running`. Worker gate: `dispatch=ALLOWED`.

### Episode 3 — canary-down (t2s ALIVE) → DEGRADED → heal (soft failure)
kill mock-echo (canary target 16090), t2s still running → **DEGRADED cf=1**
(`CANARY_FAIL`, checks `tcpCanary=FAIL canary FAIL:dns-ok-tcp-fail`, everything
else PASS). UI text badge: **"DEGRADED (partial — canary failing)"**,
dispatch=BLOCKED. Worker gate: `dispatch=BLOCKED`. Heal (canary-up) → **HEALTHY**
(cf 0). **`recoveries` stayed 0** — verification-only failure does NOT trigger a
re-provision (R3 Phase B semantics, live-confirmed). Legacy: `stopped` while
DEGRADED, `running` after heal.

### UI-visible state (MD §6.3: 文字 not just 顏色; never old green badge)
DeviceDetail Network card renders the authoritative `net.state` as text with a
per-state label, the 5 checks (binary/process/interface/routePolicy/tcpCanary)
each PASS/FAIL/UNKNOWN, checkedAt/lastSuccessfulCheckAt, lastErrorCode,
`dispatch` (worker signal), and a manual `Network retry` button on
FAILED|BLOCKED|DEGRADED. Devices list shows the same state column.
Screenshots (text-asserted before capture, so no false positives):
- 01-healthy.png, 02-blocked-post-kill.png, 03-healthy-after-recovery.png,
  04-degraded-canary.png, 05-healthy-final.png, 06-devices-list.png

### Audit (MD §6.3: deviceId + from + to + reason + time + trigger source + task id)
Every `persistNet` transition writes `redroid.device.net_transition` with
`resourceId`=deviceId, `details.{from,to,reason,source,errorCode,
consecutiveFailures,recoveries,relatedTaskId}`. `relatedTaskId` is `null` for
device-level network events (honest value — no associated task run). Sample
(`audit-net-events.txt`): `HEALTHY→BLOCKED definite-loss:TUNNEL_PROCESS_DEAD
source=watchdog`, `BLOCKED→STARTING recovery-reprovision`, `STARTING→VERIFYING
tunnel-process-up source=provision`, `VERIFYING→HEALTHY verification-passed`,
`HEALTHY→DEGRADED consecutive-failures:1/2 error_code=CANARY_FAIL`.
`redroid.device.net_check_failed` rows carry `code/state/detail` with **no
proxy URI / credential** (detail is process/iface/route/rule/effective +
canary reason only).

## Live-found issues (all env/ops, NOT product regressions — fixed in env, documented for R5)

1. **Stale Prisma client after schema change (R4-introduced, caught live).**
   The `net_last_checks` column was added by migration `20261020201500_r4_net_last_checks`
   (applied via `prisma migrate deploy`), but the *generated* Prisma client in
   `node_modules/.prisma` was still built from the pre-R4 schema. The success
   path (`verifyNow` → persist HEALTHY with `netLastChecks`) threw
   `Invalid prisma.device.update() invocation` and the device was stuck in
   VERIFYING, re-trying every 5s tick. **Fix: `npx prisma generate` + API
   restart** → device self-healed to HEALTHY on the next tick.
   **For R5/deploy:** any schema change requires `prisma generate` in the
   running image (the compose Dockerfile does this; host-process deploys do
   not). The unit/integration suites use a fake in-memory DB, so they cannot
   catch a stale generated client — only a real-DB live run can.
2. **`WORKER_API_TOKEN` must be ≥32 chars.** `service-auth.js` treats a
   configured-but-short token as *not configured* (fail-closed → 401). The R4
   env token was 22 chars → all worker-gate calls 401. Lengthened to 39 chars.
3. **Origin guard requires `APP_PUBLIC_URL` = the UI origin.** The API's
   CSRF origin guard only allows mutating browser requests whose `Origin`
   matches `APP_PUBLIC_URL` (+ api loopback). The UI is served from :16310
   but the API defaulted `APP_PUBLIC_URL` to its own :16300 → browser login
   403 (curl, no Origin, was fine). Set `APP_PUBLIC_URL=http://127.0.0.1:16310`.
   In compose the web origin must be exported the same way.

## Cleanup
Completed after capture: 0 containers (r4-pg, r4-redis, device, gost removed),
0 host processes (API, web, mock-socks5, mock-echo killed), 0 ports bound on the
16xxx range. (See final report / progress log.)
