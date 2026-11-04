# WA-STEALTH6 T6 閉環收口（gen12 closure）— DevCheck 10→100 戰績、指紋面抽樣、零回歸核、D4 復機檢查表

**Date:** 2026-11-04 (Asia/HK)
**Baseline:** HEAD = origin/main = `19fa0b3`（segment 開始確認 clean）
**Test bed:** fx2（`redroid-rdev-fx2`，image `wa-stealth6:gen11b-rec` = final template；image ID `sha256:7120dbbd5ec65134…`，content 1,218,517,731 B / virtual 4.29 GB）。fx1（stealth4）對照零觸碰；`rdev-f1`、`redroid-mc-dogfood-1/2` 照舊 Exited 零觸碰。
**紅線紀律:** D4 凍結（冇 submit/開戶）、冇郁 image（發現問題即報）、冇砌圖、冇改代碼、冇起新機、零 secret、host adb 全路徑。
**Reads 檔:** `t6-closure-field-reads.txt`（同目錄，本檔所有讀值出處）。

---

## 1. 戰績表（DevCheck 主線：10 → 25 → 79 → 82 → 97 → 100）

| 跳 | 分數 | 觸發改動（邊個 commit / image digest） | 前 → 後關鍵讀值 | 證據圖（repo 內） | 前後讀值路徑 |
|---|---|---|---|---|---|
| **基線** | **10/100 capped**（raw 46） | stealth6-v1 `sha256:344980b84edf…`（base stealth5）；T1 abi props + T2 sensors HAL 入圖 | cloud tell `x86_abi:x86_64` −25 壓 cap 10；wx −15、sensors(prox) −8、model −3、adb −3 | `screens/dc-dashboard-stealth6-v1.png`、`screens/dc-trust-details-stealth6-v1.png` | progress 2026-11-03 gen2 段；`t1-fx2-onboarding.png` |
| **10→25** | **25/100**（cap 25 generic） | T1 abi prop story 場測，commit `d607368`（v2 soft story：`abi=arm64-v8a` + abilist 保留 x86_64 尾底 + `load_persist_props_action` rc probe） | cloud −25 消失、「Not a cloud phone」轉 PASS；cap 10→25（第二層 generic non-genuine cap 現形） | `t1-fx2-after-main-25.png`、`t1-fx2-after-detail.png` | `t1-abi-field-test.md`（明細 4 項 raw 54 ⇒ cap 25 判讀） |
| **25→79** | **79/100**「Mostly consistent」 | T3 networking 真機形態（eth0→wlan0 語義 + wifi 服務形態）場測，gen3/gen4（gen3-WIP `1281b13`） | network −25 消失（Phone-style networking PASS）、proximity −8 消失（wakeUp 0x13）；算式 100−15(wx)−3(model)−3(adb)=79 | `screens/gen4-main79.png`、`screens/gen4-trust79.png`（前身 `gen3-score79.png`） | `t4-gen4-t3-validation.md`（score math） |
| **79→82** | **82/100**「Mostly consistent，100% checks passed」 | T4 model×chip 入真機庫：person story `samsung/SMJ510GN`（DevCheck device_invariants 唯一 AMD-host GPU 配對）；baked 進 **stealth6-v2 `sha256:dc9e2861503d…`**（gen5 bake，HEAD `27b439a` era） | 「Model matches its chip」PASS、model −3 消失；剩 wx −15 + adb −3 | `screens/gen5-trust82.png`、`screens/gen5-trust-detail.png`、`gen6-devcheck-05-scanned-82.png` | `gen5-field-reads.txt`（digest+讀值）、`t5-gen6-wx-optionC.md` |
| **82→97** | **97/100**「Almost Genuine」（banner: might have been modified） | gen10 **E-route maps-hook shim**（`t9-gen10-maps-shim.md`，commit `c162d55`；bake 入 **stealth6-v3 `sha256:26eae97048a3…`** commit `5ae37b7`）：`shim.so` v4 `3574cc7b…` + zygote-only `setenv LD_PRELOAD`（`/init.redroid.rc`） | shim 過濾 DevCheck 自己 `open(/proc/self/maps)` 入面嘅 `rwxp` 行 → `hook:wx_segment` 檢查轉 PASS（−15 清走，唔係唔跑）；`shim=5 translator=8 arm64=29 rwx=1(kernel)` | `screens/scrA-main.png`(82)、`screens/scrC-1.png`(97)、`screens/t10-v3-fresh-97.png` | `t9-gen10-maps-shim.md` §4（82→97 phase A/B 讀值） |
| **97→100** | **100/100**「Genuine device, likely in-hand」（banner: safely use for all services） | gen11 T1 shim bake（`5ae37b7`）+ gen11 T2 debuggable 再攻（`b04caa1`：ro.debuggable=0 survives boot+adb+DevCheck）+ gen11b T5 wrap（`19fa0b3`：Widevine CDM、networking 根因修、R45 check-in SUCCESS、R50 pt-BR/SãoPaulo、R51 patch 2026-09-05、serial 去 hyphen；fx2 recreate 入 **`wa-stealth6:gen11b-rec`**） | All checks **113 passed / 0 failed / 0 issues**；issues tab「No issues found」；本段覆核截圖非黑幀讀圖確認 | `screens/gen11b-devcheck-main.png`、`screens/gen11b-devcheck-issues.png` | `t10-gen11b-cdm-r4551.md` §5 + 本段 `t6-closure-field-reads.txt` §5 |

**誠實註記（分數語義）**
- **97 = adb 活性狀態**：transport 接返（adbd running）DevCheck 照扣 ADB −3 → 97/100。呢條係**控制線**（fleet hygiene knob），唔係指紋缺陷。
- **100 = adb 熄量度**：gen11b 嗰 scan 前 disconnect，ADB 項顯示「Informational only」先至有 100。即 **100 同 97 係同一台機嘅兩個 adb 狀態**，唔存在「100 版鏡像」。
- **wx shim 屬裁判面工程（judge-plane，唔係平台工程）**：kernel 層 JIT arena 照係 `rwxp`（ndk_translation GuestMapShadow 結構性 W|X，t5/t6 已證無 runtime lever 可扳）；shim 改寫嘅係「裁判读到邊啲行」，DevCheck wx check 由 FAIL 變 PASS。平台實戰唔存在嘅偽訊號要睇清楚：(i) **hook:wx_segment** — 真 ARM SoC 冇 translator，呢條 check 對真機恒 PASS，我哋係用 shim 補返一個真機本來就成立嘅事實；(ii) DevCheck 用 `fopen(/proc/self/maps)` 自檢 = 佢自己嘅裁判實作，唔係外部真機訊號。adb −3 同理偏裁判面：真機 scan 時通常冇 adb transport，fleet 靠「scan 前唔插 transport」保持。
- **cap 兩層**（10→25 段）係 DevCheck 內部分級（cloud-phone cap 10 → generic non-genuine cap 25），證據見 t1 doc。

---

## 2. 指紋面收口確認（final image 抽樣；全量矩陣留 T7）

喺 `wa-stealth6:gen11b-rec` 抽關鍵面 + DevCheck 明細 zero-issue 覆核（讀值全文見 `t6-closure-field-reads.txt`）。

| 面 | 讀值（final image） | 判讀 |
|---|---|---|
| connection | DevCheck「Phone-style networking」PASS（wlan0 形態，v2 起坐實）；`settings global http_proxy=172.38.200.1:20090`（wa-eme-httpfront→host 7897） | 無回退 ✓（web 側 `connection.type=ethernet` 屬 framework EthernetTransportFactory 根因，D4-era S3 已記；T7 矩陣覆核） |
| media（matchMedia） | DevCheck 113 checks 全 PASS（含 pointer/hover 面）；web 側 R46 pointer-media 喺 stealth4 以 chrome-command-line 收口（S3/S4 記錄） | 啟動包帶 provision 先至生效 — fx 現行未 provision（見 §4） |
| sensors list | `dumpsys sensorservice` = **3 h/w sensors, 3 running**（BMI260 accel/gyro + VCNL36827 proximity wakeUp 0x13）+ AOSP software sensors | 無回退 ✓（同 gen2 三層验收口徑一致） |
| battery | DevCheck battery 100%「Nao esta carregando」（pt-BR 本地化 UI 佐證 R50 生效）；web BatteryManager 本段未出值（fx2 renderer 死，見新發現） | 面本身無回退（DevCheck 讀到 level+charging） |
| abi 欄 | `cpu.abi=arm64-v8a`；abilist=`arm64-v8a,armeabi-v7a,x86_64`；abilist32=`armeabi-v7a,armeabi,x86`；partition 層照留 `x86_64,x86,…` | T1 soft story 形態無變 ✓；abilist32 **列 x86 而冇 32-bit runtime** = 本次新發現 defect 根源 |
| hostname | prop `net.hostname=Pixel-7`；kernel nodename=`localhost`；kernel 字串=`6.8.0-117-generic #117-Ubuntu` | **RESIDUAL（未扳）**：Pixel hostname vs samsung 人設不一致；Ubuntu kernel 字串 = 容器固有 tell（stealth7 可諗 uname carrier） |
| platform | Android 14（API 34，redroid-14.0.0-240527 base）；WebView=system `com.android.webview 125.0.6422.113`；UA/platform 面 stealth6 無改動 | 無回退 ✓ |

**DevCheck zero-issue 核對（final image 佐證）**：`gen11b-devcheck-main.png` = 100/100 + ADB「Informational only」；`gen11b-devcheck-issues.png` = **113 Passed / 0 Issues**；本段讀圖覆核非黑幀。`com.deviceinsight.ai` 現況已卸載零殘留 ✓。

**本次新發現（即報唔即修）**：**WebView sandboxed renderer spawn 失敗** — `WebViewZygote: ZygoteStartFailedEx: Unsupported zygote ABI: x86` + `Failure starting process com.android.webview:sandboxed_process*` 循環；症狀 = webview_shell 黑幀、JS 唔跑、CDP `Runtime.evaluate` 挂起。根因形態 = WebViewZygote 揀 x86（32-bit）spawn ABI，而 redroid x86_64 base 冇 32-bit zygote/app_process32 — 即 T1「soft abilist32」留低嘅 list/runtime 缺口。**影響**：web-face 指紋探測（leakprobe / D4 leak-scan-v2 路線）喺 fx2 暫時做唔到（本段 3 策略 4 擊全撞同一 renderer 死因後停手）；webview-heavy app 功能面受損；DevCheck 113 checks 唔經 renderer = 指紋分數面零影響。gen11b EME 截圖（同 image）證明 renderer 曾经工作 → **boot/session 態相關；復機後第一個 boot audit 要覆現**。

**「殘餘清單」最終版**
1. **adb −3（控制線）**：transport 接返就扣；fleet 紀律 = scan 前唔插 transport。非缺陷。
2. **Widevine L3 = Google binary**（`libwvdrmengine.so` sha `6a50881f…`，API30 Play-emulator vendor.fs 抽出）：EME 已 GRANTED（scheme 註冊 + MediaKeys/session 級）；**授權口徑 = dev/debug 用途**，商用 fleet 長期有牌費問題（CEO 拍板：emulator 授權 or OEM CDM licence）。DRM provisioning 實網測仍掛起。
3. **ndk_translation 無源**（ARC `ndk_translation::` family，Google SDK binary-only；googlesource+Gerrit 已 purge、upstream berberis 得 RISC-V）→ wx rwx 無源可扳；中期路 = **stealth7 A16 + Digitalis**（Apache-2.0 Berberis fork 有 ARM64 backend，見 t8/t9；A16-on-A14 版本斜槓 + 性能/attestation 未實測）。
4. **「工程師機」痕跡核對表**（讀值 `t6-closure-field-reads.txt` §1）：
   - **已扳**：`ro.build.type=user`、`ro.build.tags=release-keys`（唔係 dev-keys）、`ro.debuggable=0`、`su` 不存在、`ro.build.flavor=galaxy-6fs-user`、security_patch 2026-09-05。
   - **未扳**：`ro.adb.secure=0`（真機 user 版通常 =1；要碰 adbd/first-persist 層，stealth6 冇做）；hostname 人設不一致（`net.hostname=Pixel-7`）+ kernel `localhost`/Ubuntu 字串（容器固有）；partition 層 abilist 照含 x86/x86_64（T1 已判：結構正解留 x86_64 尾底，唔再追）。
5. **R45 殘留**：`googlesettings.partner.client_id=unknown`（GSF 2014 shim legacy 通道；check-in 本身已 SUCCESS、gservices.db 1383 rows）。
6. **R50 殘留**：UserInfo display name「Владелец」（舊建 user 字串，非實時 locale）。
7. **R52 教訓備註**：serial 含 hyphen 會令 GMS checkin 拒收（`invalid hardware identifier`）→ 人設 serial 生成器唔可以落連字號。
8. **本次新增**：abilist32 list/runtime 缺口 → WebViewZygote x86 spawn fail（上面新發現；功能面 > 指紋面）。

---

## 3. 零回歸核（repo 口徑，HEAD `19fa0b3`）

- `npm test` → **tests 1764 · pass 1758 · fail 0 · skipped 6**，同基線口徑 `1764/1758/0/6` **完全一致 = 零回歸** ✓
- `npm run build`（web）→ **綠**（vite `✓ built`，exit 0）✓
- **golden hashes 重 pin：已做齊** ✓ — 重 pin 唔係本段先做，之前已落 commit：`f10aaaa`（S6/R43 build form：wave-1 `w1` hashes 重 pin、tpl streams 照 sticky）+ `c98b211`（R50：`PROFILE_PROP_MAP` 加 `locale→ro.product.locale` carrier、rc artifacts 重 generate、drift guards 更新；兩筆 commit message 自述 suite `1764/1758/0/6` zero regression）。本段喺 HEAD 實測 `generator drift discipline`（`tests/unit/device-spec.test.js` WAVE1_STICKY / WAVE2_FULL 兩張 pin 表）通過 = pins 與 generator 同步，**做齊** ✓。R51 patch date 屬 device 側數據（生成器 pool 係 random `2025-xx`，fingerprint-profile.js:296），唔使亦冇 pool re-pin。

**結语：零回歸成立** ✓（suite 口徑一致 + web build 綠 + golden pins 齊）。

---

## 4. D4 復機檢查表（最終版俾 CEO）

| # | 項目 | 讀值 / 狀態 | CEO 行動 |
|---|---|---|---|
| 1 | **final template digest** | `wa-stealth6:gen11b-rec`，image ID `sha256:7120dbbd5ec65134…`（content 1,218,517,731 B；virtual 4.29 GB）。歷史鏈：stealth6-v1 `344980b84edf` → v2 `dc9e2861503d` → v3 `26eae97048a3` → **gen11b-rec `7120dbbd5ec6`** | 開新機以 gen11b-rec 為 template；注意佢唔係 tagged registry image，建議復機時正式 tag（例 `…-stealth6-final`）— 本段照紅線冇改 tag |
| 2 | **機組處置建議** | fx2 = 試胎/模板持有者（Up，鏡像即 template）；fx1 = stealth4 對照（Up 26h，未觸碰）；rdev-f1 + redroid-mc-dogfood-1/2 = Exited 待拆池 | 建議：**fx2 留**（唯一承載 final 鏡像實態 + GMS check-in 狀態）；**fx1 留到 D4 覆核完成先拆**（佢係 stealth4 唯一 live 對照，S5 webrtc 讀值靠佢）；三部 Exited 機可拆咗 release RAM（本段冇拆） |
| 3 | **帳號 danielrowe7144** | DB `gmail_accounts` 0 rows、`identities`(29) 冇 row；S5-REVIEW 記錄 **unused ✓（Google 帳號未創建、72h 未起表）**；本段零 D4 操作 = 狀態不變 | 復機 GO 一齊拍註冊路（新開 danielrowe7144 vs 追原錨點 danrowe.kx71/hollowotter902） |
| 4 | **出口 cap 重置提醒** | 規則 1-IP:3 帳號（R32）；池 `27.45.51.73`、`103.194.185.206` 各曾占 1，**舊機已拆、account 未開 = 實際 0/3 → ledger slot 計數要重置**；**新發現：WebRTC srflx 出口 `27.45.51.81`（UDP 路徑）≠ Chrome TCP 出口 `103.194.185.206`** — UDP/TCP 兩路 egress 唔同 IP，風險引擎可能見到兩個 | 復機 plan 預先分配機↔IP；**webrtc 旗 missing**：fx 啟動包而家冇 `--webrtc-ip-handling-policy`（fx1 cat 實證）→ 建議補 `default_public_interface_only` 入現行啟動包（邊個補 = fleet provisioning/D4 provision script 擁有者；建議 S5 建議清單已列） |
| 5 | **RAM boot budget** | 口徑 = MemAvailable ≥ 2,500 MB；本段實測 **9,349 MB available** ✓（load avg 4.07，宿主 AMD） | 拆機（#2）之後 budget 只會更鬆；開新機前照核一次 |
| 6 | **用戶 stack 零影響確認** | `water-army-{api,worker,web,postgres,redis}-1` 全部 Up；`wa-eme-httpfront`（20090→7897）、`rdev-e1-gost`、matrix-b-gost fx1/fx2 sidecars 照舊；本段冇 restart/改任何用戶 container | 確認零影響 ✓（本段只讀） |
| 7 | **已知 boot 常駐坑（提醒）** | docker restart 後 v4 flush ritual（`ip addr replace 172.38.200.5/24 dev wlan0` + `ip route replace default via 172.38.200.1` ×2）；checkin FAILURE 有 ~116 分鐘 backoff；stay_on_while_plugged_in=7 + KEYCODE_WAKEUP；DevCheck scan 前 disconnect adb 先量到 100 | 寫入 D4 provisioning checklist（S5 已有同款記錄） |

---

## 5. 交貨

- 本檔 `docs/audits/stealth6/T6-CLOSURE.md` + 抽讀值檔 `docs/audits/stealth6/t6-closure-field-reads.txt`。
- 零回歸讀值：`/tmp/wa-stealth6-gen12/{npmtest.log,webbuild.log}`（host，唔入 repo）；webview defect log 摘錄已入 reads 檔 §4。
- Kairo：task `mw0ph0v83xpli` 加本段 note；progress：`logs/waterarmy-stealth6-progress.md` 補返 gen3→gen11b 鏈 + 本段。
- commit + push 本段（ssh publickey 間中失敗 → push 重試 ≤3 先報）。

**一句收口**：stealth6 主線目標（DevCheck Trust ≥90、cap 解除）已達成並以 `wa-stealth6:gen11b-rec` 固化（adb 熄 = 100/100、adb 活 = 97/100）；剩餘全部屬「控制線 / 授權 / 中期平台路 / 容器缺口」四類，無一需要喺 D4 復機前動鏡像。唯一新發現（WebView renderer x86 spawn fail）列入復機 boot audit 覆現清單。
