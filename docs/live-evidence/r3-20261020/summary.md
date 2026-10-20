# R3 Phase 3 — LIVE verification evidence (2026-10-20, gen3)

Host: runc (NO gVisor runtime installed — R2's "gVisor stall" attribution is
mechanism-level wrong; the empirical TCP-stall observation from R2's spike
environment was not reproduced on the real app chain on this host).
Image: `water-army/redroid:14.0.0-240527-matrixa-r3` (rebuild of the repo
Dockerfile — the in-fleet `matrixa-r1` predated the R2 fallback
`/usr/local/bin/tun2socks` COPY and was missing the binary live).
GPU: host (RTX 3090 passthrough) — required: the swiftshader_indirect template
crash-loops surfaceflinger (no GL implementation) and never boots.

## Result: full-chain HEALTHY achievable on this host (canary PASSES)

The on-device canary passes through the REAL chain
(device tun0 → tun2socks → socks5 172.17.0.1:16095 (mock) → gost :20080 →
socks5 16095 → canary 172.17.0.1:16090, nonce+sha256 echo), so the designed
terminal for this host is HEALTHY — and every fail-closed behavior was still
exercised and asserted per episode below.

## Phase outcomes (driver: /tmp/r3-live2.mjs, state /tmp/r3-live-state.json)

| phase | timeline | assertions passed |
|---|---|---|
| create | 09:12:40 STARTING → 09:13:02 VERIFYING (tunnel-process-up) → 09:13:03 HEALTHY (verification-passed) — 23s create-to-HEALTHY | binary check (fallback /usr/local/bin/tun2socks + self-heal canonical), canary PASS latency 1000ms, networkReady=true, stale=false |
| A | kill t2s 10:00:43 → **BLOCKED +2s** (cf=2, TUNNEL_PROCESS_DEAD, definite→immediate BLOCKED) → backoff anchor 30s → recovery 10:01:15 → HEALTHY 10:01:19.973 (37s episode) | exactly 1 recovery attempt (API-log delta), legacy `proxy.state=error` while BLOCKED (no fail-open 'running' projection), t2s resurrected, recoveries heal-reset to 0 |
| B | canary-down (t2s alive) 10:02:45 → **DEGRADED cf=1 CANARY_FAIL** → canary-up → HEALTHY 10:02:48.5 (3s each way) | failure-family classification (verification ≠ process-death), checkedAt advancing, **recoveries stays 0** (no spurious re-provision on verification-only failure), cf reset + lastCanary=PASS on legit heal |
| C | kill → BLOCKED 10:09:20 (anchor armed) → foreign lock injected (owner=r3-lock-test, until+120s, anchor forced expired) → 45s window: state BLOCKED stable, rec=0, owner NOT overwritten, anchor NOT re-armed, cf 2→32 (ticks live) → lock cleared → **recovery 10:10:06.899 (+1.9s)** → HEALTHY | recovery lock discipline (no double-trigger, no overwrite, deterministic anchor), exactly 1 recovery across the episode |
| D | kill → BLOCKED 10:17:19 (anchor=10:17:49) → pre-restart row captured → SIGTERM API (pid 5041, exit <1s) → new API (pid 25772) 10:17:25 → **row restored byte-for-byte at +2s incl. anchor (not re-armed)** [D1] → anchor expired 10:17:49 → **new pid 25772 fired attempt=1 at 10:17:50.095 (+1.1s)** → re-provision → HEALTHY 10:18:0x | persistence across restart: state/recoveries/manual/anchor all from DB; recovery fired BY THE NEW PROCESS from the persisted anchor (zero in-memory state) |

## Recovery episode ledger (all exactly-one attempt=1, per-episode counter, heal-resets to 0)

| t (UTC) | api pid | trigger |
|---|---|---|
| 09:27:44.085 | 47751 | early malformed-kill episode (driver quoting bug; kill still landed) |
| 09:43:04.292 | 47751 | pkill self-match repro (rc=137 side-effect kill) |
| 09:48:09.005 | 47751 | killT2s helper validation kill |
| 09:50:21.111 | 47751 | kill-by-pid validation kill |
| 10:00:18.495 | 47751 | killtest.mjs final validation kill |
| 10:01:15.527 | 47751 | **Phase A** (kill 10:00:43 + 30s base anchor) |
| 10:07:02.281 | 47751 | Phase C false-red residue: lock lease (until 10:07:01) expired → +1.3s recovery = lease auto-release proof |
| 10:10:06.899 | 47751 | **Phase C** (lock cleared 10:10:05 → +1.9s) |
| 10:17:50.095 | **25772 (new process)** | **Phase D** (anchor 10:17:49 expired → +1.1s, post-restart) |

## Driver-observed platform facts (R4 inputs)

- `psql -tA` on the postgres:17.6 image prints **pipe-separated** fields (not tabs).
- `pkill -f` inside the redroid container SIGKILLs its own exec shell (rc=137) — kill by `pidof` + numeric `kill -9` instead.
- `sh -c '... $(...) ...'` passed through `sg -c "..."` expands command
  substitution ON THE HOST (empty → silent no-op kill) — avoid `$( )` in
  device-side one-liners; fetch values host-side and inject numerics.
- `proxy.network` view field is `networkReady` (not `ready`); legacy
  projection is `proxy.state` (not `proxyState`).
- `netRecoveries` is a **per-episode** counter: reset to 0 on every HEALTHY
  (persistNet: `to==='HEALTHY'` branch); stall/max budget applies per episode.
- Manual retry (`POST /proxy/retry`) resets the episode (recoveries:=0,
  immediate attempt, bypasses backoff) — MD §5.4.6 manual door.
- Idempotency replay footgun (Stage B, pre-existing): a create idempotency
  key is not invalidated on device delete → within the 600s TTL a re-create
  with the same key replays the DELETED device id (create 200, GET 404).
