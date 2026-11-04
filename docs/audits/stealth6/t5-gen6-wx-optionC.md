# WA-STEALTH6 gen6 — wx_segment: Option C (W^X code cache) 拍板輪

**Date:** 2026-11-04 (Asia/HK)
**Baseline:** HEAD = origin = `7d03da4` (confirmed)
**Test bed:** fx2 (`redroid-rdev-fx2`, image `…-oemprop-stealth6-v2`), adb `127.0.0.1:15001`, SMJ510GN. fx1 untouched. No new machine (RAM gate; MemAvail ≈ 8.4 GB).

**Question:** Can Option **C** — patch the ndk_translation JIT code cache to **W^X** (mmap RW → write → mprotect r-x), eliminating the 4 MB anonymous `rwxp` arena that DevCheck's `libtrustnative.so` flags as `hook:wx_segment` (−15) — take us from **82 → ~97**?

---

## TL;DR verdict

**C is the correct, generalizable fix and the *only* path to the ≥90 target** (wx −15 is the sole large remaining deduction), **but it requires rebuilding `libndk_translation.so` from AOSP `external/ndk_translation` source — and that toolchain/build is NOT present on this redroid host (high cost + boot-contract risk).** A cheap one-byte binary-patch shortcut is **not semantically safe** (the arena needs W *and* X concurrently).

- Field baseline reproduced on fx2: **DevCheck 82/100** ("Mostly consistent", 100% checks pass).
- **wx payoff is essentially proven**: the wx check literally scans `/proc/self/maps` for `rwx`; DevCheck has **exactly 1** such mapping (the 4 MB arena), 0 others → removing it fully clears wx → **~97**. (Interpreter mode already yields 0 rwx in the audit; it only failed on startup *speed*, not on wx.)
- **C's risk is the build, not the outcome.**

**Recommendation:** authorize a dedicated `external/ndk_translation` build (clone + clang/cmake; produce an x86_64 drop-in `.so` with the mprotect-cycle patch), then `docker cp` into fx2 + reboot + re-scan. Reversible (restore original `.so` if native-bridge init fails). Fall back to **D (accept 82)** only if the ≥90 target is relaxed; **B is fragile** (needs the closed-source DevCheck vendor to ship x86_64 native libs, and the process still runs under the arm64-primary zygote → arena may persist for other translated libs).

---

## 1. Provenance (step 1)

`libndk_translation.so` in the image is a **Google `external/ndk_translation` prebuilt** shipped by the redroid base image (`240527`), not something we built:

| attribute | value |
|---|---|
| path | `/system/lib64/libndk_translation.so` |
| size | 2,467,648 B |
| mtime | 2023-01-27 |
| sha256 | `c05f2b7ef51d3c855576ae53c25f7511d0490695ca1bf6b16269627be6dbdb51` |
| type | ELF64 x86-64, stripped, `BuildID 9805a5ea90f28caa52fbba663bbe87b7` |
| soname | `libndk_translation.so` (NEEDED: liblog/libandroid/libc++/libc/libm/libdl) |
| props | `isa.arm64=x86_64` (translation ON); `ndk_translation.mode`=(empty→JIT); `ro.ndk_translation.version`=(empty) |

Translation is real and live on stealth6-v2. Source is on AOSP (`platform/external/ndk_translation`) but **not cloned on this host, and no AOSP/Soong tree or clang prebuilts exist here.**

### Machinery symbols (from dynamic symbol table + disasm)

- mmap wrappers: `MmapForGuest`, `MmapImplOrDie`, `MmapImpl`, `LargeMmapImplOrDie`, `InitLargeMmap`; prot comes from a caller-filled `MmapImplArgs` **struct** (thin tail-call wrappers), not a raw immediate at the wrapper.
- `MprotectOrDie`, `MprotectForGuest` exist → the library **does** have mprotect machinery (used by the `GuestMapShadow::Set/Clear/RemapExecutable` guest-mmap path).
- `MmapPool<131072, 2097152>` = 2 MB lazy anonymous pools (`mov $0x1000,%esi; mov $0x3,%edx` → 4 KB, PROT_RW, guard-page pattern — **not** the arena).
- CodeCache path string `/code_cache`; `FlushGuestCodeCache`.

**Allocation site of the arena:** the JIT `/code_cache` is created via the `MmapImpl(OrDie)`/`LargeMmapImplOrDie` wrapper with `prot = PROT_READ|PROT_WRITE|PROT_EXEC` supplied as a **struct field** by a C++ caller. Pinpointing that caller's prot byte in a *stripped* 400k-line disasm is spelunking-prone; I did not rabbit-hole it because the field-test already answers the decisive question (§3).

### No no-rebuild lever

This build's `TranslatorOptions` exposes **only** `ndk_translation.{flags,mode,profiling,tracing}` (+ `ro.ndk_translation.version`). There is **no `--rwx`/`--no-rwx`/single-step option** and **no property** that makes the arena non-RWX. `mode=interpreter` gives 0 rwx but is proven (gen3) to make DevCheck fail to start (attach timeout).

---

## 2. JIT arena on live DevCheck (step 2/3)

`com.deviceinsight.ai` running the Hardware Trust scan:

```
rwx regions: 1   ->  7d7d45a00000-7d7d45e00000  rwxp   (size 0x400000 = 4 MB, MAP_ANON)
rwxs:        0   ->  total writable-exec mappings = 1
arena Rss:   2844 KB / 4096 KB reserved, STABLE across repeat scans (no growth)
```

Findings:
- The 4 MB arena is the **sole** writable-exec mapping in DevCheck → **removing it fully clears wx** (no other rwx source to worry about — this is the pre-written fork's concern "仍照扣=其他 rwx 來源": not the case here).
- Rss stable at 2844 KB across repeat scans → **ndk_translation translates each guest function once and caches it**; W is idle at steady state, needed only on first-touch translation of a not-yet-seen function.
  - Implication for the patch design: "mprotect→r-x **once after warmup**" is safe only if every needed function is translated during warmup. The robust, general fix is an **mprotect RW↔RX cycle per first-touch translation** (reserve RWX arena; on each emit, keep the executed prefix `r-x` and only the current write window `rw-`) — a real source restructure, not a bit flip.

### DevCheck detail (from gen5 `part0.xml`, authoritative)

| Issue | Detail | Deduction |
|---|---|---|
| Native cross-check | `hook/bypass: hook [hook:wx_segment]` | **−15** |
| USB debugging | "ADB / USB debugging is turned on. Informational." | −3 |

`82 = 100 − 15(wx) − 3(adb)`. **wx is the sole blocker to ≥90.** wx cleared → ~97 (adb −3 is informational and out of wx scope).

---

## 3. Field test (step 3) — baseline reproduced

- DevCheck installed → onboarding (3 pages) → Hardware Trust **CHECK** scan.
- Result: **Trust Score 82, "Mostly consistent", 100% of device checks passed.** Screenshots (non-black verified by reading each): `gen6-devcheck-01-onboarding.png`, `gen6-devcheck-03-main.png`, `gen6-devcheck-05-scanned-82.png`.
- DevCheck **uninstalled** (red line). fx2 `wlan0`/networking intact after; nothing baked, no image change, no new machine.

---

## 4. Decision (fork, pre-written) — branch 2: 工具鏈行唔通 (budget)

**Not "C is wrong" — C is right but gated behind a build environment absent on this host.** Concretely:
1. Source: on AOSP, not on host.
2. Toolchain: no AOSP/Soong tree + clang prebuilts here → building a 2023-vintage Google prebuilt (large generated ARM64 decoder + libbase/libc++ deps) as a **drop-in ABI-compatible** `.so` the framework's native-bridge will accept (matching `getNativeBridgeInterface` version + exported `ndk_translation::GuestLoader`/`StartExecutable`) is a **multi-attempt, boot-contract-risky** build — the kind of thing the task flags as a "3 振內定論" dead-end *on this host*.
3. The patch itself (mprotect-cycle W^X) is a code restructure, not a one-line change; a single mmap-prot-bit change is **unsafe** (arena needs W+X concurrently).

→ **Recommend the CEO authorize a dedicated `external/ndk_translation` build** (clone + clang/cmake, on an old server / Linux box with the toolchain) implementing the W^X CodeCache cycle, then drop-in on fx2 + reboot + re-scan (reversible). Expected: wx cleared → **~97/100**.

**Ranking:** **C (with build env) ≫ B (fragile: closed DevCheck APK, process still arm64-primary) > D (accept 82, misses ≥90).**

---

## Evidence files

- `gen6-wx-field-reads.txt` — provenance, props, arena inventory, Rss, DevCheck detail deltas.
- `gen6-devcheck-01-onboarding.png`, `gen6-devcheck-03-main.png`, `gen6-devcheck-05-scanned-82.png` — field screenshots (82/100 reproduced).
- Source `.so` sha256 `c05f2b7e…` (prebuilt; not committed — 2.3 MB binary, build-record noted instead per repo-size norm).
