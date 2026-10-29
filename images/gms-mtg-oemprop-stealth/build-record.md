# WA-VMSTEALTH S3 build-record — `gms-mtg-oemprop-stealth`

- **Date:** 2026-10-29 (HKT) · built by CTO subagent (WA-VMSTEALTH gen1, Kairo `mvt3rginnub9t`)
- **Final tag:** `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth`
- **Final image ID:** `sha256:86e823fa67ccf07df125aa2cb1403ebf65a442ecfc6f3c8265d2a1a75fde970b`
- **Base (pinned digest):** `water-army/redroid:14.0.0-240527-gms-mtg-oemprop` @ `sha256:2d82732bbb88cbe4bfad64ec8680582b5c73e3ef289c2bd14a6a7728d0bb82b2` (WA-OEMPROP v4, 真機 PASS 12/12 — see `docs/audits/oemprop-report.md`)
- **Old tags:** untouched (`gms-mtg` 02ab5675ba15 / `gms-mtg-oemprop` 2d82732bbb88 re-verified byte-identical post-build).

## Inputs (all pinned in build.sh, fail-closed)
| Input | sha256 |
|---|---|
| `scripts/stealth/patch_cstr.mjs` | `1b2d2b419c2da2280d0f30e1c23dd35472e8965a5945e4a61b9af4157f95dd25` |
| `images/redroid-w1b/oem-ro-map-stealth.rc` | `17b57dfe6a2255739e46b839941a6c95d70a6be96586931b71e29c66c285a197` (generator drift gate also runs) |
| base `/vendor/lib64/hw/vulkan.lvp.so` (patch INPUT) | `16eae072493d3ac5ee70c79347d7491a9c619ffa0355bfcb3cc04b40636a0a7d` |
| patched `/vendor/lib64/hw/vulkan.lvp.so` (patch OUTPUT, deterministic) | `9886119a1556e4909159142bd3cd8911d1fcfb414787d3af1ba17c9d6f63577d` |
| `vendor/bin/oem-propctl-real` (inherited canary) | `ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b` |
| `vendor/{lib64,lib}/hw/hwcomposer.default.so` (inherited fallbacks) | `50496dbd…3b75` / `d4ed9c9b…f5d4` |

## What the layer changes (2 files)
1. `/vendor/lib64/hw/vulkan.lvp.so` — Vulkan `deviceName` literal
   `llvmpipe (git-53e769e0f1)` → `Adreno (TM) 644` (in-place NUL-padded C-string
   patch; file size byte-identical; `patch_cstr.mjs` aborts the build if the
   literal count ≠ 1). GL/renderer tell per S1 §1.4 ruling (a).
2. `/vendor/etc/init/oem-ro-map.rc` — STEALTH mapping variant: base 12 targets
   + 50 derived stealth props + per-phase `ro.boot.oem_*` carrier sweep
   (`oem-propctl --delete-if-exist`, ordered after all writes).

## Build pipeline
`bash images/gms-mtg-oemprop-stealth/build.sh` = pins → `docker build`
(node:22-alpine patch stage + COPY-only final stage) → `finalize.sh` (rc+lvp
bit-identity/normalization, layer-tar re-own to root:root 0644) → POST-BUILD
ASSERTION on the exported tar (modes, ownership, patched-sha, leak-literal
absent, new name present, inherited oemprop layer intact, oem-proc-view
absent). **Result: `POST-BUILD ASSERT OK` @ first successful run 2026-10-29 15:1x HKT.**

Attempt history: build #1 failed `python3: not found` in ubuntu:24.04 (host
variant is the minimal flavour) — strategy change to node:22-alpine +
`patch_cstr.mjs` (byte-equivalent algorithm; patched-output sha verified
identical to the pre-computed pin before rebuild). #2 green. No retries.

## Secrets
None introduced: no LABEL/ENV additions; no credentials in Dockerfile/scripts;
pinned shas only. (Image metadata = base config recovered by finalize.)

## VERIFICATION STATUS — **NOT VERIFIED (by design)**
This round is research + image + product-code + hermetic only (work-order red
line: product stack stopped, RAM ~3 GiB → **no redroid boot was run**).
- Nothing here claims "spoofing works on device"; the ONLY evidence so far is
  byte-level (POST-BUILD ASSERT) + hermetic unit tests (`tests/unit/vmstealth.test.js`).
- Real-device validation (boot, getprop 12+50, Vulkan deviceName via
  `dumpsys SurfaceFlinger`/GLES probe, battery override, MAC chain, GMS
  side-effects) is deferred **in full** to **WA-ADVERSARIAL-FINAL**
  (Kairo `mvt3rgj9dnspm`), which owns the observation checklist in
  `docs/audits/vmstealth-s1-mechanism.md` §6.1.
- Product side: `WA_REDROID_STEALTH_ENABLED` defaults **OFF** — enabling the
  feature flags this tag into the allowlist is a FINAL-round deployment step.
