# S3a berberis/ndk_translation 移植實驗（WA-STEALTH7 gen31b，donor 路）

**Date:** 2026-11-06 (GMT+8) · **Task:** mw3q37y8zyzvd (S3 支線)
**目標:** 將 donor Google A16 emulator 鏡像（x86_64-36_r07）嘅 arm64→x86_64 翻譯引擎植入社群 redroid A16 容器 `s7s2-a16`，解決 S2 定讞嘅「bridge 庫缺實體 → EM_AARCH64 dlopen 拒絕」。
**約束:** 唔准起第二個 emulator/QEMU、唔准 source build、全部 mount/unzip 抽檔；禁碰 {rdev-f1, mc-dogfood-1, rdev-fx1}；swap 8178/8191 接近爆。

## 重要發現（修正 TOOLS.md 教訓適用範圍）

donor `system.img` 係 **GPT + super + 4 個原生 ext4**（唔係 erofs！TOOLS.md 嗰條 erofs 教訓適用於 stealth6-gen8 嗰個 donor，呢個 emulator r07 鏡像係 ext4，debugfs 直接可讀）。super 內分區（掃描實證、volume label 核對）：

| 分區 | super offset | 大小 |
|---|---|---|
| system | +0x100000 | 985 MiB |
| system_ext | +0x3f200000 | 232 MiB |
| product | +0x4de00000 | 2149 MiB |
| vendor | +0xd6600000 | 99 MiB |

super 入面**冇 LP metadata**（gpGh 掃描零命中的）→ emulator 鏡像用固定偏移 concat。

## STEP 1 — donor 抽引擎 ✅

**引擎真身唔係 berberis 全套，係 ndk_translation（ARC 血統）：**

- donor `system/build.prop`: `ro.dalvik.vm.native.bridge=libndk_translation.so` + `ro.dalvik.vm.isa.arm64=x86_64` + `ro.dalvik.vm.isa.arm=x86` + `ro.enable.native.bridge.exec=1`；abilist64=`x86_64,arm64-v8a`
- 主引擎 `/system/lib64/libndk_translation.so`（x86-64, stripped）
- **ITF 版本實測: NativeBridgeItf 首 u32 = 0x8 → ITF v8**（struct 168B；stealth6 教訓：A14 HAL 只收 ≤6；A16 target 待實證）
- proxy 庫 × 20（`libndk_translation_proxy_*.so`：libEGL/GLESv1/2/3/OpenMAXAL/OpenSLES/aaudio/amidi/android/android_runtime/binder_ndk/c/camera2ndk/jnigraphics/mediandk/nativehelper/nativewindow/neuralnetworks/vulkan/webviewchromium_plat_support）
- `/system/lib64/libberberis_exec_region.so`（x86-64 helper）、`libnativebridge_lazy.so`、`libnativeloader_lazy.so`
- runner `/system/bin/ndk_translation_program_runner_binfmt_misc_arm64`（x86-64 PIE）
- guest 庫目錄 `/system/lib64/arm64/`（58 個 arm64 庫：libc/libEGL/libandroid_runtime…全部 ARM aarch64 確認）+ guest linker `/system/bin/arm64/{linker64,app_process64}`（aarch64）
- binfmt_misc 註冊（`/system/etc/init/ndk_translation.rc` + `/system/etc/binfmt_misc/arm64_{exe,dyn}`）：
  - arm64_exe: `:arm64_exe:M::\x7fELF\x02\x01\x01\x00...\x02\x00\xb7::/system/bin/ndk_translation_program_runner_binfmt_misc_arm64:P`
  - arm64_dyn: 同型 but `type-3 (DYN)`
- linker 配置 `/system/etc/ld.config.arm64.txt`（namespace search `/system/${LIB}/arm64`）

抽檔方法：dd 抽 ext4（無 loop mount、無 QEMU）→ 宿主 debugfs 1.47 `dump/rdump`。全部檔案清單+`file` 核對：`evidence/s7-s3a-donor-inventory.txt`（donor 合共 84 檔 31MB）。

## STEP 2 — 植入 s7s2-a16

（進行中）

## STEP 3 — 判語

（待）
