# WA-STEALTH6 gen7 — Option C source hunt: ARC `ndk_translation` repo is purged (C infeasible — evidence)

**Date:** 2026-11-04 (Asia/HK)
**Baseline:** HEAD = origin/main = `27b439a` (confirmed)
**Test bed:** fx2 (`redroid-rdev-fx2`, image `…-oemprop-stealth6-v2`). Read-only probes only — **fx2 untouched** (no DevCheck install, no container writes). No new machine. RAM gate: 10 GiB available at segment start.

**Question (CEO approved "C"):** clone `android.googlesource.com/platform/external/ndk_translation` (Android 14-era), standalone-build x86_64 `libndk_translation.so`, W^X mprotect-cycle patch, drop-in fx2, expect wx cleared → ~97.

## TL;DR verdict

**Step 1 (clone gate) fails: the source repository no longer exists in public.** `platform/external/ndk_translation` has been **removed from android.googlesource.com AND from Gerrit** (both 404). No mirror exists on ChromiumOS/Gitee/GitHub (aosp-mirror purged it too), and the android-x86 host (git.amorroid.org) is down. The repo was retired with the Android 14 berberis switchover and bulk-deleted (googlesource top page shows the retirement purge, Bug: 139309277 era). **Therefore Option C as scoped (rebuild the *existing* prebuilt from source) is not executable — "C 不可行實證", delivered per pre-written branch 3. The build environment (step 2) was never reached.**

This is *stronger* than gen6's conclusion ("toolchain absent on host, build is gated"): **the premise itself (publicly obtainable source for our `.so`) is gone.**

## 1. Provenance of the in-image `.so` (re-confirmed on fx2, read-only)

| attribute | value |
|---|---|
| sha256 | `c05f2b7ef51d3c855576ae53c25f7511d0490695ca1bf6b16269627be6dbdb51` (matches gen6 record ✓) |
| lineage | **ARC `external/ndk_translation` JIT family**: 18 dynsym hits for `MmapForGuest/GuestMapShadow/MmapImpl*/FlushGuestCodeCache`; **0** `berberis*` symbols |
| props | strings contain `ndk_translation.mode` / `ndk_translation.flags` (ARC TranslatorOptions property family) |

⇒ Our `.so` is the last ARC-era Google build (mtime 2023-01-27, ≈ android-13 QPR vintage), not berberis.

## 2. Source-availability probe matrix (all via host proxy `http://127.0.0.1:7897`)

| Endpoint | Result |
|---|---|
| `android.googlesource.com/platform/external/ndk_translation` `info/refs?service=git-upload-pack` | **404 "ERR Git repository not found"** |
| gitiles repo page `+refs` | 503/404 (entity gone) |
| `platform/external/` gitiles project listing (1502 repos) | **no `ndk_translation`** (N-range: ncurses→neon_2_sse, nothing matching `ndk\|translat`) |
| `android-review.googlesource.com/projects/platform%2Fexternal%2Fndk_translation` | **404 "Not found"** (Gerrit = canonical AOSP git server — repo purged there too) |
| AOSP manifests `android12/13/14-release`, `android-13.0.0_r30` `default.xml` | never contained `external/ndk_translation` (it was a retired side-project, not a manifest member) |
| redroid's own `remote-android/platform_manifests` `redroid-14.0.0_r2` | `frameworks/libs/binary_translation` (berberis) present; **no ndk_translation project** ⇒ redroid never built it; it ships Google's binary |
| `chromium.googlesource.com/chromiumos/third_party/{ndk_translation, arc_ndk_translation, arc-translations, arc-adapter}` | all not found |
| Gitee API search `ndk_translation` | empty |
| GitHub: `aosp-mirror/platform_external_ndk_translation` | 404 (purged); API repo search → only **prebuilt wrapper** repos (`vendor_google_proprietary_ndk_translation-prebuilt` ×3 forks, `android_device_x86_64-extras_ndk_translation`) — binaries only |
| `git.amorroid.org/platform/external/ndk_translation` (android-x86, direct + proxy) | TLS handshake failure / DNS dead (host effectively down) |
| `cs.android.com` repo page | JS shell, no usable raw/tree API within budget |

3-strike accounting (clone gate): ① googlesource purge ② Gerrit purge ③ mirrors (chromium/gitee/github/amorroid) all dead ⇒ stop, no rabbit-hole.

## 3. berberis (the public successor) does NOT cover ARM on x86_64

`platform/frameworks/libs/binary_translation` listing (`android16-release` and `main`, live gitiles):
- only frontend switch: `enable_riscv64_to_x86_64.mk`; **no arm/arm64→x86_64 frontend directory exists**; `arm64_to_x86_64/` 404.
- Corroboration (fogelmanjg/redroid-ndk-translation, 2026): *"Berberis is open source in AOSP, but only with a riscv64 front-end: the ARM one is not public, so the translator cannot be rebuilt from source."*

⇒ There is **no public source anywhere** that rebuilds into the ARM64→x86_64 native bridge we ship. The Android SDK emulator's arm64 translator (`dl.google.com` sys-img `x86_64-*`) is distributed as binary under the Android SDK license only.

## 4. Decision consequences (for CEO)

| Option | Status after gen7 |
|---|---|
| **C (rebuild our .so, W^X patch)** | **DEAD as scoped** — source purged, not publicly obtainable (this doc). |
| **C′ (new, this generation): drop-in a *newer Google emulator* `libndk_translation.so`** (berberis-based binary; fogelmanjg matrix: `fa529513…` 3,893,208 B in `x86_64-35-ext15_r01` = "works"; older `3f1d2639…` crashes in- translator) | Executable cheaply: download sys-img from `dl.google.com` (proxy), extract `.so` set, docker cp into fx2 + reboot (reversible `.so.bak`). **Unknowns:** (i) whether that build's JIT arena is rwx (DevCheck wx may still fire — probe `/proc/<pid>/maps` FIRST before even scanning); (ii) boot contract on redroid-14.0.0-240527 (their "works" data is on newer redroid/images); (iii) ARM64 perf/behaviour. One field-test cycle answers all three. |
| **B (x86_64 native libtrustnative in DevCheck APK)** | unchanged (fragile; needs custom APK) |
| **D (accept 82)** | unchanged fallback |

Suggested next probe (≤1 cycle, fx2 drop-in reversible): take `x86_64-35-ext15_r01` translator set → check `strings` for W^X-ish behaviour → `docker cp` → reboot → `(i) boot health + Chrome, (ii) rwx count in DevCheck maps, (iii) score`. If its arena is *still* rwx, D/82 is the landing zone.

## 5. Red lines honoured (gen7)

fx1 untouched (not even connected); no new machine; DevCheck not installed this segment (gen6's uninstall state persists — verified: `pm list packages` has no `com.deviceinsight.ai`); D4 frozen; no image bake; zero secrets in repo (docs only); all host probes read-only on fx2 (`sha256sum`, `readelf`, `strings`).

**Host proxy note (for future gens):** clone/fetch to Google sources works via `http://127.0.0.1:7897` (Clash-style http proxy on host; `curl -x` verified 200→google). `git ls-remote` needs `https_proxy=` env inline.
