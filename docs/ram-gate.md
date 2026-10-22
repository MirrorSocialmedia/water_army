# Host-RAM Admission Gate (RAM-G1)

**Status:** implemented (2026-10-22) · **Owner:** CTO (Kairo) · **Source of truth:** boss MD 2026-10-22 23:21 + 拍板 23:33 (baseline target 30 GB)

A product-grade admission gate that decides — **atomically, fail-closed** — whether the host has enough RAM to boot one more redroid device / batch container. Inserted at the **existing** boot decision points (redroid create/start, batch start); it is not a new boot path.

---

## 1. Why

The A10 real-device measurement (2026-10-22 morning, `docs/audits/ramgate-baseline.md` §A3/A10) showed 10 settled redroid devices land host MemAvailable at **16 819 MiB — only 435 MiB above the 16 GiB red line**. Nothing before G1 stopped an 11th/12th boot: the scheduler, the worker and the UI each booted blindly. The gate makes "can we boot one more?" a **single authoritative, atomic, fail-closed decision** shared by every boot path.

**SGLang coexistence constraint (hard):** the two `sglang::scheduler_TP0/TP1` processes + detok + launch + torch-inductor workers hold ~55–66 GiB of host RSS **constantly** (KV cache preallocated — static between idle and inference). That is a fixed overhead; the gate's budget math is only ever about the *redroid fleet* on top of it. The gate never touches SGLang.

---

## 2. Constants (initial, config-tunable)

| Name | Default | Meaning | Provenance |
|---|---|---|---|
| `maxParallel` | `10` | fleet cap: live leases (devices + batch runs) + this boot ≤ 10 | boss MD |
| `hardFloorMiB` | `16384` | MemAvailable hard floor — a boot that would land below this is refused | 16 GiB red line; A10 10-device settle = 16 819 MiB |
| `postBootTargetMiB` | `18432` | **initial conservative** post-boot budget target (18 GiB). Not a universal optimum — tune from measurement (boss MD 拍板 23:33). At 30 GB baseline this admits ≤ 9 devices (10th → projected 28 800−12 000 = 16 800… see §4 note) | conservative start |
| `perBootBudgetMiB` | `1200` | RAM charged per boot | A10 real: settled ≈ 934 MiB/device, incremental 5→10 ≈ 1 093 MiB → conservative integer 1200 |
| `metricsMaxAgeMs` | `30000` | a `/proc/meminfo` sample older than this is **stale → deny** | fail-closed requirement |
| `leaseTtlMs` | `86400000` (24 h) | backstop TTL on every lease; reconcile renews live ones | crash-recovery backstop |

Config precedence (every decision re-reads, live):
1. env `RAM_GATE_*` (operator override — `RAM_GATE_ENABLED`, `RAM_GATE_MAX_PARALLEL`, `RAM_GATE_HARD_FLOOR_MIB`, `RAM_GATE_POST_BOOT_TARGET_MIB`, `RAM_GATE_PER_BOOT_BUDGET_MIB`, `RAM_GATE_METRICS_MAX_AGE_MS`, `RAM_GATE_LEASE_TTL_MS`)
2. AppSetting `ram_gate.config` (UI/editable, merge semantics — partial PUTs keep other keys)
3. the constants above.

Invalid config → **fail closed** (`CONFIG_INVALID`), never silent defaults.

---

## 3. Admission math (per boot, before ANY side effect)

```
current    = fresh MemAvailable (MiB) from /proc/meminfo, timestamped
liveLeases = live RAM leases in the store (device + run, atomic count)
projected  = current − (liveLeases + 1) × perBootBudgetMiB

ADMIT  iff  (liveLeases + 1) ≤ maxParallel
       AND  current   ≥ hardFloorMiB
       AND  projected ≥ postBootTargetMiB
else DENY with the first failing reason (precedence:
     MAX_PARALLEL > BELOW_HARD_FLOOR > PROJECTED_BELOW_TARGET)
```

* The entity's **own** pre-existing lease is excluded from the count (retry/idempotent re-admit does not self-deadlock at the cap), but the projection still charges `(others + 1) × budget`.
* `reservations` in the boss formula are exactly the live-lease budget sum — a lease IS a reservation.

Worked example at the 30 GB baseline (`current ≈ 30 183 MiB`, 9 leases live):
10th boot → `projected = 30 183 − 10×1200 = 18 183 < 18 432` → **DENIED PROJECTED_BELOW_TARGET** (cap and floor pass). The 10th boot is admitted once `current ≥ 30 432 MiB` (e.g. 30 661 → projected 18 661). That is the conservative initial posture — the knob to relax is `postBootTargetMiB`, and only after measurement.

---

## 4. Store & atomicity (design choice: Redis, not Postgres)

**Chosen: Redis + Lua** (the stack already runs redis; the port-lease service uses the same shape).

Why not Postgres atomic increment:
* the gate's unit of work is *check many keys + write one key + update a set* — that is one Lua script, not a row increment;
* leases need **TTL** as the crash backstop — Redis `PEXPIRE` is native; a Postgres column would need a sweeper for the same job;
* the admit decision must be **uninterruptible** across processes (API + N workers). A Lua script is the only single-statement primitive redis offers; Postgres would need a per-entity advisory-lock table (same complexity, weaker TTL story, and a write to the hot business DB on every boot decision).

Scripts (all in `packages/shared/src/ram-gate.js`, zero npm deps):

| Script | Does |
|---|---|
| `ADMIT_LUA` | reads metrics age + live set + candidate lease; re-validates config numbers in-script; **admits and writes the lease in one atomic step** (excludes the caller's own lease from the count); returns `[admitted, reason, liveCount, projectedMiB, admissionId]` |
| `DRY_RUN_LUA` | same validation, **no write** — powers "next boot admitted?" in the UI |
| `RELEASE_LUA` | owner-checked release: only deletes the lease whose `admissionId` matches (a stale stop can never kill a fresh lease for the same entity) |
| `RELEASE_BY_KEY_LUA` | authority release (reconcile/lifecycle that lack the admissionId) |
| `RENEW_LUA` | extends TTL (restart/reconcile-live) |
| `COUNT_LUA` | live count for status |

Keys: `ramgate:live` (set), `ramgate:metrics` (latest sample + ts), `ramgate:decisions` (bounded ring, 300), `ramgate:lease:<kind>:<entity>` (`kind` ∈ `device`|`run`).

### Fail-closed matrix (the gate never defaults to yes)

| Condition | Result |
|---|---|
| metrics unreadable / `MemAvailable` missing | DENY `METRICS_UNAVAILABLE` |
| metrics sample age > `metricsMaxAgeMs` | DENY `METRICS_STALE` |
| redis error / `eval` unavailable at decision time | DENY `STORE_UNAVAILABLE` (route surfaces 409/503 retryable) |
| config invalid | DENY `CONFIG_INVALID` |
| malformed request | DENY `INVALID_INPUT` |
| `RAM_GATE_ENABLED=false` (explicit) | bypass, every decision labelled `GATE_DISABLED` (dev/test escape hatch only) |

**Memory-pressure behaviour (boss hard lines):** stop **new** boots only; pending work stays queued; **never** delete Identity dataDir; **never** kill other containers; **never** touch SGLang.

---

## 5. Leases & crash recovery

A lease = "this entity is committed to one `perBootBudgetMiB`".

* `kind=device`, key = device name — held from create/start until stop/delete.
* `kind=run`, key = task-run id — held from batch start until stop/remove.
* Restart **renews** (one container = one lease; no RAM growth) — no double count.

**Reconcile** (every 5 min automatically + admin `POST /api/system/ram-gate/reconcile`):

| Lease ↔ entity state | Action |
|---|---|
| lease present, entity **gone** (stopped/terminal/deleted) | **release** |
| lease present, entity live/booting | **renew** TTL |
| entity entitled (device in `running/created/provisioning/paused`; run `status=running` + `containerId`) but **no lease** (redis flush shape) | **recover** — unconditional create, because it is *already* consuming RAM |

TTL (24 h) is the backstop: even if the reconciler never runs, a crashed holder's lease self-expires and stops blocking the fleet.

**Worker kill:** a killed worker's leases stay until reconcile (≤ 5 min) or TTL; the worker itself holds no independent reservation — all admissions go through the API-side gate, so a dead worker can never own an unreleased reservation. Restart recovery is exactly the reconcile table above (lease-expiry + reconcile = the two mandatory recovery tests, both covered).

---

## 6. Where it is inserted (no new boot stove)

| Path | File | Point | Denial surfaces as |
|---|---|---|---|
| redroid device create | `apps/api/src/services/redroid-service.js` `createDevice` | **before** dataDir/DB row/docker create | `409 RAM_GATE_DENIED` (+ reason in message; audit row) |
| redroid device start | same, `runDeviceAction('start')` | before docker start | `409 RAM_GATE_DENIED` |
| redroid restart | same | renew only | — |
| redroid stop/delete | same | release after success | — |
| batch container start | `apps/api/src/services/batch-lifecycle-service.js` `startForRun` | after identity-creatable check, **before** port lease + docker | `503 RAM_GATE_DENIED` (retryable → worker `RETRY_WAIT`; pending kept; nothing created/deleted) |
| batch stop/remove | same | release after success | — |

On create-denial the rollback path releases any half-taken resources; on start-denial there is simply nothing to roll back (admission is the first side effect).

**Construction:** the gate is built **only when redis has `eval()`** (real ioredis). Hermetic test fakes lack it → gate null → boot paths behave exactly as pre-G1 (the documented zero-regression isolation). Production: always on unless `RAM_GATE_ENABLED=false`.

**Periodic jobs** (unref'd): metrics publish every 5 s (so status/age is always visible), reconcile every 5 min.

---

## 7. API (admin-only)

| Route | Purpose |
|---|---|
| `GET /api/system/ram-gate` | status: `enabled`, effective `config`, `metrics` (fresh sample + age + stale flag), `counts` (`liveLeases`, `running`, `inProgress`, `reservedMiB`), `wouldAdmitNext` (`admitted`, `reason`, `projectedMiB`), `store.redis` |
| `GET /api/system/ram-gate/decisions?limit=30` | decision trail (admit/deny/release/recover with reason, current/projected MiB, source) |
| `PUT /api/system/ram-gate/config` | operator policy (validated; partial merge; audited) |
| `POST /api/system/ram-gate/reconcile` | force reconcile (returns released/renewed/recovered/errors) |

Error envelope: 409/503 `RAM_GATE_DENIED` with the stable reason code in `message`; 503 `RAM_GATE_UNAVAILABLE` only when the gate cannot be constructed at all (hermetic fakes).

## 8. UI (display-only — backend authoritative)

`RAM Gate` page (admin nav): live MemAvailable + sample age, 16 GiB hard floor, 18 GiB target, per-boot budget, max parallel, running (DB view) + live leases/reserved, **"next boot admitted?"**, decision trail table, policy form (PUT) and force-reconcile. Polls 10 s. The UI never decides — it renders `GET /api/system/ram-gate`.

---

## 9. Safety invariants (encoded, not aspirational)

1. Never deletes an Identity dataDir — not on denial, not on pressure, not on reconcile.
2. Never kills any container other than the caller's own lifecycle target.
3. Never stops/restarts/reconfigures SGLang (or its torch workers).
4. Denial = stop new boots; pending work stays queued.
5. Admission + reservation is one atomic Lua step — no TOCTOU between check and reserve.
6. Owner-checked release — a stale stop cannot delete a fresh lease.
7. Fail-closed everywhere: missing/stale metrics, store failure, invalid config, computation error → deny.

## 10. Tests

* `tests/unit/ramgate-core.test.js` — meminfo parsing, sample fail-closed, config resolution, admission math (14)
* `tests/unit/ramgate-service.test.js` — gate service C1–C7 + disabled/invalid/status/release (16)
* `tests/integration/ramgate-redroid.test.js` — HTTP-level device path: create admitted/denied (zero side effects on denial), floor/projection/metrics denials, lease lifecycle (stop/start/restart/delete) (7)
* `tests/integration/ramgate-batch-routes.test.js` — HTTP-level batch path: start/stop lease, cap & projection denials (retryable), fail-closed reasons, RBAC, status shape, config PUT, reconcile (9)
* `tests/helpers/ramgate-fake-redis.js` — 1:1 JS emulation of the 6 Lua scripts (atomicity unit stand-in; lazy TTL expiry, injectable clock)

Phase C evidence: `docs/audits/ramgate-scenarios.md` (8 scenarios, expected/actual, saved output) + full regression + one real-device boot (`br-b6g-s1 @16400`) with teardown.

## 11. Files

```
packages/shared/src/host-metrics.js        # /proc/meminfo + loadavg reader (zero deps)
packages/shared/src/ram-gate.js            # constants, config, math, Lua, createRamGate
packages/shared/src/index.js               # exports
apps/api/src/services/ram-gate-service.js  # API glue: config source, entity state, running count, decisions ring+audit, periodic jobs
apps/api/src/routes/system-ram-gate.js     # admin routes
apps/api/src/app.js                        # construction (redis-eval gated) + wiring
apps/api/src/services/redroid-service.js   # device create/start/stop/restart/delete gate points
apps/api/src/services/batch-lifecycle-service.js  # batch start/stop/remove gate points
apps/web/src/pages/RamGate.jsx             # admin UI (display-only)
apps/web/src/api/client.js                 # put()
apps/web/src/router.js / App.jsx / layouts/AppLayout.jsx  # page registration
tests/unit/ramgate-core.test.js · tests/unit/ramgate-service.test.js
tests/integration/ramgate-redroid.test.js · tests/integration/ramgate-batch-routes.test.js
tests/helpers/ramgate-fake-redis.js · tests/helpers/redroid-fakes.js (extraAppOpts seam)
docs/audits/ramgate-baseline.md            # Phase A evidence
scripts/ramgate-g1/sglang-rss-sample.sh    # A3 sampler
```

No DB migration (existing tables + AppSetting + redis only). No new npm deps.
