# gms-mtg-oemprop-stealth2 — build record (WA-STEALTH-FIX2 s3)

- **Date**: 2026-10-29 (build entry `bash images/gms-mtg-oemprop-stealth2/build.sh`)
- **Final tag**: `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth2` (image id `6e31ac98e143`)
- **Base**: `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth`
  (`sha256:86e823fa67ccf07df125aa2cb1403ebf65a442ecfc6f3c8265d2a1a75fde970b`) — fleet stealth tag, untouched (零破壞).

## What this layer changes (and WHY this layer — T2 lesson)

`/vendor/bin/gpu_config.sh` — the redroid host-GPU probe is the ONLY setter of
`ro.hardware.vulkan` (s1 real-device proof: `getprop | grep` + init/rc/build.prop
search; fx-1 showed `radeon` while the template carrier
`ro.boot.oem_ro_hardware_vulkan=lvp` sat UNCONSUMED — the ro first-write race is
won by this script, so env/carrier/template-override layers CANNOT move it).
stealth2 forces all 7 setter branches (i915/amdgpu/virtio/broadcom/msm/panfrost
+ the pastel software path) to `lvp`:

- Vulkan HAL = `vulkan.lvp.so` (lavapipe, already in the base with its
  deviceName C-string patched to `Adreno (TM) 644` by the stealth layer).
- Effect: vulkan-facing renderer string is host-INDEPENDENT and phone-plausible
  (`Adreno (TM) 644`) on every machine, instead of `radeon`/`intel`/`pastel`
  per host GPU.
- GLES (WebView `WEBGL_debug_renderer_info` unmaskedRenderer) remains host Mesa
  passthrough (`AMD Radeon Graphics (radeonsi, …)`) = **wave-2 KNOWN LIMITATION**
  candidate per s1 ruling — only fixable via an ANGLE-enabled/debuggable WebView
  build; NOT claimed as fixed (boss拍板).
- **Canvas** hash determinism per s1: fx-1 hash was IDENTICAL to the adv fleet
  (engine-level determinism proven) — the fleet-vs-fleet variance is host Mesa /
  driver versions (cross-host only). **KNOWN LIMITATION, boss拍板 — not fixed here.**

## Inputs (all sha256-pinned, fail-closed)

| Input | sha256 |
|---|---|
| base `/vendor/bin/gpu_config.sh` (extracted) | `86812ee33d1fa0…` |
| committed artifact `gpu_config-stealth2.sh` (deterministic sed, 7/7 → lvp) | `13f9f12de21caa…` |
| inherited patched `vulkan.lvp.so` (asserted present, old deviceName absent) | `9886119a1556e4…` |

Transform determinism: build.sh regenerates the sed from the base extraction and
`cmp`s the committed artifact — base drift breaks the build LOUD.

## Post-build assertions (GREEN, no boot — docker create/cp + export tar)

- `/vendor/bin/gpu_config.sh` byte-identical to the artifact; mode `0755` owner
  `0:0` (verified via `docker export | tar -tv` — note: rootless `docker cp`
  normalizes uid to 1000 = harness artifact, not image truth).
- patched lavapipe sha pin + byte searches (`Adreno (TM) 644` present,
  `llvmpipe (git-53e769e0f1)` absent).
- old tags untouched; no RUN steps, no network, no boot RAM cost.

## Operator notes

- Allowlist: add the new tag to the admin image-allowlist AppSetting before
  API-create with it (done at s5 verification boot; default template NOT switched).
- Real-boot behaviour (`ro.hardware.vulkan=lvp` at runtime, chrome://gpu vulkan
  section, GLES string unchanged) is verified in **s5** on `rdev-fx-1` — not
  claimed here.
