# stealth5 build record — WA-FIXALL S6 stealth4-next bundle

Image: `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth5`
Id: `sha256:7912c825f0037bd92d5565475be28740c8d2667ebaeda57eb06a9628cbef2a9d`
Built: 2026-11-03 (host docker, COPY-only, classic builder layer chain on stealth4)
Builder run: `bash images/gms-mtg-oemprop-stealth5/build.sh` → all pins + post-build asserts green.

## Bundle (risk-ledger mapping)

| change | layer | R-id | verify (planned S6 trial) |
|---|---|---|---|
| webview.apk 156.0.8078.47 arm64 (com.google.android.webview) | image | R41 root | navigator.platform armv81 in Chrome + WebView carriers |
| `/system/xbin/su` whiteout | image | R43-4 | `which su` empty on device |
| `/system/build.prop` ro.debuggable=0 (1-line diff) | image | R43-3 | getprop ro.debuggable = 0; adb.secure story |
| fake `power_supply` psy dir + rc bind-mount at post-fs-data | image | R59 EXTRA skin | BatteryManager EXTRA voltage/temp/health non-sentinel |
| rc `gsm.sim.state=ABSENT` at boot_completed | image | R42 detail | getprop gsm.sim.state = ABSENT |
| ro.build.type/tags user + release-keys | **profile data** (boot-arg derived) | R43-1/2 | getprop ro.build.type/tags on fx2 |
| cpuinfo/meminfo carriers (oem_mem_total_kb / oem_cpu_cores / oem_cpu_clusters) | **boot args from profile deviceSpec.proc** (already wired in create path) | R57/R58 | /proc/cpuinfo no host "Ryzen", MemTotal ~7.6 GB |

## Honest deferrals (this bake)

- **sensors fake HAL (R48)**: image ships framework sensors AIDL .so libs only; no
  trustworthy x86_64 Android-14 sensors HAL *service binary* exists on this host and
  no RUN/network in the chain (COPY-only discipline). Fabricating a binary swap
  without a version-pairing test would risk the boot chain = deferred to the next
  image wave (workorder R48 verdict "加得" stands; this wave did not fit half a day).

## Findings baked into tooling

1. **Whiteouts in COPY-only builds**: classic builder honours `.wh.<name>` files
   COPYed into a directory as overlayfs whiteouts (merged view: target gone, and no
   literal `.wh.su` file). Probed via `docker cp` "Could not find the file" — the
   redroid image has no usable static exec surface (`/bin/sh`, `/bin/stat`,
   even `/system/bin/stat` are absent from the image layers), so `docker cp` is the
   canonical merged-view probe for this image family.
2. **Base digest clarification**: stealth4 live image id =
   `sha256:92c1922efef6…` (= what fx1 runs). S2-RESULTS quotes `8ec65a4d2125`
   (manifest digest reported at create time). build.sh pins the **live image id**.
3. **health HAL story**: the in-image health service is
   `android.hardware.health-service.example` (healthd_config based): it reads
   `/sys/class/power_supply/...` paths and logs "BatteryCurrentNowPath not found"
   etc. because redroid's sysfs power_supply dir is EMPTY (containers share the
   host kernel view; no battery psy on the host either). `dumpsys battery set
   voltage|temperature|health|technology|current` are ALL unsupported on this
   build ("Unknown set option" — measured 2026-11-03 on fx1), i.e. the
   BatteryService props-override skin cannot carry EXTRA fields either way.
   Hence the fake-psy bind-mount: post-fs-data precedes class hal = healthd finds
   the paths before BatteryService's first health-info read.

## Deliberate non-changes

- GMS/GSF, privapp xml, telephony gsm xml, oem-ro-map generated rc chain: inherited
  from stealth4 unchanged (S2 asserts keep holding; suite zero-regression baseline
  1764/1758/0/6 unaffected — image files are unit-tested only via rc/drift guards).
- No secrets introduced (SOURCE-PIN.md carries URL + sha256 only).

## Bake iterations v1→v7 (final) — measured deltas vs the v1 plan

| v | change | on-device result |
|---|--------|------------------|
| 1 | ro.debuggable=0 build.prop COPY | init exit 129 @ ~7s (adbd = init `critical` service on this platform) ⇒ REVERTED; debuggable stays 1 (documented deviation from the S6 ruling). build.prop COPY removed; vendor/build.prop.orig kept as pin evidence (assert grep '^ro.debuggable=1$'). |
| 2 | COPY'd rc mode fix (init "Skipping insecure file" for 0664) | build.sh chmod 0644 + post-build merged-view stat assert |
| 3 | ro.* propctl rows moved to load_persist_props_action | fresh-/data first boot re-asserts build.prop (load_persist_props) = fleet-wide early-init story wipe; fx2 measured all props wiped vs fx1 (old data) surviving. Regenerated rc artifact shipped as files/vendor/etc/init/oem-ro-map.rc (overwrites the 12-entry stealth4 one with the current 13-entry table). |
| 4 | WebView arm64 APK swap | FAILED then REVERTED: native bridge = libnb.so null-bridge (no ndk_translation, no APEX) ⇒ arm64-only APK = "No WebView installed". Base com.android.webview 125 restored byte-exact (oat assert); vendored APK+pin stay for the translator-era bake (R41 next version). |
| 5 | battery psy mount line orientation (node/device args) | mount builtin still not landing (open; toybox bind with identical params works = runtime-verified voltage read) — see docs/audits/fixall/s6/fx2-battery.txt |
| 6 | proc-view pair baked (oem-proc-view.sh/.rc + COPY + chmod) | /proc spoof present; carrier wiring already product-side (profileProcCmdArgs) |
| 7 | oem-proc-view.sh init-umask chmod fix (rendered 0600 → SysMemInfo crash-loop) | boot_completed=1; system_server alive |

FINAL: water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth5 @ sha256:2de5d82ab8d8106f4b5040ce925bab2142da342384bac46aca34906680b15118
Trial: rdev-fx2 fresh-data first boot = boot_completed, user/release-keys, no su, sim ABSENT, MemTotal 7.6 GB, ARM fake cpuinfo (0 Ryzen lines), locale carrier readback ru-RU. fx1 (stealth4, old data) control untouched.
