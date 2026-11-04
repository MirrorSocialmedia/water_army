# WA-STEALTH6 gen9 — Digitalis feasibility review (ARM64→x86_64 source path re-opened)

**Date:** 2026-11-04 (Asia/HK)
**Baseline:** HEAD = origin/main = `5b67fcd` (gen7 source-purge). Confirmed in sync (0 ahead / 0 behind); gen8 has not pushed. **This report is the base for the gen8 berberis-drop-in work, not a code change.**
**Method:** pure research — GitHub REST API + raw doc fetches only, all through host proxy `http://127.0.0.1:7897` (every call HTTP 200). No clone, no image touched, no fx machine touched, no new machine. No secrets (public web refs only).

**CEO directive (11-04 13:12):** gen7's "no public ARM64→x86_64 source anywhere" is overturned by **Digitalis** (`DigitalisX64`, Apache-2.0) — a public ARM64 backend on the Berberis framework. This doc answers the six questions + maps our `.so` lineage + redroid-adaptation risk.

## TL;DR verdict

- **Digitalis is real, public, Apache-2.0, and active.** It is an **AOSP-16 (API 36) Berberis fork that adds the whole ARM64→x86_64 backend** (upstream Berberis ships only RISC-V — gen7's claim holds for *upstream*, and Digitalis is exactly the missing arm64 backend). Source is obtainable (fork repo `platform_frameworks_libs_binary_translation`, 19.9 MB, not a giant clone).
- **Lineage (the key finding):** our in-image `.so` is the **ARC `ndk_translation::` family** (0 berberis symbols); Digitalis and the modern Google-APIs emulator bridge are the **Berberis `berberis::` family**. They are *different lineages*. C′ (drop-in a newer emulator `.so`) and Digitalis are the same family; our current `.so` is the older ARC one.
- **Verdict for us:** Digitalis is the credible long-term source route, but it is an **A16** product; our redroid is **A14** (`redroid-14.0.0-240527`). Directly shipping Digitalis's *A16-built prebuilt bundle* on an A14 base is the cheap first probe, with real ABI/binfmt/gralloc risk (risk table below). **Recommended PoC = redroid drop-in of the prebuilt bundle (route B, prebuilt), NOT the independent A16 emulator** — because the emulator is where all their work is validated (so "works on emulator" tells us little about redroid), whereas redroid drop-in answers the exact unknowns we carry.

---

## 1. Digitalis 實態 (state of the repo)

GitHub org `DigitalisX64` (all branches `android16` unless noted) — entry `digitalis` repo is **docs/config only** (1.8 MB); the translator source lives in a sibling:

| repo | role | size | pushed |
|---|---|---|---|
| `platform_frameworks_libs_binary_translation` | **the implementation** (Berberis + ARM64 backend) | 19.9 MB | 2026-10-27 |
| `manifest` | AOSP manifest (`repo init -b android16 -u …/manifest`) | 1.9 MB | 2026-10-24 |
| `device_generic_goldfish` | reference emulator product to verify | 14.1 MB | 2026-10-29 |
| `sample_hello_digitalis` | 150+-module integration test suite | 18.0 MB | 2026-10-24 |
| `digitalis` | entry: docs, benchmarks, docker build, AGENT config | 1.8 MB | 2026-10-30 |
| `digitalisx64.github.io` | site (branch `android-latest-release`) | 2.0 MB | 2026-10-30 |

- **License / lineage:** Apache-2.0; `fork=False` on GitHub (a fresh Apache-2.0 *import* of Berberis, provenance by the README Attribution section "a modification of AOSP … Berberis … © Google LLC"). Not a fork of our ARC `ndk_translation`.
- **Activity:** healthy — all repos pushed within the last ~week of the snapshot; entry pushed 2026-10-30. `RELEASE_NOTES.md` shows dated release cycles (2026-09-13, 2026-10-20 …) with real changelogs.
- **A16 branch = ARM64 translator source present (directory evidence):** the fork root carries **`enable_arm64_to_x86_64.mk`** *and* `enable_riscv64_to_x86_64.mk`, plus arch-generic translator trees `interpreter/`, `lite_translator/`, `heavy_optimizer/`, `backend/`, `decoder/`, `guest_abi/`, `intrinsics/`, `guest_loader/`, `native_bridge/`, `proxy_loader/`, `runtime/`, and `prebuilt/`. So the arm64 frontend is a first-class source tree, **not a binary blob**.
- **Three-tier claim confirmed:** `how-it-works.md §6` = two families: the JIT (**two gears: "lite" translator + "heavy optimizer"**) and the **interpreter** fallback. "~98%" = fraction of *what a typical app executes* that the Lite JIT handles (runtime-weighted); **per-mnemonic coverage** (`unsupported-opcodes.md`) = Lite 45,338/48,032 = **94.4%**, Heavy 44,355/48,032 = **92.3%**; the rest (complex SIMD, SHA-512/SM3/SM4, IEEE CRC32, all SVE/SME/FP8 by design) goes to the interpreter. "159 測試模組" = **159/159 samples** in the latest gate (158 sample modules + `hello-realm`).
- **Binary-only Distribution (Docker) — contents verified** against `docker/README.md`: **74 canonical artifacts** from `BERBERIS_DISTRIBUTION_ARTIFACTS_ARM64`, matching the prompt's list exactly:
  - `system/lib64/libberberis_arm64.so` (the NativeBridge translator) + `libberberis_exec_region.so` + **21** `libberberis_proxy_*.so`.
  - `system/bin/berberis_program_runner_arm64`, `…_binfmt_misc_arm64`.
  - `system/lib64/arm64/*.so` = **ARM64 guest libs** (bionic `libc`, `libm`, `libvulkan`, …).
  - `system/bin/arm64/{app_process64,linker64}`.
  - Configs: `ld.config.arm64.txt`, `init/berberis.rc`, `binfmt_misc/arm64_{dyn,exe}`.
  - `digitalis-prebuilts.mk` (consumer inherits it), `MANIFEST.txt`, `SHA256SUMS`, generated README.
  - `verify-digitalis-prebuilts.sh` checks ELF arch (host libs→x86-64, guest libs→AArch64), NativeBridge export, checksums.
- **Verified-apps caveat:** project tracks ≈**137 staged APKs** in its prebuilt launch gate (RELEASE_NOTES 2026-09-13); `apkmirror-apps.json` = **29** apkmirror regression apps; site has a "Adding a Verified App" registry. The prompt's "133 verified apps" is this ~130s marketing figure. **"Verified" = the app launches and renders under translation — the docs never mention Play Integrity / hardware attestation.** For our stealth/DevCheck use (where we care about authenticity signals), a translator is itself an attestation tell, so "verified ≠ passes integrity" is a hard caveat, not a footnote.

---

## 2. Six questions, answered with evidence

### (1) Our `.so` lineage — same source as the emulator's `ndk_translation`?

**No — different lineage.** Our `.so` (`/tmp/ndk-v2.so`, sha `c05f2b7e…`, BuildID `9805a5ea…`, x86_64 stripped) is the **ARC `ndk_translation::` JIT family**: its 18 dynsym hits are all `ndk_translation::`-namespaced (`MmapForGuest/GuestMapShadow/MmapImpl*/FlushGuestCodeCache`, plus `ndk_translation::GuestLoader` / `Arm64ToGuestNZCV` intrinsics), **0 `berberis::` symbols** (re-confirmed in t6-gen7 §1). The modern Google-APIs emulator arm64 bridge, per Digitalis's own README, is **a Berberis build whose symbol table carries `berberis::intrinsics::Arm64ReadFpcr`**. So:

- our shipped `.so` = old **ARC** family (`ndk_translation::`), Google-SDK-license binary only;
- the emulator's current arm64 bridge = **Berberis** family (`berberis::`);
- **Digitalis = Berberis** family.

⇒ **Digitalis is a sibling of the *newer* emulator bridge, NOT of our current `.so`.** This is why C′ (drop-in a newer emulator `.so`) and Digitalis are the same code family — and why dropping a berberis-lineage `.so` over our ARC-lineage one is an *architecture swap*, not a version bump. Evidence: t6-gen7 §1–3 (symbol matrix); `digitalis/README.md` ("…libndk_translation.so, a Berberis build whose symbol table carries berberis::intrinsics::Arm64ReadFpcr…").

### (2) Does Digitalis actually run ARM64 apps?

**Yes, on x86_64 emulator.** 158 sample modules + ≈137 staged-APK prebuilt gate; RELEASE_NOTES name real third-party apps (Kuaishou, Chromium-based browsers, WPS/Slack/AliExpress/Amazon in apkmirror set). Caveat: gate = launches/renders, **not attestation**; the reference "works" platform is the goldfish emulator, not bare metal. Evidence: `docs/RELEASE_NOTES.md`, `apkmirror-apps.json`, `how-it-works.md` (158 modules).

### (3) Redroid integration — binfmt_misc & prebuilts.mk

Integration model (`integrating-digitalis.md`): **3 config pieces + 2 source projects, zero core-platform patch.** Two routes — **source** (add manifest projects) or **binary** (overlay the prebuilt bundle). Redroid mapping:

- **`digitalis-prebuilts.mk` / `enable_arm64_to_x86_64.mk` → redroid product `.mk`:** one `$(call inherit-product, …)` sets `ro.dalvik.vm.native.bridge=libberberis_arm64.so`, `ro.dalvik.vm.isa.arm64=x86_64`, `ro.enable.native.bridge.exec=1`, adds the 21 proxy libs + guest-lib packages + Soong allowlist.
- **BoardConfig:** add `TARGET_NATIVE_BRIDGE_ARCH := arm64` / `…_VARIANT armv8-a` / `…_CPU_VARIANT generic` / `TARGET_NATIVE_BRIDGE_ABI := arm64-v8a` so Soong builds the native_bridge flavor of bionic/NDK and appends `arm64-v8a` to `abilist`. **This is exactly our T1 abi story** (arm64 first + x86_64 tail) — Digitalis is the native-bridge that would legitimately populate it.
- **binfmt_misc is the container precondition:** binfmt_misc is a **host-kernel** feature (`CONFIG_BINFMT_MISC` + a mounted `/proc/sys/fs/binfmt_misc`). In a redroid container the register interface is host-kernel-provided; `berberis.rc` (Android init) writes the `arm64_dyn`/`arm64_exe` handlers into that mount namespace at boot. **Precondition for us:** host kernel must expose binfmt_misc AND redroid's init must be able to mount/register it (our redroid container runs Android init as pid1 inside a Docker namespace — need to confirm binfmt_misc is writable there, else the standalone-arm64-exec path (binfmt_misc runners) fails while the NativeBridge zygote path still works — binfmt is only needed for running arm64 *executables* directly, not for translated app `.so`s). Evidence: `integrating-digitalis.md` integration table + `docker/README.md` artifact list.

### (4) Re-using an A16-built prebuilt on our A14 redroid base

Digitalis is built on **AOSP 16 / API 36** (`android16` pinned to `android16-qpr2-release`). Our base is **A14** (`redroid-14.0.0-240527`). The prebuilt bundle is meant to be overlaid onto a product *from the same AOSP 16 branch*; cross-version drop-in risks:
- **bionic/NDK guest libs** in the bundle are A16 builds; they carry A16 symbol versions → pairing them against an A14 host linker/glibc-ABI surface can mismatch (guest libs are loaded in the guest namespace, mitigating this, but `linker64`/`app_process64` are version-locked to the bundle's own configs).
- **NativeBridge API** is stable across 14→16, so `ro.dalvik.vm.native.bridge` wiring is fine; the ABI delta is in the guest libs + Soong namespaces, not the bridge ABI.
- **Their own statement** is conservative: emulator arm64 bridge *presence* in Google-APIs images spans **A14(API34)→A17(API37)**; but *Digitalis-the-fork* is validated on A16. **Not tested cross-version by them.** For our PoC we would overlay the A16 bundle on A14 and boot-probe (revertible `.so.bak`), exactly the C′ discipline.

### (5) GPU stack — ANGLE / GFXStream vs redroid gralloc

**Digitalis itself is a CPU translator; it ships no GPU stack.** Guest ARM64 `libvulkan`/`libGLES` are *proxy libs* that marshal into the **host x86_64** GL/Vulkan loader; what sits behind depends on the product (`how-it-works.md §13` + `integrating-digitalis.md`):
- **Emulator path:** `ro.hardware.egl=angle` (GLES via **ANGLE** on in-guest Vulkan) + Vulkan crosses to host via **GFXStream VkDecoder** (`vulkan.ranchu`). The two `emulator-gfxstream-deploy.md` defects (`VK_EXT_memory_budget` abort, 2 GiB heap clamp) are **goldfish-emulator host bugs**, absent from the prebuilt emulator binary — they do **not** apply to redroid.
- **Bare-metal path (relevant to redroid):** host = the **real in-process vendor ICD** (e.g. Mesa ANV / vendor driver), *not* gfxstream. Redroid already runs a host GPU host (gralloc + host Vulkan/GL) → this is redroid's actual path.
- **The redroid risk is the AHB/gralloc boundary:** RELEASE_NOTES 2026-09-13 records that a bare-metal Mesa ANV driver crashed on the first frame because the guest `libvulkan` proxy dropped `VK_ANDROID_external_memory_android_hardware_buffer` structs from `pNext` chains (the emulator's gfxstream *encoder* re-serialises and hides this; an in-process driver dereferences it and dies). Their `digitalis_extra` override now forwards those chains. ⇒ For redroid, the guest GL/Vulkan proxy + host gralloc (AHB import) must line up; that marshalling boundary is the GPU risk surface, and it is stricter than the emulator masks. Evidence: `docs/emulator-gfxstream-deploy.md`, `docs/RELEASE_NOTES.md` (2026-09-13), `how-it-works.md §13`.

### (6) Performance — public numbers

Published steady-state microbenchmarks (`docs/benchmark-results.md`, run `20261019-230410`, 162 records / 23 workloads, modes interpret/lite/two-gear/native):
- **Fastest tier = two-gear JIT.** Over the interpreter: **15–104×** (sgemm-256 104×, RELEASE_NOTES quotes **108×** on latest build). Vs **native x86_64**: CPU-bound workloads are **~1.3–4.4× slower** (bcrypt 1.3–1.4×, zstd 1.4×, yoga 3.7×, secp256k1 ~4.3×).
- **Startup / JIT:** *eager* translation (threshold 0 — every region JIT'd on first encounter; `translator_x86_64.cc`), no AOT, no cold-JIT-startup figure published.
- **Coverage:** Lite 94.4% / Heavy 92.3% per mnemonic (above). Instruction-family coverage is the honest limiter for exotic SIMD/SVE.
- **Honest gap:** numbers are **host-CPU microbenches on the goldfish emulator**, not redroid full-app wall-clock; and no Play-integrity/attestation cost measured. So for *our* environment: **未實測 (not measured).** Evidence: `docs/benchmark-results.md`, `docs/benchmarking.md`, `docs/unsupported-opcodes.md`.

---

## 3. Relationship to C′ / Berberis (the lineage map)

- **Upstream Berberis (`frameworks/libs/binary_translation`) = RISC-V-only** (gen7 gitiles finding holds; Digitalis's own README says "Upstream AOSP Berberis publishes only a RISC-V backend"; upstream `arm64_to_x86_64/` does not exist — the arm64 frontend is *not* something upstream added later). The aosp-mirror GitHub probe 404'd on the repo name (name mismatch, not evidence).
- **Digitalis = a Berberis fork + the entire ARM64 backend**, Apache-2.0, added *by DigitalisX64* (fresh import, `fork=False`). It is *not* our ARC `ndk_translation`.
- **Relationship to gen8's C′ (berberis prebuilt drop-in on A14):** C′ and Digitalis are the **same Berberis family**. gen8's "newer Google-emulator `libndk_translation.so` (berberis-based) drop-in" and "port Digitalis's `libberberis_arm64.so`" are cousins — both replace our ARC-lineage `.so` with a berberis-lineage one. Difference: C′ = a **Google binary** (SDK license, no source, fixed to a specific API level); Digitalis = **source we can build/patch** (Apache-2.0, W^X patchable, A16). If gen8's berberis drop-in *boots* on A14, it de-risks the family before we invest in the Digitalis build. If it *doesn't* boot, Digitalis's A16 source route is where the fixable version lives.

---

## 4. Our-environment adaptation risk table

| # | Risk | Why it bites *us* (redroid A14, stealth/DevCheck) | Mitigation / probe | Net |
|---|---|---|---|---|
| R1 | **Version skew A16→A14** | Digitalis + its guest libs are A16-built; our base is redroid-14.0.0-240527 | Boot-probe the A16 prebuilt bundle on A14 (revertible `.so.bak`); guest libs load in guest ns (partial mitigation) | Med — the main unknown; one boot cycle answers |
| R2 | **Lineage swap ARC→berberis** | Our shipped `.so` is ARC `ndk_translation::`; berberis changes symbol family, props (`ndk_translation.mode` → berberis knobs), and W^X shape | Check `/proc/<pid>/maps` for the berberis JIT arena's rwx **before** scanning (this is our whole wx_segment score lever!) | Med-high — this also changes the DevCheck wx answer (the C-goal) |
| R3 | **binfmt_misc in-container** | Standalone arm64 executables need host-kernel binfmt_misc + a writable register mount in the redroid ns | If binfmt unusable, only the *NativeBridge zygote* path works (app `.so`s fine; `binfmt_misc` runners fail) — most apps are fine | Low-Med |
| R4 | **gralloc/AHB GPU boundary** | redroid = bare-metal in-process vendor driver path; AHB/pNext marshalling is stricter than gfxstream masks (their Mesa-ANV crash was exactly this) | Confirm guest GL/Vulkan proxies + host gralloc AHB import render; watch `pNext`/AHB forwarding (`digitalis_extra`) | Med — GPU apps only; non-GPU apps unaffected |
| R5 | **Attestation ≠ verified** | Their "verified" = launches/renders; never mentions Play Integrity. For stealth, a translator presence is itself a tell | Treat score impact as unknown; DevCheck/Play-integrity must be re-run, not assumed | High for *our* goal (this is the whole WA-STEALTH6 objective) |
| R6 | **Legal / license** | Digitalis + Berberis = Apache-2.0 ✅ (unlike our current `.so` = Google **SDK license**, binary-only). But *emulator* C′ binaries stay SDK-licensed | Apache-2.0 source route is the legally clean one; record attribution | Low (Apache-2.0 is clean) |
| R7 | **Build env** | Building Digitalis needs an AOSP-16 `m` tree (Docker build reuses `out/`); our host lacks it (gen6/gen7 toolchain gap) | Use their **binary route** (overlay prebuilt) to avoid the build entirely for the PoC | Low if prebuilt route; High if we must compile |

---

## 5. Next-step PoC — who moves first

**Recommend: redroid prebuilt drop-in (route B), not the independent A16 emulator.** Rationale: the goldfish emulator is where Digitalis is *already* validated — "works on the A16 emulator" proves nothing new about our container. The redroid drop-in of the **A16 prebuilt bundle** answers the exact unknowns we carry (R1 boot, R2 wx/berberis arena, R4 gralloc, R5 integrity) in **one field cycle**, and gen8's concurrent berberis-A14-drop-in (C′) already touches that surface. Sequence:
1. **gen8 (C′, in flight):** berberis-A14 emulator prebuilt boots on fx2? → if yes, family is boot-safe.
2. **gen10 PoC:** overlay Digitalis `digitalis-prebuilts/` (A16) onto redroid A14, boot-probe; check (a) boot health, (b) `/proc/<pid>/maps` rwx arena (wx score consequence), (c) a GPU app renders (R4), (d) DevCheck + Play Integrity.
3. Keep the emulator as the *fallback reference* only if the redroid bundle fails to boot (so we can distinguish "A16-on-A14 ABI" vs "redroid container" as the cause).

**Do NOT** commit to building Digitalis from A16 source (R7) until the binary drop-in boot-proves the family on A14.

---

## 6. Red lines honoured (gen9)

No image bake, no image change, no transplant; no fx machine touched (fx2 reserved for gen8 — I only read `/tmp`/repo + docs); no new machine; no full AOSP/BER clone (GitHub REST API + raw single-file fetches only, all via host proxy `127.0.0.1:7897`, every call HTTP 200, 0 fetch failures). Zero secrets in repo (public web references only; sensitive scan = URL/API host strings, no credentials). Baseline = HEAD `5b67fcd` (origin-sync confirmed).