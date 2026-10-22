# BR-Acceptance C — Live Egress Kernel-Layer Verification (scratch harness)

Verifies, with live isolated evidence, the runbook §10.9 residual risk and a
tested fail-closed isolation strategy:

- **C3 (baseline, no host rules):** tunnel up → device egress crosses the
  proxy (canary sees the gost src IP); **tunnel dead → app-style sockets fall
  through to the eth0/docker-bridge direct path (canary sees the device src
  IP = fail-open proof)**; proxy dead → proxy path dead, shadow intact;
  recovery → proxy path restored.
- **C4 (fail-closed):** the device subnet rides a Docker **`--internal`**
  network; re-run tunnel-dead / proxy-dead → canary receives **zero direct**
  connections during the fault windows; proxy path still works; recovery
  clean. (The stronger per-counter nft variant is
  `nft-failclosed-template.nft` — root-only, NOT executed by this harness:
  the service user has no CAP_NET_ADMIN; documented, not inferred.)

## Hard scope (boss-approved 2026-10-22 13:14)
- Only `br-b6e-*` containers/networks and this test's traffic are touched.
- Never: global firewall policy, default routes, SSH, other docker networks,
  SGLang (127.0.0.1:30000), `water-army-*` compose services, ports 15000-15999.
- No host port listeners at all (canary/gost listen on container-local
  163xx/1080; probes ride the device netns via one-shot sidecar containers).

## Files
| file | purpose |
|---|---|
| `common.sh` | helpers: pinned digests, net plan, the EXACT platform netcheck script (`buildT2sNetcheckScript`), netns-sidecar netcheck/probe, canary markers |
| `01-snapshot-pre.sh` | C1: read-only pre-state snapshot (nft/iptables/docker nets/routes/addr/30000/sshd/uptime) → `$EGRESS_OUT` (workspace logs, not repo) |
| — | C2/C3/C4 were executed as **documented interactive sequences** (gen1/gen2), not standalone scripts — exact commands + full evidence: workspace `logs/br-b6-egress/acceptance.md` §7 + `waterarmy-br-accC-progress.md`. (A 02/03/04/05 standalone script set was planned in commit 989b708's README but not materialized; honest record.) |
| `rollback.sh` | C5: scoped teardown (`br-b6e-*` only) + rollback verification vs pre-snapshot (gen2: `$E`→`$EGRESS_OUT` unbound-var fix; image sweep = tag + build manifest) |
| `canary.py` + `canary.Dockerfile` | **active** in-canary protocol-aware python3 TCP logger (src-IP discriminator, CONNECT/HTTP/raw → 200 OK responder); gen2 2026-10-22: CONNECT branch also captures the tunneled request so probe tags land in the log |
| `canary.sh` | legacy busybox-nc connection logger (superseded by canary.py; kept for reference — alpine 3.20 `nc -t` absent, timeout-wrapper note inside) |
| `t2s-run.sh` | tunnel runner executed INSIDE the device netns (repo `buildTunnelSetupScript` sequence; gost-target = container IP; documents kill-semantics + the rtnetlink pre-create no-op on containerized netns) |
| `sidecar.Dockerfile` | `br-b6e-sidecar:egress` (alpine:3.20 + iproute2) — root-free netns/pidns join stand-in |
| `nft-failclosed-template.nft` | root-only per-counter variant (NOT executed by the harness) |

## Layout (scratch)
- `br-b6e-open` 172.39.200.0/24 (C3): `br-b6e-dev1` + `br-b6e-gost1` + `br-b6e-can1` (172.39.200.10:16370)
- `br-b6e-sec` 172.39.201.0/24 **internal** + `br-b6e-canary` 172.39.202.0/24 (C4): `br-b6e-dev2` (sec) + `br-b6e-gost2` (sec+canary) + `br-b6e-can2` (172.39.202.10:16370)
- device = `water-army/redroid@sha256:5912…43b55` (matrixa-r3, pinned), privileged, 2GiB/2vCPU, nvidia (gpu_mode=host) — boot completing is NOT expected (SGLang GPU saturated); netns wiring exists from container start → kernel-layer target is valid pre-boot (honest label: netns-layer verification).
- gost = `gogost/gost@sha256:f7a9…b7580` (pinned), upstream = the canary.
- tunnel = repo `buildTunnelSetupScript` sequence, verbatim, run in the device netns; only the gost target differs (container IP instead of the gateway host-publish — documented deviation, kernel semantics identical).

## Evidence
All logs/evidence land in the workspace (gitignored):
`/home/kenneth/.openclaw/workspace/logs/br-b6-egress/` — final report:
`acceptance.md` (per-scenario PASS/FAIL/SKIPPED/BLOCKED + evidence paths +
commands + rollback proof). The repo carries only this harness + the
runbook §10.9 addendum.
