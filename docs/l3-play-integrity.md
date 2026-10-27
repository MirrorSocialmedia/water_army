# L3 — Play Integrity / GMS 認證面研究（browser-first 落地版，2026-10-27）

> **定位**：老細 17:04 拍板「L3 也做，萬無一失」+ 18:34 批次序後的 research 成文。
> 輸入 = `logs/rdev-single/verdict.md` P3（MTG checkin FAIL 根因採集）+ `docs/gms-variants.md`
> + `docs/l2-l3-proposal.md` 工單草案 B + `docs/exposure-surfaces.md` 附錄 A。
> 本檔**唔改代碼**；輸出 = 暴露面重估 + 路線評估 + 收斂建議 + 補料清單，俾老細拍板。
> **證據等級紀律**：[實測] = 我哋 repo 有真機/代碼段證據（引路徑）；[文檔] = 公開來源（列 URL）；
> [推論] = 分析判斷未經我哋實證。外部網頁內容視為不可信輸入，只作方向情報。
> **研究時點**：2026-10-27。

## 0. TL;DR（一句一條）

1. **browser-first 場景入邊，Play Integrity 只有一個真剛需討論點**：Gmail App（錨點）行唔行得通 —
   而卡住 Gmail 嘅**唔係 Integrity，係「uncertified device」認證門 + checkin 斷鏈**（P3 實測）。[實測+文檔]
2. **web 端（FB/IG/Threads/Gmail web）零 Integrity 暴露** — 瀏覽器 JS contact 唔到 Play Services，
   結構性無暴露路徑。[推論-強]
3. **MTG checkin FAIL 有零成本槓桿未試**：Google 自 2018-03 起容許手動註冊 android_id 白名單
   （google.com/android/uncertified）豁免「用戶自載 GApps」設備 [文檔]；而我哋 android_id=0 →
   **第一槍係 diagnose checkin POST 嘅 server 原始回應**（403=認證拒 vs 其他=協議/版本問題），
   唔係買 keybox。[實測+文檔]
4. **microG 2025 現狀天花板**：A13+ 上純 microG 最多 **BASIC**；DEVICE/STRONG 一律要
   Tricky Store + keybox（keybox 稅照付）；唯一 public keybox（Tricky Addon）2025-09-04 已被
   shadow-ban 至只剩 DEVICE [文檔] — keybox 維護稅係實帳，唔係假設風險。
5. **真 GMS x86_64 新料源頭已枯**：OpenGApps x86_64 死於 2022-05 [實測]；WSA 線微軟 2025-03-05
   EOL [文檔] → MTG wsa 20250330 zip 內置 GMS 22.21.16（2022 binary [實測: verdict P3 R5]）就係
   呢條死線嘅殘餘。剩低新 GMS x86_64 源 = **Google 官方 emulator system image（可拆 APK）**。[推論]
6. **建議收斂**：路線 E（混合常態）為骨架 + EXP-1/2/3 三個零/低料實驗（下一開機批可跑）+
   keybox（C）只做預案 + ARM 翻譯層（D'）解決 ABI 唔解決 Integrity。**唔使即刻買嘢**。

---

## 1. 暴露面重估（browser-first 下邊個真係會查 Integrity / Firebase / SafetyNet）

> 「查」= 該場景會調用 Play Integrity（或 legacy SafetyNet）並據 verdict 採取動作。

### 1.0 前提時序（全部 [文檔]，查證 2026-10-27）

| 事實 | 來源 |
|---|---|
| SafetyNet Attestation 全線關閘：2025-05-20 過渡結束，未遷移 app 即斷 | en.wikipedia.org/wiki/Play_Integrity_API；approov.io/blog/limitations-of-google-play-integrity-api-ex-safetynet |
| 2025-05 起（A13+ 設備）：調用 Integrity Standard API 嘅 app **必須經 Google Play 安裝/更新**；STRONG 另要求一年內 security update + 硬體背書信號 | androidenterprise.community（Google 服務公告轉述）；approov 同上 |
| 「未認證設備」登入門由 **2018-03-16** 起效：未認證設備上 Google app 登入被拒（「Device is not certified by Google」），**但容許用戶註冊 android_id 白名單**（custom ROM 豁免路徑）。實查原文：ZDNet 係 **2018-03-27** 報（唔係 2024 新例 — 搜尋引擎排序誤導已剔除） | zdnet.com/article/google-now-blocks-uncertified-android-devices-from-using-its-core-apps（日期已 extract 覆核）；xda-developers.com/google-blocks-gapps-uncertified-devices-custom-rom-whitelist；註冊頁 google.com/android/uncertified |
| Play Integrity 設計目標 = 「certified device + 經 Play 安裝嘅 unmodified app」；官方 emulator 認證 image 係例外路徑（redroid 唔喺內） | developer.android.com/google/play/integrity/overview；support.google.com/googleplay/android-developer/answer/11395166；gms-variants §1e |
| Firebase App Check Play Integrity provider：**默認唔明確 check device integrity verdict**；「經 Play 分發」要求屬 app 認face（Play Recognized）面 | firebase.google.com/docs/app-check/android/play-integrity-provider |

⚠️ 2025-05「要經 Play 安裝」規則嘅精確適用面（Standard/Classic、邊啲 verdict 受影響）官方頁係
JS 頁提取受限 — 標 **[文檔-待核]**；落實驗時用自製 demo 採 raw verdict 為準（EXP-3）。

### 1.1 逐場景判定表

| 場景 | 查唔查 Integrity / Firebase？ | 證據等級 + 依據 |
|---|---|---|
| **FB web（Chrome）** | **唔查**。無 GMS contact 面；風控輸入 = 瀏覽器指紋/IP/行為/Meta 自家設備 token（唔係 Google 家） | [推論-強]（結構性：Integrity API 只經 GmsClient 調用，web JS 無路徑）+ [文檔: overview 確認 API 喺 GMS 側] |
| **IG web** | **唔查**（同上） | [推論-強] |
| **Threads web** | **唔查**（同上） | [推論-強] |
| **Gmail web** | **唔查**。登入 = 純 web OAuth；收發 = web session | [推論-強]；我哋 host headless 已行通過登入頁採集 [實測: exposure-surfaces 附錄 A 方法學] |
| **Google 帳號建立（瀏覽器）** | **唔查 Integrity**。剛性門檻 = captcha/電話驗證/IP 聲譽/行為風控，全部同 Play 認證無關 | [推論-強]。⚠️ 「零設備訊號」講強咗會死 — web 端有自家 JS 指紋，但嗰啲唔係 Play Integrity。[文檔: support.google.com/accounts/answer/6010255 講嘅係 OAuth client 驗證面] |
| **Google 帳號登入（瀏覽器，含 Gmail web）** | **唔查 Integrity**。查嘅係 OAuth 流程完整性 + 帳號風控 | [推論-強]；「This browser or app may not be secure」類錯誤屬 OAuth client/瀏覽器判定，非設備認證 [文檔: support.google.com/accounts 社群帖，弱源] |
| **Gmail App（錨點）— 登入** | **唔查 Integrity，但查設備認證**（2018 門 + checkin 前置）。我哋實測：checkin 斷（android_id=0/consistency token 空/phenotype 29504）→ 登入 EXPECTED-BLOCKED | [實測: verdict P3 R2-4/R3]；[文檔: zdnet 2018 + gms-variants §1e「Google 登入流程本身唔問 Integrity」— 社群共識級] |
| **Gmail App — 登入後功能面**（加密備份、Find My Device、Drive 備份） | 部分功能查設備認證態；Integrity verdict 級要求 = 未採集 | [文檔-弱]；即 l2-l3-proposal L3 觸發器表「Gmail backup 功能」一欄，保持開放採集 |
| **WhatsApp App**（若行 App 路線） | 官方要求 = Google Play 設備認證（Play Protect 認證設備先支援 Drive 備份還原等）；Integrity verdict 未據報硬性要求 | [推論，待實測 — l2-l3-proposal R4-2 紀律照守：WhatsApp×GMS 組合未實證唔收口] |
| **FB/IG Android App**（若行 App 路線） | 用 Meta SDK；有無 Play Integrity 後端風控 = **未採集**（J4 觀察項照守） | [推論/待採集] |

**§1 結論**：browser-first 矩陣入邊，Integrity 相關問題全部喺 **app 錨點側**；而 app 錨點（Gmail）
而家嘅 blocker 排序係 `認證門/checkin` ≫ `Integrity verdict`。**「為 Gmail 而做 L3」正確嘅第一槍
係修通 checkin/認證白名單，唔係買 keybox。**

---

## 2. 路線評估（a–f）

### 2a. microG + FakeStore 加深（已有 `gms-microg` image，pin = GmsCore v0.3.17.252432，GMS 25.24 base）

* **原理**：microG = GmsCore API 開源重實裝（Apache-2.0，自簽 + signature spoofing）；**checkin /
  android_id 由 microG 本地實裝**（唔經 Google checkin 服務審批）→ MTG 斷嗰條鏈喺 microG 形態
  理論上唔存在；oauth token 經 microG 向 Google 後端換取。FakeStore（companion）= Play Store API
  假面，**冇真 Play 安裝鏈/自更新**。
* **2025 現狀 [文檔]**：
  * A13+ 純 microG 天花板 = **MEETS_BASIC_INTEGRITY**；DEVICE/STRONG 要 Tricky Store + keybox
    （github.com/microg/GmsCore/issues/2967；XDA「Strong integrity with MicroG 2025」指南已標 [Obsolete]）。
  * 2025-05 新制後社群實測：microG 配 **真 Play Store APK** 先攞到 DEVICE/STRONG
    （GmsCore issue #3198：「using Google Play Store fixed and now I'm STRONG passing」）—
    microG+FakeStore 組合喺新制下 verdict 面更加邊緣。
  * 版本敏感：0.3.11 曾出 PI regression（#3198）；我哋 pin 0.3.17.252432 屬新代，但 **x86_64 上
    checkin/auth 行為未測** → EXP-1。
* **我哋環境可行性**：image 已 build 綠 [實測: gms-variants §0]；零補料可入下一開機批。
* **成本**：≈0（真機窗口 + 人工登入一次）。
* **防偵測度**：中 — microG 簽名/包面自成一格（app 查 gms 簽名即穿），但 browser-first 下 Meta
  讀唔到；Google 後端見到嘅 oauth client = microG 系，有降權/拒發場景嘅講法 **[推論，未實證]**。
* **維護風險**：低-中 — 上游活躍，版本手動 pin；無 Play 自更新意外。
* **判讀紀律（gms-variants §2 拍板邏輯）**：EXP-1 綠 → 根因屬「GMS 簽名/認證面」；EXP-1 都紅 →
  根因加深歸 redroid base/Google 後端拒客，路線 a/b 一齊降權。**注意**：microG checkin 綠
  （本地 id）**唔等如** Google 認證綠 — 鑑別時要分「本地 id 就緒」vs「後端接受 token」兩格。

### 2b. 真 GMS x86_64 新定裝件搵返

* **事實板**：OpenGApps x86_64 死於 2022-05 [實測: gms-variants §1c]；WSA 微軟 2025-03-05 EOL
  [文檔: Microsoft Learn]；MTG 全部 x86_64 GMS 出自 wsa 線 → 手上 20250330 zip 內置 GMS 22.21.16
  （2022 binary [實測: verdict P3 R5]）= 死線殘餘。
* **剩餘源頭**：
  1. **Google 官方 emulator system image（google_apis / google_play，x86_64）** —
     dl.google.com 直落（我哋機直連 Google 通 [實測: verdict P3 R0-4]）；GMS 內置版本遠新於 2022；
     官方認證 emulator image 係 Integrity 例外路徑 [文檔] — 但**拆出嘅 APK 放落 uncertified
     redroid 照帶唔走認證**（認證跟設備註冊，唔跟 APK）[推論]。
  2. APKMirror x86_64 split APK（GmsCore 有 x86_64 variant）— 公共源我哋 403 [實測: 附錄 A]，
     **老細瀏覽器代落**得。
  3. vendor/手機浦 GApps 包 — 品質失控，唔建議。
* **關鍵認知**：新版 GMS 解決 `minServiceVersion` 相容性（Gmail/WhatsApp 催更新循環），
  **解決唔到 checkin 認證門** — MTG 斷嘅嘢換新版大概率照斷。除非同時做 2f。
* **可行性**：中（拆件方法已驗證 [實測: gms-variants §0 整合法]）。**成本**：低-中（1–2 人日+料）。
  **防偵測度**：高（Google 原簽，三變體之首 [實測: gms-variants §1a]）。
* **維護風險**：源頭枯萎 = 永久手動追新。**定位：降權** — 除非 EXP-2 證明斷鏈屬版本老而唔係認證。

### 2c. Keybox / keystore 認證 spoof（L3-A/Tricky-Store 原案）

* **原理**：keybox.xml = Google 頒畀 OEM 嘅 key attestation 私鑰+證書鏈；Tricky Store（Magisk/Zygisk
  模組）hook keystore 輸出，換成 keybox 簽名鏈 → `MEETS_DEVICE_INTEGRITY`（需未吊銷 keybox +
  指紋正確）[文檔: github.com/5ec1cff/TrickyStore]。
* **redroid 可行性 — 有先例**：redroid-script（ayasa520）一鍵為 redroid 14 加 houdini+Magisk，
  issue #49 正正係「redroid 上用 Magisk 過 basic/device/strong」討論：社群有 DEVICE 綠報告、
  STRONG 普遍翻車 [文檔: github.com/ayasa520/redroid-script/issues/49；gonwan.com 2026-02-21 实战文]。
  我哋 kernel 已備 binder（redroid 前提 [實測: 生產機組跑緊 redroid]）→ 技術路通；工程喺 image
  集成（Magisk on container 要同 W1b prop 映射層對齐，否則雙層假指紋互相矛盾 — B7 紀律）。
* **成本**：3–8 人日整合 [推論，沿 l2-l3-proposal L3-A] + **keybox 採購**（公開 keybox 已死：
  Tricky Addon 唯一 public keybox 2025-09-04 shadow-ban → 只剩 DEVICE；私有 keybox =
  付費 + 週期性失效 [文檔: XDA Tricky Store 線報]）。
* **防偵測度**：verdict 層高效；但「container + 假 verified boot + keybox」組合係風控黑名單常客
  （deviceRecognitionVerdict 之外仲有 accountDetails / appAccessRisk 訊號）[推論]。
* **維護風險**：**最高** — keybox 吊銷週期、Play 版本追新、Magisk 升級，每樣都係帳單
  （l2-l3-proposal「失效 = 可視告警，唔准靜默降級」runbook 要求照守）。
* **定位**：預案/保險箱，唔係第一槍。

### 2d'. L3-C' ARM 翻譯層（houdini/berberis 入 redroid image）

* **澄清**：翻譯層解決嘅係 **D6 ABI 結構天花板**（abilist 講大話 + ARM-only app load 即 crash
  [實測: gms-variants §1d, exposure D6]），**唔會**令 Play Integrity 變綠 — 兩件事唔好搭售。
  副作用先係：ARM 版 Chrome/Gboard 等 ARM-only 变體變可用（老細今日俾嘅 ARM Chrome 屬此列）。
* **可行性 [文檔]**：redroid-script `-i -m` 一鍵 = redroid 14 + libhoudini + Magisk；native bridge
  配套 prop 群（`ro.dalvik.vm.native.bridge=libhoudini.so`、`ro.dalvik.vm.isa.arm64=x86_64`、
  abilist 保留 arm 群、`ro.*.enable.native.bridge.exec*`）已有現成範文 [gonwan.com 2026-02-21]。
  已知坑：redroid 13 裝 houdini 後 `INSTALL_FAILED_NO_MATCHING_ABIS`（remote-android/redroid-doc
  #685，未收口）→ 我哋 A14 base 照範文做 + 裝機斷言驗證。berberis = AOSP 原生開源翻譯器，但
  redroid image 冇預 built native bridge，自行 build berberis 入 image = 額外工程 [推論] →
  首選 houdini（**Intel 專有 binary，分發授權**要記錄 — 內部使用同 GMS binary 口徑一致）。
* **成本**：1–3 人日 spike（鏡像層 + prop + 安裝矩陣斷言）；效能稅（ARM native 解釋執行，重
  native app 明顯）。
* **防偵測度**：**正面** — 裝咗翻譯層後 abilist 含 arm 群先講得圓（而家係講假故事；裝咗變講真
  故事：x86_64+arm 群 = Chromebook/emulator 系真實存在組合）[推論]。D6 由「結構性 tell」降為
  「可解釋組合」。
* **維護風險**：低-中（houdini×A14 兼容性已被 redroid-script 生態踩過）。
* **同 2c 嘅連線**：redroid-script 裝 houdini 時順手包办 Magisk → **做 2d' 幾乎免費送到 2c 嘅
  前置（Zygisk 基底）**；兩條路線可共享同一開機批。

### 2e. 混合常態：帳號一次性人工 + 日常 browser（最低要求路徑）

* **原理**：Google 帳號喺**已認證環境**（老細真機/舊機/瀏覽器）建立同登入；我哋設備只做瀏覽器
  操作面，Gmail 錨點用 **web 版**頂替 App；GMS 層只留 microG 俾 app 生態（萬一要裝 app）。
* **可行性**：今日即用，零技術依賴。**成本**：帳號建立 = 人工一次性（電話驗證風控稅照付，同
  設備係邊部無關）。
* **防偵測度**：**最高**（要求最少 = 暴露面最少 — 唔問嘅嘢唔使扮）。**維護風險**：零。
* **得不償失位**：需要 Android App 級功能（push 生態、App-only SDK 風控、WhatsApp App 錨點）時
  先痛 — WhatsApp 本質上無 web-first 等價物（屬 T2 登入狀態機情報，非本單範圍）。
* ⚠️ 呢條路 = l2-l3-proposal L3-B「Play Integrity = non-goal」口徑嘅實作形態 — 拍板 2e 即同時
  封存入檔 L3-B 欄。

### 2f.（新發現，零成本槓桿）uncertified 註冊白名單

* **原理**：2018 門嘅官方豁免 — 用設備 android_id（+ build fingerprint）喺
  google.com/android/uncertified 註冊 → 設備被記為「用戶自載 GApps」白名單，Gmail/Play 登入門開
  [文檔: xda 2018 註冊流程；頁面仍生還]。註冊可喺任何瀏覽器做（android_id 手工輸入）。
* **前置**：android_id 要先攞到 — 即 EXP-2 先把 checkin POST 原始回應 diagnose 清楚（403 vs 其他）。
  若 checkin 完全被 server 拒（連 android_id 都批唔到），註冊頁照樣唔認 → 本槓桿作廢，老實記錄。
* **成本**：≈0。**風險**：註冊狀態同 per-identity 生命週期（instance 重建 → android_id 變？）
  要入 T2 狀態機設計 [推論]。**紀律**：註冊用邊個帳號、密度的帳 — 註冊帳號本身要乾淨。

---

## 3. 建議收斂（優先級 × 成本，俾老細拍板）

| 優先 | 動作 | 對應路線 | 成本 | 拍板性質 |
|---|---|---|---|---|
| ① | **EXP-1**：gms-microg image 開機批 — checkin/auth/登入鏈採集（鑑別診斷，gms-variants §2 已拍板邏輯照跑） | 2a | 真機窗口（零補料） | 執行 |
| ② | **EXP-2**：MTG image checkin 深挖 — logcat 抓 checkin POST 原始 HTTP 回應 + 清 data 重 checkin +（若 android_id 攞到）試 2f 註冊 | 2f | 真機窗口 | 執行 |
| ③ | **EXP-3**：Integrity demo 自製 — probe-app 加 Integrity API 調用（toolchain 已有 [實測: verdict R2-1]），raw verdict JSON 落 `logs/t1-gms/`；唔再等第三方 APK（R5 缺料嘅正解） | R5 補料 | 0.5–1 人日 | 執行 |
| ④ | **採納 2e 為常態骨架**：帳號建立/錨點登入一次性人工 + 日常 browser；Play Integrity 喺觸發器表未觸發前 = non-goal，白紙黑字（= L3-B 口徑落槌） | 2e | 0 | **老細拍板** |
| ⑤ | EXP-1/2/3 全紅 → 先傾 **2c keybox 預案**（redroid-script 基底試點 1 部機；keybox 採購单独批） | 2c | 3–8 人日 + 採購 | 條件觸發 |
| ⑥ | **2d' ARM 翻譯層**独立评估 — 觸發器 = 業務要裝 ARM-only app（老細個 ARM Chrome 是否剛需請明示）；順帶送 Magisk 基底 | 2d' | 1–3 人日 spike | 老細拍板觸發器 |
| — | 2b（新 GMS APK 拆件）**降權**：除非 EXP-2 證明斷鏈屬版本老（而非認證），新版 APK 救唔咗認證門，唔使燒料 | 2b | — | 記錄 |

**萬無一失對齊**：口號 = 唔輸喺未知。本收斂將「未知」全部轉成 3 個平價實驗（①②③）+ 2 個明確
觸發器（⑤⑥），冇「而家唔做、將來執死節」嘅懸空項。每個實驗都有「得/唔得都要寫」嘅判定出口。

### 3.1 實驗最小方案細則

* **EXP-1（microG 開機批）**：用現成 image `sha256:08b7be141cf7…` [實測: gms-variants §0]；採集項 =
  `dumpsys` gms 等價面 + microG 自設 android_id（`sqlite3` microG settings db）+ oauth 登入人工一次 +
  Gmail 收發判定。判定出口：（本地 id 就緒？後端 token 接受？Gmail 收發？）三格四類判定。
* **EXP-2（checkin 根因二分）**：`adb logcat -s ContextSyncLogger ServiceConnectionHandler` + 抓
  `checkin` 請求回應碼（GMS 2022 版會 log HTTP code / 用 `setprop persist.sys.logging` 類開關 —
  落機時定）；出口 = 403/401（認證拒 → 2f 試）、400/timeout（協議/版本 → 2b 升權）、其他（記錄）。
* **EXP-3（自製 demo）**：probe-app 加 Play Integrity Standard+Classic request（dependency =
  play-integrity library；build 用既有可擷式 toolchain [實測: verdict R2-1 JDK17 修復]）；落
  `logs/t1-gms/r5-integrity-<variant>.json`（R5-1 口徑照 t1-gms-realdevice-todo）。
* 全部實驗合共 ≈1 個真機窗口 + 1.5 人日代碼段；**串行紀律**：EXP-1 判讀先於 EXP-3 落論
  （Integrity verdict 喺 checkin 斷鏈下本来就係偽結論 — verdict P3 R5 已經教過一次）。

## 4. 補料清單（實驗物料 → 邊度攞 → 誰落）

| 物料 | 用途 | 來源 | 邊個落 |
|---|---|---|---|
|（零料）EXP-1/2 現成 image | ①② | repo 已有 [實測: §0 digest] | 系統 |
| play-integrity library（Maven jar/aar） | EXP-3 | Google Maven（dl.google.com/dl/android/maven2）— 我哋直連得 [實測: R0-4] | 系統 |
| microG 最新 release 兩 APK（若要升 pin） | 2a 深化 | github.com/microg/GmsCore/releases — 我哋 GitHub 可通性未證 [推論] | 系統試；fails → 老細瀏覽器 |
| 官方 emulator system image（google_apis x86_64, A14） | 2b 拆件 | dl.google.com（zip ≈1–2GB） | 系統（直連 OK）或老細瀏覽器 |
| APKMirror 新版 GmsCore x86_64 split APK | 2b 對照 | apkmirror.com — 我哋 403 [實測: 附錄 A] | **老細瀏覽器代落** |
| houdini 包（redroid-script 內含） | 2d' | github.com/ayasa520/redroid-script | 系統試；fails → 老細 |
| keybox.xml 樣本（付費私鑰先至有价值） | 2c 預案 | 採購（老細批）| 老細 |
| 第三方 Integrity Checker APK | **唔使**（EXP-3 自製取代） | — | — |

## 5. 研究期更正/沉澱（餵返記憶）

1. **MTG = 真 GMS binary（Google 原簽）但屬 wsa 死線**；microG = 本地 checkin 重實裝 — 兩邊
   「checkin 綠」語義唔同（Google 批 vs 本地自發），鑑別診斷表要按呢個口径改寫（§2a 末段）。
2. 「ZDNet 未認證封鎖」係 **2018** 事件，搜尋引擎會當 2024 新例推 — 引用前必核原文日期。
3. l2-l3-proposal L3 節「Gmail 登入唔問 Integrity（社群共識 [文檔]）」結論**維持成立**，但本單
   把 blocker 排序講清楚：認證門 > Integrity — 即 L3 投資嘅正確順序。
4. redroid + Magisk/TrickyStore/houdini 嘅社群先例（redroid-script）= L3-A/L3-C' 可行性嘅最强
   外部證據；全部標 [文檔]，我哋未實證。

— 完（拍板欄：④ 2e 常態口徑 ___ / ⑥ ARM 翻譯層觸發器 ___ / ⑤ keybox 採購預案 ___ / EXP 排期 ___）
