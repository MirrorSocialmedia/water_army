# T1 GMS 真機段待辦清單（R0–R6 · 自足成單，照 W1b 口徑）

> 前提：代碼段 COMPLETE（2026-10-27，本文檔配套 `docs/gms-variants.md`）。
> 執行環境 = 真機（RAM gate 解除 + qwen27B 段後）。**只准隔離設備（`rdev-gms-*`），零碰生產設備/生產 image；RAM gate 封鎖期間唔准開 redroid。**
> 紀律：每步 evidence 落 `logs/t1-gms/`；失敗 = 記錄 + 停，唔好繞過斷言；順序 = MTG → microG（鑑別診斷邏輯見 gms-variants.md §2）；OG 默認跳過。
> 判定四類（每個 R 段收口都要落）：**PASS** / **FAIL**（根因寫明）/ **PARTIAL**（邊度得邊度唔得）/ **INCONCLUSIVE**（環境缺料，列重跑條件）。

## R0 前置（環境 + 物料）
- [ ] R0-1 兩變體 image digest 核對：MTG == `sha256:02ab5675ba15f4acadaf21544a9e28aa5af774c3dd6a7e53e8b74d002fa4ecee`；microG == `sha256:08b7be141cf761e22f04af9e8881b602b119a54b9745a7f52a057dce7d1b5c38`；唔一致 = 照 `images/gms-*/build-record.md` 重建 + 記錄新 digest + 輸入 zip/APK sha 復核
- [ ] R0-2 host 基線快照：RAM gate 狀態、用戶 stack 健康、`binderfs`/`binder_linux` preflight PASS（`logs/t1-gms/r0-host-baseline.md`）
- [ ] R0-3 隔離設備建立：`rdev-gms-mtg-01`（+ microG 段先至開 `rdev-gms-mg-01`）— 用現有 device API 指定變體 image；**唔准**用 template profile / ro overrides（W1b 層合併留後，見 §3 of gms-variants.md）
- [ ] R0-4 出料口預檢：設備出口 proxy/egress 可達 `android.clients.google.com` + `play.googleapis.com` + `mtalk.google.com`（DNS+TLS 層先測，唔使 app）

## R1 變體 image 開機
- [ ] R1-1 MTG image boot `rdev-gms-mtg-01`：boot-to-boot_completed 時長 vs stock 基線記錄（>120s 或 loop = FAIL 根因採集：`dmesg`/`logcat -b init,system` 落 evidence）
- [ ] R1-2 `sys.boot_completed=1` + `adb devices` 穩定在線 ≥5 min（無 restart loop）
- [ ] R1-3 分區實證：`adb shell ls /product/priv-app/GmsCore /product/priv-app/Phonesky /system_ext/priv-app/GoogleServicesFramework` 全部存在；`pm list packages | grep -E "gms|vending|gsf"` 三者齊（呢步同時驗證 partition symlink merge 佈局喺 runtime 可見）

## R2 GMS 進程就緒探針
- [ ] R2-1 `am start-activity` 起 Phonesky（首次會 self-update 循環 — 觀察 10 min，logcat `FootspyRuntime` 落 evidence）
- [ ] R2-2 探針斷言：`dumpsys activity broadcasts | grep -c GSF` + `ps -A | grep -E "gms|vending|gsf"` — GmsCore 進程（`com.google.android.gms` / persistent 進程 `:persistent`）就緒 = PASS 條件；記錄全部 UID/進程名
- [ ] R2-3 探針斷言：`content query --uri content://com.google.android.gsf.gservices` 有回應（GSF content provider live）
- [ ] R2-4 `logcat -d | grep -iE "checkin|androidId"` — device checkin 成功拿到 androidId（GMS 同 Google 後端握手實證；失敗 = 記錄 HTTP 層根因再停）

## R3 Gmail 裝機 + 登入
- [ ] R3-1 裝機：Play Store 搵 Gmail（若 R2-4 checkin 成功 Store 先會俾搜尋結果 — 呢個本身就係判定證據）；fallback `adb install` APK（記錄邊條路）
- [ ] R3-2 登入：人工代登 1 個測試 Google 帳號（OAuth web flow via microBrowswer/UI）；記錄 flow 截圖 + `adb logcat` OAuth token 獲取證據
- [ ] R3-3 收發實測：send→receive 一封郵件 ≤5 min；同步開 `Settings→Accounts→Google→sync mail` 狀態證據
- [ ] R3-4 24h 留存觀察（登入唔會 session kill、sync 穩定）— 跨日先收 R3 判定

## R4 App 相容性矩陣（WhatsApp 待證項 + native 實載）
- [ ] R4-1 WhatsApp 裝機（x86_64 ABI 實證：`dumpsys package com.whatsapp | grep nativeLibraryDir` + `ls` 該目錄 `.so`；crash = tombstone 落 evidence → 呢個就係 §1d ABI 風險嘅實證答案）
- [ ] R4-2 WhatsApp 登入 + 收發（手機號 SMS flow）；microG 段 = 同一流程喺 `rdev-gms-mg-01` 重跑（**待證標注正式收口呢步**）
- [ ] R4-3 Drive backup 入口狀態記錄（MTG 应見 Google 帳號選項；microG 段記錄 spoof 定 fail）
- [ ] R4-4 native crash 掃描：`logcat -d | grep -c "dlopen.*failed\|UnsatisfiedLink"` 全目標 app 走一轉（arm-only 風險情報面）

## R5 Play Integrity 採集（只讀，唔修復）
- [ ] R5-1 裝 Play Integrity API Demo（或 probe app 內建调用）→ 記錄 `meetsBasicIntegrity / meetsDeviceIntegrity / meetsStrong… / evaluationType` raw JSON 落 `logs/t1-gms/r5-integrity-<variant>.json`
- [ ] R5-2 對照組：stock redroid（無 GMS）開唔到 Play Integrity = 記錄「測試可行性」本身；如需真機對照借 1 部認證機行同一 demo（可選，有就更好）
- [ ] R5-3 結論直接引用去 gms-variants.md §1e 預期核對（預期 FALSE — 中唔中都要寫）

## R6 收口 + 四類判定報告
- [ ] R6-1 判定表：每變體 ×（開機/GMS 就緒/Gmail/WhatsApp/Integrity）× 四類判定，根因+evidence 路徑逐格填；報告落 `logs/t1-gms/t1-verdict.md`
- [ ] R6-2 根因歸屬判定：若 MTG 全紅 → 斷言根因喺 redroid base（引用具体 R 步 FAIL 證據）；若 MTG 綠 microG 紅 → 歸屬 GMS 簽名/spoof 面；兩綠 → 兩條路都可選，餵 T2
- [ ] R6-3 情報餵下游：T2（登入狀態機輸入：登入可行性/時延/人工介入點）、T5（Gmail 批量建立可行性）、老細（OG 係咪永久跳過；兩層合併（GMS×W1b 指紋層）立项與否）
- [ ] R6-4 隔離設備 teardown：`rdev-gms-*` 全部刪除 + 數據目錄清理（「唔准碰全部設備/正式映像」紀律嘅物理收尾）；用戶 stack 零波動覆核
- [ ] R6-5 失敗路徑：任何 R 段紅 = 圖文並茂 report，唔好自行放寬斷言（斷言口徑改動要過 ADR 修訂）
