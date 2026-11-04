# WA-STEALTH6 gen8 — C′ berberis prebuilt drop-in on fx2: bridge contract v7 > Android-14 HAL v6 → load refused → D/82

**Date:** 2026-11-04 (Asia/HK)
**Baseline:** HEAD = origin/main = `5b67fcd` (confirmed at segment start)
**Test bed:** fx2 (`redroid-rdev-fx2`, image `…-oemprop-stealth6-v2`, redroid-14.0.0-240527 = Android 14 HAL). RAM gate: 10→8 GiB available (recorded). fx1 untouched. Proxy `http://127.0.0.1:7897`.

**Question (CEO-approved C′):** does fogelmanjg's "works" berberis-based `libndk_translation.so` (`fa529513…`, 3,893,208 B, from SDK `x86_64-35-ext15_r01`) drop into fx2 and (a) boot, (b) clear the W^X wx hook (its JIT arena maybe not rwx), (c) score in the ~97 zone? One cycle, pre-written branches: **97-zone new score / arena still rwx → D / symbol-set incompatible / boot incompatible.**

## TL;DR verdict

**Boot stayed healthy, but the berberis translator never loaded: Android 14's NativeBridge HAL refuses the bridge, so no ARM64 native library loads at all.** Root evidence: the in-image ARC `.so` exports `NativeBridgeItf` with **version field = 6**; the berberis `.so` exports the same struct with **version = 7** (struct also grew 144→160 B). Android 14 `LoadNativeBridge` accepts bridge ITF **≤ v6**; a v7 (Android 15-era) bridge is rejected → native bridge off → DevCheck's `lib/arm64` extraction came down empty, `System.loadLibrary` failed, its checks ran **pure-Java** — the wx-hook check (`hook:wx_segment`) never even ran (detail list showed only the plain `os.arch` −15 + adb −3 = 82, and `/proc/<pid>/maps` had **zero** translator/arm64/exec_region mappings, rwx count 0 — there was no arena to judge).

A 4-byte in-place patch of the version field **7→6** was tried as the final shake: boot healthy, **still no bridge load** (the version gate is not the only contract gate on Android 14 — remaining HAL requirements (v6 trampoline set / static-TLS C-ABI exports / native_bridge namespace / vdso) are not satisfied by the API-35 build, and the loader is silent on redroid-14). **fx2 fully rolled back to ARC (`c05f2b7e…` sha re-verified, 0 `.bak` residue, DevCheck uninstalled).**

⇒ **C′ outcome = "symbol-set / bridge-contract incompatible" with boot healthy → landing zone D (accept 82).** The core C′ question (is berberis's JIT arena rwx?) stays unanswered because the translator never attached on Android 14; fogelmanjg's "works" evidence is on newer (Android 15-era) bases where a v7 bridge is legal.

## 1. Provenance (Step 1)

| item | value |
|---|---|
| source zip | `https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-35-ext15_r01.zip` (fogelmanjg README; **not** the `android/emulator/` path which 404s), 1,766,710,562 B, sha256 `2d79b5b027e6dae4…` |
| extraction | fogelmanjg `redroid-ndk-translation` `tools/extract.js` (alpine docker: unzip → GPT super partition → LP metadata → **erofs** `fsck.erofs`) → 82 files |
| translator identity | md5 `fa52951394226cbcc52e666f1d8c0d19`, 3,893,208 B, catalog build `ndk-api35-fa529513` (LoopSort + PVZ2 "works") — **matches the matrix entry** |
| sha256 as extracted | `504b0c8a763f4505…` (pre-patch); after version patch `550365e5894ada2b…` |

## 2. ABI / load pre-check (Step 2) — PASS on the naive checks, DEAD on the version field

- fx2 bridge wiring: `ro.dalvik.vm.native.bridge=libnb.so` → **symlink** → `/system/lib64/libndk_translation.so` — a drop-in replaces the real file, symlink follows, no prop change needed.
- HAL attach symbol: **both** `.so` export `NativeBridgeItf` (ARC 144 B OBJECT; berberis 160 B OBJECT) — same NativeBridge-HAL contract family (berberis is the direct successor of the `native_bridge.cc` lineage).
- helper/CPU-state symbols correspond 1:1 (`GuestThread::{Init,Alloc,Config}StaticTls`, `ProxyLibraryBuilder::Build`, trampoline/signal families; `_ZN15ndk_translation…` ↔ `_ZN8berberis…`).
- `DT_NEEDED` of berberis `.so`: `liblog, libandroid, libdl_android, libc++, libc, libm, libdl` — all present on fx2 (superset of ARC's NEEDED set).
- **The killer:** first `u32` of the exported `NativeBridgeItf` struct = ITF version: **ARC = 6, berberis = 7** (read directly from the file at sym-value: ARC `0x2522d8`→`06 00 00 00`; berberis `0x39c090`→`07 00 00 00`). Android 14's NativeBridge HAL (redroid-14.0.0-240527) supports bridge ITF **≤ 6**; v7 belongs to Android 15.

## 3. Field test (Step 3)

Drop-in set = the full fogelmanjg 82-file translator layout merged onto fx2 (`libndk_translation.so` + new `libberberis_exec_region.so` + 20 proxy libs + 56 `arm64/*.so` + `bin/arm64/{app_process64,linker64}` (chmod 755) + `cpuinfo.arm64.txt` + `ld.config.arm64.txt`), every overwritten file kept as `*.bak` (84 `.bak` total: 21 lib64 + 59 arm64 + 2 bin + 2 etc).

(i) **Boot healthy** — `sys.boot_completed=1`, `init.svc.zygote=running` (no crash-loop), no bridge crashes in crash buffer, adb alive after the known post-reboot **v4-flush fix** (`ip addr replace 172.38.200.5/24 dev wlan0; ip route replace default via 172.38.200.1 dev wlan0`; first route replace reports `Network is unreachable` until addr is in — normal). (No Chrome in this image — health gated on zygote+adb.)

(ii) **maps / rwx** — DevCheck (`primaryCpuAbi=arm64-v8a`; AMS `mRequiredAbi=arm64-v8a instructionSet=arm64`) ran fine, but `/proc/<pid>/maps` contained **no** `libndk_translation.so` / `berberis` / `exec_region` / any `/arm64/` library and **rwx count = 0**; same for zygote64 (`ndk_translation` hits = 0; only `libnblog.so` noise). The translator never attached. (Same after the 7→6 version patch.)

(iii) **DevCheck** — installed (`install -r`), scanned via Skip→main→details. Score **82**, issues = `os.arch` mismatch −15 + adb −3, **no `Native cross-check / hook:wx_segment` item** (the wx hook never ran; checks were pure-Java). Its ARM64 native libs were never even extracted (`/data/app/…/lib/arm64/` empty — consistent with bridge off at install time). Manual lib placement + `pm clear` + CLEAR_TASK relaunches: app alive, still zero translator maps.

## 4. Why it dies (evidence-level)

Android 14 `NativeBridge.cc::LoadNativeBridge` dlopens the bridge, then enforces the ITF version (≤ 6). berberis's v7 struct (160 B, two extra entries) is out of contract for Android 14; patched-to-6 was still refused → remaining Android-14 HAL requirements (v6 trampoline set, `initialize/uninitialize/configStaticTls` exports via the bridge namespace, `native_bridge_vdso` presence — fogelmanjg's 82-file set has **no** vdso) are not satisfied by the API-35 build on this base image. redroid-14's loader is **silent** (no `NativeBridge:`/`LINKER` lines in `logcat -b all`), so the exact reject line is unavailable — the version read + behavioural evidence (bridge off, ARM libs unloaded) are the proof.

fogelmanjg's "works" is on newer bases (redroid-forge injects into **newer Android** images where v7 is legal). Our base is **Android 14 (240527)** → v7-only berberis cannot attach.

## 5. C′ verdict (pre-written four-way)

**→ "符號集/contract 唔兼容"（bridge ITF v7 > HAL v6, load refused; boot itself healthy）→ 落地 D / 82。** Not "97 區間新分" (score stayed 82 and actually degraded: ARM64 native checks didn't run), not "arena 照 rwx" (no arena existed to measure), not "boot 唔兼容" (boot was fine). W^X cannot be won on fx2's Android-14 base with the public berberis binary; the public-source rebuild (C) is separately dead (gen7). **D is the landing zone for stealth6.**

## 6. State after segment (red lines honoured)

fx2 fully **rolled back**: `libndk_translation.so` sha back to `c05f2b7ef51d…` (ARC, gen6-verified), 0 `.bak` residue, `libberberis_exec_region.so` removed, boot=1, bridge prop intact, adb live, **DevCheck uninstalled**, fx1 untouched, D4 untouched, no image bake, zero secrets, ≤3 restart shakes (3 used). Working downloads kept on host at `/tmp/wa-stealth6-gen8/` (zip 1.7 GB, `out-full/` 82 files, `repo/` tools).

**Host adb:** `/home/kenneth/.openclaw/workspace/tools/platform-tools/adb` → `127.0.0.1:15001`.

**Pitfalls for future gens:**
1. The emulator `system.img` is GPT + `super` + **erofs** — use fogelmanjg `extract.js`; don't hand-parse (`debugfs`: "Bad magic"; ext4 EF53 scan: false positives; erofs magic `e2e1f5e0` at fs+1024).
2. toybox `grep -iE` with complex patterns **segfaults** inside redroid (tombstones `Cmdline: grep … mstep/mwalk` — not an Android crash); use `grep -F` plain patterns per-word.
3. toybox `grep` has no `-F -E` combo; `logcat` needs `-b all` for boot range; bridge init logs are **absent by default** (NativeBridge tag silent).
4. Post-`docker restart` the container v4 is flushed by IpClient (known stealth6-v2 defect): `ip addr replace` + `ip route replace` (route first try prints `Network is unreachable` — idempotent, just re-run).
5. DevCheck after repeated crashes: AMS stops respawning (task `visible=true` but no ProcessRecord) — relaunch with `am start -f 0x24000` (NEW_TASK|CLEAR_TASK).
6. NativeBridge ITF **version is readable from the `.so` itself**: first u32 at the `NativeBridgeItf` symbol value (ARC-2023 = 6; API35 berberis = 7). Any future drop-in candidate: check this byte pair **before** booting.
7. `pm install` extraction of `lib/arm64` is **empty when the bridge is off** — a fast side-signal that native bridge failed (empty dir + primaryCpuAbi still set).
