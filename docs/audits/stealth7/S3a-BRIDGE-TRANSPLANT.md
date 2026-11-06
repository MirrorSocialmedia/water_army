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

## STEP 2 — 植入 s7s2-a16 ✅（容器層生效）

**植入清單（docker cp 入 `/system`，overlay upper 可寫）：**

| 目標路徑 | 內容 |
|---|---|
| `/system/lib64/` | `libndk_translation.so` + 20 個 `libndk_translation_proxy_*.so` + `libberberis_exec_region.so` + `libnativebridge_lazy.so` + `libnativeloader_lazy.so`（合共 23 檔） |
| `/system/lib64/arm64/` | 56 個 guest arm64 庫（donor 原樣，含 linker 需要嘅 libandroid_runtime 等） |
| `/system/bin/arm64/` | `linker64`、`app_process64`（aarch64） |
| `/system/bin/` | `ndk_translation_program_runner_binfmt_misc_arm64`（x86-64 runner） |
| `/system/etc/binfmt_misc/` | `arm64_exe`、`arm64_dyn`（註冊檔） |
| `/system/etc/init/` | `ndk_translation.rc`（binfmt mount + register，gated by prop） |
| `/system/etc/` | `ld.config.arm64.txt`、`cpuinfo.arm64.txt` |
| `/vendor/build.prop` | `ro.dalvik.vm.native.bridge`: `libnb.so` → `libndk_translation.so`（其餘 native.bridge 家族 prop donor 已有嘅target本来就有：`ro.enable.native.bridge.exec=1`、`ro.dalvik.vm.isa.arm64=x86_64`） |

**決定：** donor `libnblog.so` 唔覆蓋 target 現有 redroid 版 libnblog.so（避免動 redroid ashmem log shim）；ndk_translation NEEDED 只係 liblog/libc/libc++/libm/libdl/libandroid/libdl_android（全部 target 已有）。

**生效層級實測：** `ro.*` property 係 init boot 時從 build.prop 載入 → **zygote 層重啟唔會 re-read**；`docker restart`（容器層）先至生效。重啟後 getprop：`native.bridge=libndk_translation.so` ✅、`sys.boot_completed=1`（~12 秒）、`/proc/sys/fs/binfmt_misc/{arm64_exe,arm64_dyn}` 已註冊 ✅（rc 生效）。

## STEP 3 — 判語 ✅（三選一實證 #1 + #2 同時命中）

重啟後裝回 DevCheck（`/tmp/devcheckai-arm64only.apk` S2 已裝、persist ✓）：

- `su 0 am start -f 0x24000 -n com.deviceinsight.ai/.ui.OnboardingActivity` → **`Displayed ... +128ms`**，進程活（PID 2092）
- **EM_AARCH64 (183) instead of EM_X86_64 (62) 錯誤呢輪 boot 計 0 次**（S2 基圖：每次 app 起動都有；呢輪 nativeloader 全無 EM_ 錯誤）
- **arm64 app 庫 dlopen ok**：`Load .../base.apk!/lib/arm64-v8a/libdatastore_shared_counter.so ... : ok`（clns-9 bridged namespace）
- **maps 實證**：`/proc/2092/maps` 見 `/system/lib64/arm64/libc.so`（guest 庫映射）+ `/system/lib64/libndk_translation_proxy_libc.so` + 7 處 `ndk_translation` 庫常駐
- **截圖核**：`evidence/s7-s3a-devcheck-ui.png` — 1080×2400、2077 unique colors、非黑幀（DevCheck Onboarding UI 渲染正常）
- 旁證：binfmt_misc 已註冊 `arm64_exe`/`arm64_dyn`（rc 生效）
- 未算證據嘅探測：`/system/bin/arm64/app_process64 -version` 經 binfmt 執行 **無輸出（inconclusive）**，唔計入判語
- 啟動教訓（A16 容器）：shell uid 2000  launch 非 exported activity 會 `SecurityException: not exported from uid`；要用 **`su 0 am start`**（S2 未遇，可能同 force-stop 後 stopped 狀態嘅 exported 檢查路徑有関）

## 判語：**活**（三檔之「活」）

berberis/ndk_translation 引擎 donor 移植成功：**A16 redroid 容器翻译层已活** — arm64 庫 dlopen 唔再被 EM_ 拒絕、translator 常駐進程、guest 庫映射可見、UI 非黑幀。

**照實記錄嘅邊界（唔准美化位）：**
1. 本轮只 Prove 到 app 入口屏嘅 arm64 native 庫（libdatastore_shared_counter）；DevCheck 深層功能屏嘅 `libtrustnative.so`/libkeyvault 未見載入紀錄 — 完整 app 覆蓋要後續逐屏場測（S3 烘焙段正经）。
2. `NativeBridgeItf` 首 u32=`0x8`（**ITF v8**）→ A16 target 接受（stealth6 教訓：A14 HAL 只收 ≤6；v8 喺 A16 冇被拒，實證）。
3. 呢個係 donor **ndk_translation（ARC 血統）**而唔係 AOSP berberis 正統後端 — 产品化鏡像來源/授權要喺 S3 定，同 S2 「唔好默默用社群鏡像上生产」同一原則。
4. 機留起：`s7s2-a16` 容器未拆，俾 CEO 覆核；改動全喺 overlay upper（`docker commit` 先至可固化，本輪未 commit 鏡像）。

## STEP 4 — 交貨

- 本文檔 + `evidence/s7-s3a-donor-inventory.txt` + `evidence/s7-s3a-bridge-evidence.txt` + `evidence/s7-s3a-devcheck-ui.png`
- donor 抽檔工作區：`/tmp/s7s3/`（sys/vendor ext4 切片 + donor/ 84 檔）— 未入 repo（零 secret，體積大）
- Kairo `mw3q37y8zyzvd` 已 note；每步 done 即 commit（STEP1/2/3-4 三段）
- free -m（收段時）：swap 8182/8191（接近爆照實）、MemAvailable ~13G；禁碰名單全程零沾
