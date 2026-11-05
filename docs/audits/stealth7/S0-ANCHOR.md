# S0 定錨 — Digitalis A16 分支（WA-STEALTH7 gen29）

**Date:** 2026-11-06 (GMT+8) · **Task:** mw3q37y8zyzvd / subtask `mw3q37y8wkdl1`
**Method:** 信 commit 唔信首页 — clone 實樹 + commit-tree 目錄證據；README 只當文獻。

## 錨點（決定）

| 項 | 值 |
|---|---|
| Org | `DigitalisX64`（Apache-2.0，非 fork＝Berberis 全新 import） |
| 實作 repo | `platform_frameworks_libs_binary_translation`（Berberis + ARM64 後端本體） |
| **分支** | **`android16`** |
| **sha（實測 HEAD）** | **`8ab8e93225ce10e10ef411de7e377dda6673c335`**（= `android-latest-release` = HEAD，2026-11-06 實測 `git ls-remote`） |
| AOSP base | `android16-qpr2-release`（entry repo README 語義；API 36） |
| 文檔/入口 repo | `digitalis`（docs/config only）；manifest repo 用 `repo init -b android16 -u …/manifest` |

## 正面證據（commit 實樹，clone 自 android16 @ 8ab8e932）

`git clone --depth 1 -b android16` 後根目錄即見 arm64→x86_64 翻譯器源碼目錄（非 binary blob）：

- `enable_arm64_to_x86_64.mk`（同排 `enable_riscv64_to_x86_64.mk`）— 內文實證：
  - `ro.dalvik.vm.native.bridge=libberberis_arm64.so`（L25）
  - `ro.dalvik.vm.isa.arm64=x86_64`（L28）
  - `$(call soong_config_set,berberis,translation_arch,arm64_to_x86_64)`（L43）
- 源碼目錄（逐項 `ls`/`find` 實測存在）：
  - `interpreter/arm64/`、`interpreter/include/berberis/interpreter/arm64/`
  - `lite_translator/arm64_to_x86_64/`
  - `heavy_optimizer/arm64/`（含 `frontend.cc/.h`、`arm64_tier_coverage.txt`）
  - `decoder/include/berberis/decoder/arm64/`、`decoder/arm64_test/`
  - `guest_loader/arm64/`、`guest_os_primitives/arm64/`、`kernel_api/arm64/`、`runtime/arm64/`
  - `backend/x86_64/`（x86_64 後端代碼生成）；`backend/Android.bp` 內 `arm64` 命中 ×11
  - `Android.bp` 有 `berberis_arm64_defaults`（L111）、arm64 host tests（L385）
- `assembler/`、`intrinsics/`、`guest_abi/`、`native_bridge/`、`proxy_loader/`、`prebuilt/` 全在（T8 報告清單一致）。

## 反面證據（android17 未移植 — README 原文摘錄）

entry repo `digitalis` 分支 `android17` README（raw 實取）：

> `android17` | `android17-release` | the AOSP 17 port, **in progress**
>
> "`android17` brings up a complete AOSP 17 tree, but the translator is not ported yet: `frameworks/libs/binary_translation` on that branch is still upstream AOSP 17, which carries no ARM64 backend. It builds an ordinary AOSP 17 emulator, not a translating one. **Use `android16` for anything that needs to actually run ARM64 apps.**"
>
> "AOSP 17 moved the translator sources under `cpu_emulation/`, and it now ships its own ARM64 guest scaffolding for Google's closed backend, so the port is a merge that has to reconcile both — not a fast-forward."

implementation repo `android17` 分支 sha 對照：`abefbe2b16006f76e05ddceb920e8c758cf7b318`（ls-remote 實測）。

## 「信 commit 唔信首页」note

implementation repo 嘅 `README.md` 本身係 upstream Berberis 文檔，自我介紹只講 riscv64（「Dynamic binary translator to run Android apps with riscv64 native code on x86_64…」），完全唔提 arm64 — 首页睇 README 會以為無 arm64 backend；但 commit tree 嘅 `enable_arm64_to_x86_64.mk` + 上述源碼目錄先係真相。

## 教訓（入 memory）

- 揀 Digitalis A16 錨點＝用 **implementation repo `android16` 分支 tip**（佢同 `android-latest-release` 同 sha，即最新穩定翻譯器）；`android17` 係 trap（tree 齊但翻譯器未移植）。
- entry repo README 嘅分支表係最可靠嘅「邊個 branch 係 shipping」文檔（implementation repo README 係 upstream 遺留）。
