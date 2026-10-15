# P5 Live Evidence Index (2026-10-15, this host)

All artifacts captured live during P5 acceptance. Reproduction commands in
`docs/architecture-decisions.md` §14.8 and `logs/waterarmy-p5-progress.md`.

## Hard-acceptance 1 — real preflight on this host

| file | what |
|------|------|
| `01-real-preflight.json` | `GET /api/redroid/preflight` via the PRODUCTION compose stack (real adapter, `NODE_ENV=production`): kernel `6.8.0-117-generic`, `binder_linux: absent`, `ashmem_linux: absent`, all device nodes absent, dmesg EPERM reported honestly, data root absent, `overall: "unsupported"` + warnings + suggestions |
| `02-prod-ui-devices.png` | Production UI Devices page: preflight banner shows the REAL result (`unsupported`, binder/ashmem absent) + explicit "this host cannot run real Redroid" explanation; empty device list; seeded templates visible in the create form |

## Hard-acceptance 2 — mock lifecycle

| file | what |
|------|------|
| `03-mock-create-swiftshader.json` | `POST /api/devices/redroid` (mock adapter, dev instance): created → running, `adbBind: "127.0.0.1"`, `adbPort: 15000`, `gpuMode: swiftshader_indirect`, `gpuStatus: "software"`, response carries the (mock-labelled) preflight + zero startError |
| `03b-mock-create-gpu.json` | privileged template device: `gpuMode: host` → `gpuStatus: "unverified"` (never fake-verified), next port 15001 |
| `05-mock-diag-running.json` | 4-zone diagnostics while running (kernel supported+mock-labelled / logs ok / adb online @127.0.0.1:15000 / gpu software) |
| `05c-mock-diag-stopped.json` | after `stop`: containerState `exited`, adb zone `executed:false → unverified` with the explicit note — never a fake pass; `restart` returns it to online |
| (tests) `tests/integration/redroid-lifecycle.test.js` | full create→start→stop→restart→delete state machine + adb port collision → next port + exhausted range 503 + data dir volume assertions + delete removes container (data dir kept unless removeData) — 30/30 |
| (db) audit trail | `audit_events`: redroid.device.create ×2 / diagnostics ×5 / logcat ×3 / stop ×1 / restart ×1 — every mutation audited |

## Hard-acceptance 3 — 127.0.0.1 enforcement

- both create responses: `adbBind: "127.0.0.1"` (server constant, no client input path exists)
- `04-mock-injection-400.json`: client attempts to inject `hostConfig.PortBindings["5555/tcp"] = 0.0.0.0` and `privileged:true` → **400** `must NOT have additional properties`
- unit/integration: HostIP asserted on the recorded docker create call; whitelist target regex rejects localhost/::1/0.0.0.0/public

## Hard-acceptance 4 — zero arbitrary shell

- `POST /api/devices/redroid/:id/exec` does not exist → **404** (integration test)
- `04-mock-injection-400.json` (same file — the create-side proof)
- unit (14 cases): ops outside the whitelist (`shell`, `pm list`, …) → 400; injection in name/property (`;`, `$(`, backtick, space) → 400; fixed binary path; no `shell` option exists in the engine

## Hard-acceptance 5 — output caps

| file | what |
|------|------|
| `06-mock-logcat-cap.json` | `GET .../logcat?tail=999999` → effective `tail: 5000` (server-side clamp to `redroidLogcatTailMax`), `tailCap: 5000` |
| `06b-mock-logcat-default.json` | default tail 200; `lines: 200`; `mayHaveMore: true` (buffer has more beyond the window — disclosed, not faked) |
| `07-mock-ui-logcat.png` | UI logcat view: "200 line(s) of tail 200 (cap 5000) — the buffer may hold older lines beyond this window" |
| (test) byte cap | 5000 lines × 100B → 256KB byte cap truncation + `truncated: true` (integration, mock 6000-line buffer + huge-line case) |

## Hard-acceptance 6 — GPU honesty

| file | what |
|------|------|
| `05b-mock-diag-gpu.json` | host-mode device diagnostics: `gpuVerification.status: "unverified"` + MD §2.4 note ("DeviceRequests are configured but no in-device render check exists in P5") |
| `02-prod-ui-devices.png` / `03-mock-create-swiftshader.json` | UI/API show `software / 降級` for swiftshader and `未驗證 (unverified)` for host — verbatim backend status, no prettier word |
| (test) | mock adapter can never emit `verified` (asserted in the mock-honesty test) |

## Hard-acceptance 7 — suite + repo hygiene

- full suite: **423 tests / 422 pass / 0 fail / 0 cancelled / 1 skipped** (gated live-redis)
- `vite build` green (304KB bundle) — this repo is JavaScript-only (P4 precedent: "tsc 0" ≡ build gate)
- secret scan over the P5 diff: zero hits
- worker container: **0 mounts** (no docker socket); api container: docker.sock read-only only
- P0–P4 delivered files: zero behavior changes (app.js/config.js purely additive; the only P4-file touches are the test-harness fix documented in ADR §14.9)
