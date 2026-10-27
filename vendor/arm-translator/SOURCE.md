# ARM translator vendoring — L3-C' (Kairo mvqgmpg7w82rk, 2026-10-27)

Houdini (Intel proprietary ARM→x86 translator) + A14 redroid init.rc hack,
for `images/gms-mtg-arm/`. Large zips are gitignored; hashes below are the pin.

## Artifacts (verified 2026-10-27)

| File | sha256 | md5 (upstream pin) | Size |
|---|---|---|---|
| `libhoudini-0c149b1.zip` | `41dd445b489549692a2b874b31f0c6b7c5c94547d7c9eca467b8f5794a78706e` | `d9703a9b1e674bb41c34e40823774e9f` ✓ = redroid-script pin | 75,152,190 B |
| `libhoudini-hack-a2194c5.zip` | `5c904d6db5e15adc37ffadde5f21437ccabf86c1e94a3a0e4f77371a90776983` | `8f71a58f3e54eca879a2f7de64dbed58` ✓ = redroid-script pin | (see fetch.sh) |

## Provenance

* **houdini**: `github.com/rote66/vendor_intel_proprietary_houdini` commit
  `0c149b1e14d7bfd4b2af261afc6f2e80517dbd98` (archive zip; 673 files). This is
  the EXACT commit redroid-script pins for Android 11–15
  (`stuff/houdini.py dl_links["14.0.0"]`). Binaries extracted from ChromeOS /
  GooglePlayGames-PC firmware images (Intel proprietary `libhoudini.so`
  native-bridge + `bin/houdini{,64}` binfmt interpreters + ARM32/ARM64
  translated system-lib mirrors under `lib/arm`, `lib64/arm64`).
* **hack**: `github.com/rote66/redroid_libhoudini_hack` commit
  `a2194c5e294cbbfdfe87e51eb9eddb4c3621d8c3`, `14.0.0/` subtree. Contents
  (verified by diff vs stock `redroid/redroid:14.0.0-240527` init.rc):
  - `etc/init/hw/init.rc` — full replacement; ONLY delta = two `exec` lines
    after `perform_apex_config` in `on post-fs-data` that boot-patch the
    runtime `/linkerconfig/ld.config.txt` (+ swcodec one) via `/system/bin/patch`
    (toybox applet, present as symlink in base) to permit
    `/system/${LIB}/arm{,64}{,/nb}` namespace paths. Pre-zygote, post-apex.
  - `etc/ld_config.patch`, `etc/ld_config_swcodec.patch` — inputs, left as-is.

## License / redistribution (recorded per policy)

* **Houdini = Intel proprietary binary** (same internal-use-only posture as the
  Google GMS binaries in gms-mtgapps: no redistribution claim; internal testing
  / research use). Repo carries the zip out-of-band (gitignored) + hash pin;
  CI/dev re-fetches via `images/gms-mtg-arm/fetch.sh`.
* hack repo carries no SPDX license (binary-extracted patch files; same caveat).

## ARM32 vs ARM64 support matrix (this packaging)

| Guest ABI | Translated? | Path in package |
|---|---|---|
| armeabi-v7a / armeabi (ARM32) | YES | `prebuilts/lib/arm/**` + `lib/libhoudini.so` (x86-32) + `bin/houdini` |
| arm64-v8a (ARM64) | YES | `prebuilts/lib64/arm64/**` + `lib64/libhoudini.so` (x86-64) + `bin/houdini64` |
| x86 / x86_64 | native (no translation) | base image |

## berberis status check (2026-10-27, docs-level)

berberis = AOSP's open-source successor translator. On our A14 base it is NOT
present as a usable native bridge (base ships only the dangling
`ro.dalvik.vm.native.bridge=libnb.so` reference with no library — redroid-doc
#933 reports the same class of bug for redroid 15: bridge advertises arm64
without translator). Community reports (issue #933, 2026-08) extracting
berberis from Google's official emulator images require API-matched builds
(API 35 for A15 / 36 for A16) and `libberberis_exec_region.so`; a self-built
berberis for redroid A14 x86_64 = extra build project. **Decision: houdini for
this spike; berberis tracked as follow-up option.**

## Alternative community paths checked (2026-10-27)

* `remote-android` redroid-doc #685: A13 + houdini `INSTALL_FAILED_NO_MATCHING_ABIS`
  — open issue; our base advertises arm in abilist already (verified in
  `redroid/redroid:14.0.0-240527` build.prop), so install-side should pass;
  runtime verdict = EXP-6 real-device leg.
* erstt/redroid docker-hub images (prebuilt houdini/ndk variants) exist but we
  build our own layers (pin discipline; gms-mtg lineage).
* hypdroid / libndk (guybrush via supremegamers prebuilt): libndk is
  ARM32-only historically and redroid-script warns "works only on 11/12" →
  not chosen. (Boss's Chrome is ARM32 so libndk WOULD cover it, but houdini
  covers both ABIs and is the A14-proven path in redroid-script.)
