# T1 GMS 變體路線比較（代碼段 · 2026-10-27）

> 範圍紀律（老細原話）：「隔離測試設備先證一部機用得 Google；唔准直接改正式映像或全部設備」。
> 本單只新增 `images/gms-*` 三個變體目錄 + 本文檔。**零碰**現有 services/UI/schema/生產路徑；
> **紅線**：變體全部基於 stock pin `redroid/redroid:14.0.0-240527` 建造，W1b 定制 image 嘅
> carrier/`ro.*` 映射層**未合併**（兩層合併 = PoC 有結論後嘅獨立決策，避免將兩個未驗證變數疊埋）。
> 真機段 R 清單（自足成單）：`docs/t1-gms-realdevice-todo.md`；evidence → `logs/t1-gms/`。
>
> **拍板記錄（老細 2026-10-27，T3 文檔對齊成文）**：① **OG（OpenGApps）永久跳過** — 線已死（§1c：x86_64 停喺 2022-05/Android 12.1，無 13/14），真機段唔再為佢入料/測試，變體目錄保留作記錄；② **MTG 先行 + 鑑別診斷邏輯照守** — MTG 紅 = 根因歸 redroid base（其他變體唔使再試）；MTG 綠 microG 紅 = 根因歸 GMS 簽名/spoof 面（§2）；③ **GMS × W1b 指紋層合併 = PoC 通過後先傾** — R1–R6 出正面結論前，兩層維持零交集（§3）。

## 0. 變體現況總覽（代碼段產物，2026-10-27 實測）

| 變體 | 輸入 pin | build | image ID / digest | size |
|---|---|---|---|---|
| `images/gms-mtgapps` | MTG `MindTheGapps-14.0.0-x86_64-20250330.zip` sha256 `ea6738b4…990d7f` | ✅ GREEN | `water-army/redroid:14.0.0-240527-gms-mtg` `sha256:02ab5675ba15…a4ecee` | 3.69 GB（base 共享 + ≈0.49 GB delta）|
| `images/gms-microg` | microG `v0.3.17.252432` 兩 APK（sha 見 `images/gms-microg/SOURCE-PIN.sha256`）| ✅ GREEN | `water-army/redroid:14.0.0-240527-gms-microg` `sha256:08b7be141cf7…1b5c38` | 3.2 GB |
| `images/gms-mtg-arm`（L3-C' ARM 翻譯層，叠加於 gms-mtg）| houdini `rote66/vendor_intel_proprietary_houdini@0c149b1`（md5=redroid-script A14 pin `d9703a9b…`）+ `redroid_libhoudini_hack@a2194c5`；pin 見 `vendor/arm-translator/SOURCE.md` | ✅ GREEN | `water-army/redroid:14.0.0-240527-gms-mtg-arm` `sha256:5c24b8b678b2…c4a8b8` | gms-mtg + ≈0.35 GB delta |
| `images/gms-opengapps` | OG `open_gapps-x86_64-12.1-pico-20220503.zip`（最後一個 x86_64 build，2022-05）| ⏸ 缺料（SF WAF 403 擋 datacenter IP；手動入料口徑見 `images/gms-opengapps/SOURCE.md`）| — | — |

整合方法（MTG/OG）：GApps flashable zip 本身已帶扁平分區佈局（`system/product/**`、
`system/system_ext/**`，連 privapp-permissions/sysconfig XML），解包後 per-subdir COPY 入
`/product/`、`/system_ext/`（base 呢兩個係 symlink → 實際 merge 入 `/system/product/`、
`/system/system_ext/`，export audit 驗證）。**唔使**自行實裝 recovery 安裝腳本。
陷阱記錄：`COPY --from=stage /stage/ /`（根目錄級 COPY）會**替換** base 嘅 partition symlink
變實目錄，遮蔽 base 358 個 product 檔 — 已修（見 `images/gms-mtgapps/build-record.md`）。

## 1. 三路線 × 風險矩陣

### 1a. MindTheGApps（PoC 首選，front-runner）
* **性質**：LineageOS 官方推薦；APK 直接抽取自 Google 官方系統 image（**Google 原簽**，非重簽）。
* **認證風險**：APK 簽名正統，但**設備層面仍然 uncertified** — Play Integrity 嘅 `meetsDeviceIntegrity` 需要設備通過 Google 認證清單，自砌 redroid image 大概率 FALSE（呢個同 GApps 來源無關，係 redroid 宿命；見 §1d）。Gmail/WhatsApp **登入**用唔着 device integrity，只係部分功能（backup 加密、Find My Device 類）會受影響 → R 段老實採集。
* **x86_64 適配**：呢啲 x86_64 build 本身出自 WSA 線（Intel 維護過），即 x86_64 native 完整 — 三條路線入面唯一「同 A14 base 同代 + x86_64 正經出身」。
* **版本匹配**：14.0.0 == redroid 14 base ✓（API 34）。
* **授權**：Google 應用二进制 = 免費分發但 Google 版權（非 open source）；內部使用無礙，**唔make 呢個變體落公開市場**。

### 1b. microG（spoof 路線，備胎）
* **性質**：Apache-2.0 open source，GmsCore API 重實裝，自簽（microG key）。
* **認證風險**：無 Google 簽名 → Play 生態「正版性」全部唔成立；Play Integrity = 基本無望（microG 無 attestation 硬關鍵路徑，Play 本身亦唔係真 Play）。
* **Gmail 相容**：microG 帳號同步（sync + auth token）撐到 Gmail 基本收發；**Push 用 microG 自己嘅 channel**，延遲/可靠性要實測 → R4 判定。
* **WhatsApp 相容（待證標注，老細要求寫明）**：WhatsApp 核心行唔靠 GMS（無 GMS 手機可用），但 Google Drive backup /位置服務 行 GMS API；理论上 microG token 路徑撐到登入同收發。**此為推斷，未實證 — R4-2 必須實測WhatsApp + microG 組合先可以收口。**
* **好處**：體積細、可控、零認證索求 — 若业务只需「App 收發訊息 + 唔需要 Google 後端」，呢條最乾淨。

### 1c. OpenGApps（control arm，已知硬伤）
* **事實（實查 2026-10-27）**：x86_64 build 停留喺 **2022-05-03**（GitHub repo + SourceForge 双證），最高 Android **12.1**，無 13/14 版本。項目實質停擺。
* **含義**：塞入 A14 base = 2022 年 GmsCore 版本。Gmail/WhatsApp 對 GmsCore 有 `minServiceVersion` 要求，2022-era（≈12xxx code）大概率被拒或催更新循環；設備無真 Play 自更新通道（uncertified）→ 無法自愈。「非認證 GApps 風彈」— 保留作對照組，**唔係争氣之选**。
* **授權**：同 MTG（Google 二进制）。

### 1d. x86_64 ABI 縮水實情（可能硬伤 — 誠實記錄）
* 【2026-10-27 L3-C' 實測更正】「64-bit only」對 `14.0.0-240527` pin **唔成立**：base build.prop `ro.zygote=zygote64_32` + `/system/lib` 有完整 i386 運行時（libandroid_runtime.so = ELF 32-bit i386，實物核）；abilist（system+vendor 兩層）已如實列 `x86_64,x86,arm64-v8a,armeabi-v7a,armeabi`，`ro.enable.native.bridge.exec=1` 已開，但 `ro.dalvik.vm.native.bridge=libnb.so` 指向**唔存在嘅庫**（redroid-doc #933 同類 bug）= 「宣講 arm 但冇翻譯層」先係真實缺陷，而唔係缺 32-bit。翻译層照舊冇預裝 — 補齊即 `images/gms-mtg-arm`（L3-C'）。
* **後果（修正版）**：arm-only app 照樣裝得（abilist 已含 arm 群）但 native load 即 crash，直到翻譯層入場；ARM32 app 有 zygote32 可用 = 結構上可行。
* T1 目標 app 群逐一研判：GMS（MTG=WSA 線 x86_64 ✓）／Play Store（x86_64 ✓）／Gmail（universal，x86_64 ✓ — WSA 常年運行實證）／WhatsApp（x86_64 native lib 存在 — WSA/x86_64 裝置公開可用實證；R4 首跑仍需確認 `adb shell dumpsys package com.whatsapp` nativeLibraryDir 實載）。
* **真正風險喺目標 app 群以外**：如果後續运营要裝小眾 app（銀行/電商 SDK），arm-only 係結構性天花板 — 屬 T1 結論要餵畀嘅決策情報，唔係 T1 本身 blocker。

### 1e. Play Integrity 預期（三路線共同天花板）
`meetsBasicIntegrity`／`meetsDeviceIntegrity`／`meetsStrong…` 對 uncertified container 設備預期全部 FALSE（emulator/redroid 社群一致共識；官方認證 emulator image 係例外路徑，redroid 唔喺內）。**T1 唔修復、只採集** — 若业务需要 device integrity，出路係（i）DroidGuard 補丁類方案（高維護）或（ii）接受 integrity 缺失 + app 層容忍 — 呢個結論直接餵 T2 登入狀態機設計（Google 登入流程本身唔問 Integrity）。

## 2. 真機 PoC 建議順序 + 理由

1. **MTG 先行**（R1→R5）：版本匹配 + Google 原簽 + x86_64 正經出身 → 單一變體將「GMS 進程就緒 + Gmail 登入」兩個核心問題以最高成功概率證明；若 MTG 都唔得，問題喺 redroid 本身（base/kernel/GMS 依賴面），其他變體無須再試。
2. **microG 次之**：MTG 成功 → microG 作為低依賴備胎驗證 WhatsApp 組合（R4-2）；MTG 失敗 → microG 驗證「無 GMS 簽名路线」定「redroid 容器本身」邊個係根因（鑑別診斷）。
3. **OG = 永久跳過（老細拍板 2026-10-27）**：已知停擺 + 版本錯配，真機段唔再安排 OG 測試/入料；`images/gms-opengapps` 目錄連構建口徑保留作記錄，重開需新拍板。
4. 四類判定（PASS/FAIL/PARTIAL/INCONCLUSIVE）口徑 + 步驟 → `docs/t1-gms-realdevice-todo.md`（R0–R6，evidence `logs/t1-gms/`）。

## 3. 兩層合併留待 PoC 後嘅決策點（老細已拍板：PoC 通過後先倾）

W1b 映射層（`/vendor/etc/init/oem-ro-map.rc` + `oem-propctl`）同 GMS 層目前零交集：
GMS 變體用 stock ro.*（redroid 默認指紋）。合併順序、GMS 對偽裝指紋嘅反應（GservicesChecks
對 build fingerprint 嘅校驗面）、待老細逐項拍板後先做；**前置條件已拍板（2026-10-27）= 真機 PoC（R1–R6）通過後先立项**。本代碼段刻意將兩個變數隔离。

## 4. 出口（egress）前提 — 2026-10-27 EXP-2b 實測回填

**本宿主/國內上游網絡直接黑洞 Google DC 段**（172.217/142.250/74.125/173.194：ICMP、tcp80、tcp443 全丟；宿主直連都係咁）；
去 Google **唯一路徑 = 用戶 loopback 代理 mihomo `127.0.0.1:7897`（HTTP CONNECT，Clash Verge，僅綁 loopback）**。
容器 NAT/轉發/MTU 全部正常（58.254 gstatic edge 機內 OPEN、DF 1450B 到 8.8.8.8 過）——「checkin 出唔到機」
= 網絡現實，唔係 bug。證據 + 鑑別矩陣：`logs/l3c-arm/exp2b/{diagnosis.md,ondevice-diag*.txt,generate204-proof.txt}`。

**正確姿势（已入腳本）**：
1. `scripts/rdev-single/egress-proxy.sh start`（或 boot 時 `EGRESS_PROXY=1`）= gost sidecar 綁 scratch bridge GW
   （172.38.223.1:18443）chain → 127.0.0.1:7897；用戶 mihomo 配置零改動。
2. 機內 `adb shell settings put global http_proxy <GW>:18443`（Android 全局代理；GMS/vending 食呢個；持久化跨 reboot/pm clear）。
3. 驗證：機內 CONNECT → `200 Connection established`；GMS reason-1（boot+~68s，默認 CMD 先會自動觸發）→
   logcat `Checkin Succeeded` + `/data/user/0/com.google.android.gms/files/checkin_id_token` 有 `AID:token`。

**生產含義（老細 21:51 確認）**：W3 出口代理綁定由『設計選項』升級為**硬性必須** — 三條 GMS 路線（MTG/microG/OpenGApps）
嘅 checkin/register/push/phenotype 全部依賴去得切 Google；出口代理規格要入 W3 設計（綁定方式、fail 偵測、斷線告警）。
