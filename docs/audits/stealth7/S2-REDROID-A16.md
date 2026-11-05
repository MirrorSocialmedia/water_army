# S2 redroid A16 基圖定讞（WA-STEALTH7 gen30）

**Date:** 2026-11-06 (GMT+8) · **Task:** mw3q37y8zyzvd / subtask `mw3q37y8ufy9g`
**Verdict:** ✅ **redroid A16 容器路 boot 成功 + arm64-only APK 裝得行得（Java 活）**；❌ **翻譯層未活：arm64 `.so` dlopen 被拒（EM_AARCH64→EM_X86_64），bridge 庫缺實體 → S3 要自配**。GMS：官方鏡像無 GMS 變體（照實）。

## 測試機（留起緊拆，S3 烘焙用）

- **容器:** `s7s2-a16`（鏡像 `teddynight/redroid16:latest`，見下「官方鏡像 boot 阻撓」）
- **adb:** `127.0.0.1:16664`（`adb connect 127.0.0.1:16664`）
- **起機參數:** `--privileged --entrypoint /init … qemu=1 androidboot.hardware=redroid androidboot.use_memfd=1 androidboot.redroid_{width=1080,height=2400,dpi=420,fps=60,gpu_mode=host}`
- **RAM:** 起機前 MemAvailable 9531 MiB（閘 ≥2.5G PASS）；起機後 8596 MiB（宿主 swap 8189/8191 接近爆，照實記）
- 禁碰名單 `rdev-f1 / mc-dogfood-1 / rdev-fx1` 全程未碰。

## STEP 1 — 基圖定讞（registry v2 實查，Docker Hub `redroid/redroid`）

- **A16 官方 tag 有：`16.0.0-250627`、`16.0.0-latest`、`16.0.0_64only-250627`、`16.0.0_64only-latest`**（index 含 linux/amd64+arm64；amd64 manifest `sha256:bb97565901da…`，pull digest `sha256:d89f5204…`）。
- **GMS：無。** 全 100 個 tag 冇任何 `-gms` 變體 → **無 GMS 先行**（照實）。
- **Native bridge 定讞（鏡像 tar 實證）:**
  - `system/build.prop`: `ro.dalvik.vm.native.bridge=0`；abilist 有列 `arm64-v8a`（`x86_64,x86,arm64-v8a,armeabi-v7a,armeabi`）。
  - `vendor/build.prop`: `ro.dalvik.vm.native.bridge=libnb.so` + `ro.enable.native.bridge.exec=1`（init 實效值 = vendor 蓋 system：logcat `init: Overriding previous property 'ro.dalvik.vm.native.bridge':'0' with new value 'libnb.so'`）。
  - **但 `libnb.so` 檔案喺鏡像入面唔存在**（export tar + 運行中 find 實證）；全 rootfs 冇 `*ndk_translation*`/`*berberis*`。
  - **結論：官方 redroid A16「有 arm64 ABI 名單、無翻譯引擎」** — bridge 屬性指緊一個唔存在嘅庫。

## 官方鏡像 boot 阻撓（教訓，已解決）

- `redroid/redroid:16.0.0-250627` 喺本宿主（Ubuntu kernel 6.8.0-117 generic）**boot 唔埋**：SystemServer crash loop `RuntimeException: Failed to create ashmem: No such file or directory`；根因 = A16-250627 ashmem lib 靠 kernel ashmem-memfd **compat ioctl**（GKI 先有），logcat 實證 `ioctl(ASHMEM_GET_SIZE): -1 != buf_size: 4096 , no ashmem-memfd compat support` → fallback `/dev/ashmem`（宿主無）。`androidboot.use_memfd=1`（`sys.use_memfd=1` 確認生效）都救唔到。
- 上游 issue：redroid-doc #862（同 build 250627）；fix = redroid-patches PR#5；**社群 fix image `teddynight/redroid16:latest`（layer `sha256:a8ec3238…`）实测 10 秒 boot_completed**。
- 注意：teddynight image fingerprint = `redroid/redroid_x86_64_only/redroid_x86_64_only:16/BP2A.250605.031.A3/eng.root:userdebug/test-keys` → 佢係 **64only 變體**（`abilist32` 空，冇 32-bit）。S3 若要 32-bit 故事要另行處理。

## STEP 2 — 起機讀值（getprop 實測，`evidence/s7-s2-props.txt`）

| prop | 值 |
|---|---|
| ro.build.fingerprint | `redroid/redroid_x86_64_only/redroid_x86_64_only:16/BP2A.250605.031.A3/eng.root:userdebug/test-keys` |
| ro.build.version.sdk / release | 36 / 16 |
| ro.product.cpu.abilist | `x86_64,arm64-v8a`（abilist32 空） |
| ro.dalvik.vm.native.bridge | `libnb.so`（庫缺實體，見 STEP 3） |
| sys.boot_completed | 1（起機 ~10s） |

- 截圖核（像素口徑：1080×2400、106 unique colors、非黑幀）：`evidence/s7-s2-boot-screen.png`（launcher 有內容）。
- **screencap 教訓：** 首幀未 submit 時 screencap 會食到純黑幀（frame=1 race）→ 等 2-3 秒先截，唔好即刻當黑幀拒絕。

## STEP 3 — 翻譯層實證（S1 目標，照實不美化）

1. **裝:** `/tmp/devcheckai-arm64only.apk`（abis={arm64-v8a}）原檔因 S1 拆 signing block → A16 裝入 `INSTALL_PARSE_FAILED_NO_CERTIFICATES`。Host 修復：`zipalign -p -f 4` + apksigner（BT34 jar + 新 RSA key）→ **`Success`**（PM 收 arm64-only = abilist 有效）。
2. **`dumpsys package` 核:** `primaryCpuAbi=arm64-v8a`、`secondaryCpuAbi=null`、versionName 1.1.2、pkg `com.deviceinsight.ai`。
3. **`am start` 行得:** `Displayed com.deviceinsight.ai/.ui.OnboardingActivity +157ms`；進程活（ps 可見）；**截圖見真 UI**（1080×2400 420ppp / 60Hz chips、狀態欄字體渲染）→ `evidence/s7-s2-devcheck-arm64.png`。
4. **但 native 翻譯未活（定讞）:** `logcat nativeloader: dlopen failed: "…/lib/arm64-v8a/libtrustnative.so" is for EM_AARCH64 (183) instead of EM_X86_64 (62)`（libdatastore_shared_counter/libkeyvault 同上）；app 進程 maps 冇任何翻譯器庫（只有 `libnblog.so` = redroid ashmem log lib，唔係 bridge）。**即 Java 部分真行、arm64 `.so` 全部 dlopen 被拒 → 翻譯層要 S3 自配先算真活。**

## 俾 S3 嘅交接

- 基圖建議：**官方 `16.0.0-250627` + 自打 ashmem fix（redroid-patches#5）** 或直接以 teddynight image 作 dev 基（生产鏡像名稱/來源要喺 S3 定，唔好默默用社群鏡像上生产）。
- 翻譯層候选：drop-in bridge 庫（ARC `libnb.so` 名正啱；注意 ITF version 教訓：A14 HAL 只收 ≤6）或 berberis；配 `ro.dalvik.vm.native.bridge` 指向實體庫 + 驗 dlopen。
- 64only 變體冇 32-bit ABI；stealth6 教訓（GMS 缺失時 Google 註冊 story）留 S4。
- 容器 `s7s2-a16` / port `16664` 留起，**唔好拆**。

## 證據清單

- `evidence/s7-s2-props.txt` — getprop 讀值
- `evidence/s7-s2-boot-screen.png` — 起機截圖（非黑幀）
- `evidence/s7-s2-devcheck-arm64.png` / `s7-s2-final-screen.png` — arm64 app UI 渲染
- `evidence/s7-s2-arm64-dlopen-evidence.txt` — EM_AARCH64 dlopen 拒絕 + init bridge override 原文
- `evidence/s7-s2-free-post.txt` — 起機後 RAM
