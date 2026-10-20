# R5 Live Evidence — Redroid / Binder / ADB / Docker / GPU 啟動驗收 (2026-10-20)

Platform facts carried in (R3/R4 live-proven, NOT re-tested here):
- GPU host mode works: RTX 3090 ×2, driver 580.178.04, nvidia runtime present;
  redroid `gpuMode=host` boots ~2 min + full chain HEALTHY.
- `swiftshader_indirect` does NOT boot on this host (surfaceflinger EGL crash
  loop; R3 crash buffer in `../r3-20261020/`).
- Host persisted (Stage A): `/etc/modules` binder_linux, `/etc/fstab` binderfs,
  `/var/lib/water-army`.
- Fleet image `water-army/redroid:14.0.0-240527-matrixa-r3` (pinned tun2socks
  2.7.0 baked + /usr/local/bin fallback).

## §7.1 Host preflight (productized — `apps/api/src/cli/preflight.js`)
Live run on the test host (read-only; never mutates host):
```
  PASS  docker-daemon      docker daemon answered ping
  PASS  binder-module      binder_linux loaded
  PASS  binderfs-mount     /dev/binder is a binderfs mount
  PASS  shared-memory      memfd available (kernel 6.8)
  PASS  kernel-compat      kernel 6.8.0-117-generic (x86_64) — meets the redroid floor
  PASS  adb-exposure       no non-loopback listener in 15000-15999 (host scan)
  PASS  data-volume        /var/lib/water-army/redroid writable, 1100 GiB free
  WARN  gpu-visibility     nvidia-smi: NVIDIA GeForce RTX 3090 ×2, driver 580.178.04
verdict: WARN  (binder=true, docker=up)
```
- GPU stays WARN by design (MD §2.4): nvidia-smi visibility ≠ Android render
  proven. `--fail-on-warn` → exit 1 (strict CI gate); plain → exit 0.
- Range-aware: with `REDROID_ADB_RANGE_START/END=16200/16299`, the live
  127.0.0.1:16200 listener is scanned and correctly NOT flagged (loopback).
- Vantage honesty: from a container, host-namespace items report WARN/UNKNOWN,
  never false.
- Preflight is a WARNING input, not the verdict — device create/start still
  proceeds (MD §2.3).

## §7.2 Fresh Redroid validation (isolated: `redroid-matrix-r5-*` + own volume)
Device `redroid-matrix-r5-fresh`, image fleet r3, ADB 127.0.0.1:16200,
dataDir `/var/lib/water-army/redroid-r5/redroid-matrix-r5-fresh`.

1. Fresh container boot → `sys.boot_completed=1` (~24 min cold first boot).
2. `getprop` collected (getprop-fresh.txt): Android 14 / SDK 34 /
   `redroid/redroid_x86_64` / `ro.boot.redroid_gpu_mode=host`.
3. ADB local secure connect (127.0.0..1:16200, loopback only).
4. Real APK: F-Droid client 2.0.2 installed, `am start` →
   `org.fdroid.fdroid/org.fdroid.MainActivity`, `POST_NOTIFICATIONS` dismissed,
   process + focused window confirmed.
5. Persistence: marker written to `/data/local/tmp/r5-persist.txt` →
   stop → recreate same volume → read back OK; F-Droid still installed.
6. **Resource limits (product gap fixed in R5)**: `RedroidTemplate` now has
   nullable `cpuLimit` / `memoryLimitBytes` (NULL = unlimited). Live:
   `docker inspect` after recreate →
   `Privileged=true Memory=4294967296 NanoCpus=2000000000` +
   `DeviceRequests=[{Driver:"nvidia",Count:-1}]` (see limits-docker-inspect.txt).
   Migration `20261020235900` (nullable, existing rows unaffected).
7. **Incompatible env → clear error, no infinite retry** (bad-image-negative.txt):
   bad pinned tag → device create fails fast `DOCKER_ERROR (HTTP 404) No such
   image`, no retry loop. (R3 boot-timeout fail-closed evidence is in
   `../r3-20261020/`.)

## §7.3 Network & security isolation (audit + fix)
- ADB bind: `127.0.0.1:16200` only (docker port + preflight exposure scan),
  never 0.0.0.0.
- Docker socket: `/var/run/docker.sock` `srw-rw---- root docker` (NOT 666);
  only the api service mounts it (read-only) + `/var/lib/water-army` rw.
- Container allowlist already enforced: `isManaged()` (app.managed label /
  admin exception); `routes/containers.js` → 403 NOT_MANAGED + audit.
- Shell-injection audit (redroid path): no `shell: true`; ADB via
  fixed-binary `execFile` argv; in-container scripts only run unit-tested
  builder output with integer-port validation.
- Preflight is read-only: never installs/mounts/opens ports/touches volumes.

## §7.4 GPU acceptance (measured, not configured-as-success)
- Host: `nvidia-smi` → RTX 3090 ×2, driver 580.178.04
  (host-nvidia-smi.txt, gpu-card-mapping.txt).
- **In-device render path is real hardware**: SurfaceFlinger (pid 593) holds
  7 open fds on `/dev/dri/renderD128`; `renderD128` device = PCI 10DE:2204
  = RTX 3090 #0 (gpu-fd-root.txt, gpu-card-mapping.txt).
- logcat (gpu-logcat.txt): `SurfaceFlinger: Enabling backpressure for GPU
  composition` + `RenderEngine: RenderEngine with GLES Backend` + libEGL_mesa
  loaded.
- nvidia-smi during render (gpu-util-during-render.txt): GPU0 37% while SF
  composited the app (GPU1 97% = SGLang user service, NOT ours).
- `screencap` → 1080×1920 RGBA PNG (screencap-fdroid.png) = real composited
  frame.
- `gpuStatus` semantics: stays `unverified`/`software` until the in-device
  render check passes; config alone never flips it.

### Platform finding (live, R5) — PATCH default clobber
A partial `PUT /api/redroid/templates/:id` (e.g. `{fps:60}`) silently reset
`gpuMode→swiftshader_indirect` + `privileged→false`: AJV applied the
create-schema `default`s to absent PATCH fields, and the service merge then
wrote them. Audit trail showed `changed:[...,gpuMode,privileged,...]` on a
2-field patch. Consequence observed live: a recreated device came up
`Privileged=false` → `redroid-binder-init: mount binderfs ... Operation not
permitted` (exit 126). **Fixed in R5**: `TEMPLATE_PATCH_BODY` strips `default`
so absent stays absent; regression locked in
(`tests/integration/redroid-resource-limits.test.js`).

## §7.5 Test-host protection
Pre-flight verified ports/volumes/containers/GPU (SGLang + 5-container compose
stack). All R5 work under `redroid-matrix-r5-*` + isolated
`/var/lib/water-army/redroid-r5` volume. Zero unapproved stop/modify of user
services. ADB spike range 162xx (16200); forbidden ranges untouched.

## Live finding (R5) — recreated-container adbd host-protocol stall
After the §7.2.6 delete+recreate (2nd cycle, limits in place), the Android
framework booted fully (`sys.boot_completed=1`, apps running, marker
persisted — see final-assert.txt) but **adbd stopped answering the adb host
protocol**: raw TCP to 127.0.0.1:16200 and direct to the container IP:5555
accept the connection, `HOST:version` gets zero bytes for 30+s; adbd logs
show the transport registered then immediately offline; `ro.adb.secure=0`;
adbd main loop in epoll (not hard-blocked).
Recovery attempts (all failed): `setprop ctl.restart adbd`, full container
restart via the API (boot completed again <1 min). The product's own
diagnostics correctly reported `containerState=running` +
`adbState=offline` (honest state, no false positive).
ADB worked earlier in the same session on the original fresh boot (getprop,
install, screencap evidence) and after stop/start, so this is a
recreate-specific container-runtime quirk, not a product regression.
**R6 hardening candidate**: health path "booted but adb offline" → bounded
adbd restart before declaring the device unhealthy (and/or root-cause the
redroid image adbd auth relay on recreate).
