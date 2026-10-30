# S2 — stealth4 image 工程方案（WA-FIXALL gen1 起步，2026-10-30；接力段執行）

## 目標
stealth3b 基座（image 27bd064d / layer fc849e97 / template fx-adv-stealth3 已指 stealth3b）之上，
**修 GMS 洩漏面 + display/BeginFrame 根治候選**，產出 stealth4 試胎機（唔急起新機：方案先喺度）。

## 1. APK 組裝（APKMirror，Android 13 = API 33 對版）
- **GmsCore（Google Play services）**：APKMirror 有 `minapi-33` variant 篩選頁（apkmirror.com/apk/google-inc/google-play-services/variant-{"minapi_slug":"minapi-33"}）；26.4x 代 x86_64 變體有貨（83–195MB，2026-10 現況）。揀 **x86_64、minSdk≤33、2025 年代版本**（唔好再 22.21.16 = R51 洩漏點：2022 代 GMS check-in version code 過舊）。
- **GSF（Google Services Framework）**：APKMirror「Google Play services (Framework)/Google Services Framework」搵 arm64/x86_64 兼容、版本配對 GmsCore；注意 redroid 用 system partition 裝法（/vendor/overlay 或 remount /system/priv-app）。
- **配套**：Phonesky（Play Store）可唔裝（D4 唔經 Play）；三件套 vending/gms/gsf 版本三角要 check-in 互相 accept（GmsCore versionCode 要 > 機上現有 222116xx）。

## 2. 裝機方案（dump / feature xml / oemprop 三件セット）
- **dump 邊啲包**：`adb shell pm list packages -f` 對比 stealth3b vs 真機基準（Nothing/realme 中旗艦）：確保 `com.google.android.gms` versionName 2025+、`com.google.android.gsf` 存在；`dumpsys package com.google.android.gms | grep version` 入 evidence。
- **point 邊啲 feature xml**：`/vendor/etc/permissions/` — 確保無 redroid/goldfish 痕；補真機缺嘅 `android.software.*`（真機 dump 對照）；刪 redroid 自帶可疑 feature 行。
- **oemprop 加邊啲欄**（R51/R52 入賬項）：
  - `radio.noril`（基帶版本欄仿真機，而家 baseband 洩露）
  - `ro.build.type=user`（stealth 現況 check）
  - `ro.product.brand/model/name + ro.serialno`（逐機獨一 ✓ 已有）
  - `ro.build.date.utc` / `ro.build.version.security_patch` → 2025/2026 值（kill R51 2.4 年無 OTA 痕）
  - `net.hostname` → 唔好 localhost（R52；用 `<hostname>` 形如 `<user>-<model>`）
  - `ro.bootimage.build.fingerprint` 無 redroid/goldfish/qemu 字面（R52 正面項保持）
- **執行載體**：新 template `fx-adv-stealth4`（copy stealth3b 改 oemprop+permissions+GMS 裝機 layer）；一次一版，改 layer 唔改 base image。

## 3. display / BeginFrame 根治候選（S1 殘餘 wall 嘅長期解）
S1 實證 `Page.captureScreenshot` timeout + rAF 死 = renderer BeginFrame 缺席（R13 家族）。stealth4 測試向量：
- 候選 A：`debug.sf.auto_latch_unsignaled=1` + `debug.sf.hwc.min_duration=0`（SF latch 唔等 signal）
- 候選 B：`persist.sys.surfaceflinger.enabled=true` + 唔好 disable hwc（hwc2 passthrough vs fake）
- 候選 C：`--disable-gpu` 相反方向 = 俾 Chrome 真 GPU（R35 唔准帶 disable-gpu = 已係呢邊；試 `--use-gl=angle --use-angle=swiftshader` vs `--enable-gpu-rasterization` 組合）
- 收法：CDP `Page.captureScreenshot` 200 出幀 + rAF fire + birthday→username transition 過到 = 全鏈 wall 根治。

## 4. 接力段執行清單（未做，照做就得）
1. APKMirror 落 GmsCore x86_64（minapi≤33、2025+ 代）+ GSF 配對版 → sha256 記錄
2. 喺 fx-adv-stealth4 template 裝機 + oemprop 表上欄 + permissions 清理
3. leakscan 重跑（GMS check-in version code、baseband、hostname 三樣 must 改善）
4. display 候選 A/B/C 逐個試（每个一振）→ S1 殘餘 wall 覆核（birthday→username）
5. 全過先起 stealth4 試胎機跑 D4 replay 到 password 步

## 紀律
- 紅線照守：唔 submit、唔開戶、零 secret 入 repo、RAM gate（~10.5G）唔硬來、禁碰 {rdev-f1, redroid-mc-dogfood-*}。
