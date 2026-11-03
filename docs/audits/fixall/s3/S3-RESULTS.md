# S3 結果 — 產品/載體層洩漏批（WA-FIXALL gen4，2026-11-03）

機：redroid-rdev-fx1（fx-adv-stealth4，adb 15000，Chrome 156.0.8078.47 / WebView 125.0.6422.113）。
方法：開工 liveness ✓ + `KEYCODE_WAKEUP` 解 display sleep（gen3 教訓照辦；**本段實測 display 會再瞓**，開工必查 `mWakefulness`）→ leakprobe-lite 兩段式讀值（前/後）→ chrome-command-line 改 flag → Chrome 重啟復讀。出口復核：**103.194.185.206（AS4553 Netsec, HK）** 照 S2 鏈（host socks5h 172.38.200.1:20080 實測）。
紅線：零 submit（Chrome 重啟後 signup password tab 原樣還原、未 submit）、零新機、DevCheck 零帳號、禁碰名單照守、MemAvailable ~15G。
Evidence：`fx1-before.json`（Chrome 前）／`fx1-webview-before.json`（WebView 載體前）／`fx1-chrome-blinksettings.json`（Chrome 後）／`devcheck-device*.png`＋`devcheck-device*-ui.xml`（老細工具自報）；probe ts 08:01–08:03Z。

## R41 — 兩載體 navigator.platform 分歧：**表決基準 + 層級定位（活機唔改，記 KL 入 stealth4 下一版）**

| 載體 | 前（fx1 實測） | 結構根因（實測） | 後 |
|---|---|---|---|
| Chrome 156 | `Linux armv81` | 進程 `primaryCpuAbi=x86_64`（原生）— platform **唔係純 ABI 鏡像**，引擎內部生成 | `Linux armv81`（唔改） |
| WebView 125（webview_shell 場測） | `Linux i686` | provider `com.android.webview` `primaryCpuAbi=x86`（**32 位 x86**）+ secondary x86_64；UA 照帶 `Galaxy6FS Build/R0ABF9Z`（oemprop model ✓） | `Linux i686`（唔改） |

- **基準裁決：跟 Chrome = `Linux armv81`**。理据（一句）：armv81 同成機隊扮 ARM 消費機嘅故事（sec-ch-ua-model／UA／GMS check-in）同向，i686 先係 web 面 x86 tell，所以 WebView 跟返 Chrome，唔好反轉。
- **載體層做法（邊層改）**：platform 字串由**載體引擎內部**計算（Chrome156：x86_64 進程都報 armv81；WebView125：x86-32 進程報 i686）→ **冇啟動參數扳子**；可行扳子 = **image 層換 WebView APK**（arm64-v8a 變體經 ndk_translation 行 ARM 態 = Chromebook 行 ARM app 嘅形態；順手將 WebView 版本拉到 ≈Chrome 嘅消費機「Play 更新 WebView」故事）。fx1 無現成 arm64 WebView APK（vendor/ 只有 GMS 兩粒）、CDN 403 前科照避 → **唔即試，寫入 stealth4 下一版 image 清單**（屬 image 層改動，照工單唔半途砌 image）。
- 兩載體不一致本身（同機兩答案）= 第二層 tell：換 arm64 WebView 後兩面應同報 armv81。

## R46 — 触控媒體矛盾 + connection.type：**pointer media 扳到（啟動參數層）；ethernet 屬 framework 層（記清俾 S5）**

| 讀值（Chrome） | 前 | 後（加 `--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1`） |
|---|---|---|
| matchMedia `(pointer:fine)` | false | false ✓（真觸控機常態） |
| matchMedia `(pointer:coarse)` | **false ✗** | **true ✓** |
| matchMedia `(hover:hover)` | false | false ✓（觸控機本應 false） |
| matchMedia `(any-hover:any-hover)` | false | false ✓ |
| matchMedia `(any-pointer:coarse)` | **false ✗** | **true ✓** |
| 補充 targeted 讀值（後） | — | `(hover:none)`=true、`(any-hover:none)`=true、`(pointer:none)`=false、`(any-pointer:fine)`=false → 與 `ontouchstart=true`／`maxTouchPoints=1` **矛盾消除**（內部自洽） |
| `navigator.connection` | type=**ethernet**、effectiveType=4g（矛盾）、downlink=1.5、rtt=50 | type=**ethernet**（唔改，見下） |
| WebView 載體（webview_shell 場測） | 同款 media 全 false、type=ethernet | 同款（release WebView 冇 command-line carrier 生效 = s1 已知；in-app 扳子喺 app 嘅 WebSettings 層） |

- **改法**：`--blink-settings` 指針/懸停位（載體啟動層 = chrome-command-line 檔案，**root-owned 先有效** = S2 教訓照守）→ **已生效並寫入標準啟動包（見下表）**。
- **connection.type 層級（俾 S5）**：根喺 Android 14 framework — `dumpsys connectivity` 實測 `ni{Ethernet … Specifier: EthernetNetworkSpecifier (eth0)} Transports: ETHERNET` = EthernetTransportFactory claim 咗 eth0 → Chrome／WebView／DevCheck 三邊都見到 Ethernet。**唔係啟動參數可改**；產品層做法 = ①RRO overlay 清 `config_ethernet_interfaces`（eth0 唔再被 ETHERNET claim，代價 = fallback transport 要實測）②改網絡拓撲（tun/wlan 形態）③接受「雲機插網線」KL。**建議 S5 拍板：出口 story 若要 4G/wifi 味 → ①／②；否則 ③。**
- 殘餘（照記，唔屬今段扳子）：`maxTouchPoints=1`（真電容屏多為 5；= 觸控 capability／輸入設備配置層，leakscan B11 已入賬）；`effectiveType=4g × type=ethernet` 半矛盾（effectiveType 側正常）。

## R50 — profile TZ ↔ 出口屬地：**TZ 三連一致 ✓；profile↔device↔egress 三方脫節 = 數據級欄位清單（無改代碼）**

| 軸 | 實值 | 判語 |
|---|---|---|
| TZ 鏈 | `persist.sys.timezone=America/Sao_Paulo` = framework = web `Intl`（Chrome **同** WebView 兩載體同值） | **三連一致 ✓**（ADR-031 persist 載體機制成立） |
| profile（DB，fx1 綁咗嘅 identity `redroid-rdev-fx-2`） | `identity_fingerprints.timezone=America/Sao_Paulo`、**locale=ru-RU**、`identity_egress_bindings.expected_egress_ip=27.45.51.73`、**region=NULL** | 內部矛盾：BR 時區 × RU locale（pool tz/locale 各自 random = 設計根因）；region=NULL → **三連 gate 跳過（fail-open）** |
| device locale | `ro.product.locale=en-US` = web `navigator.language=en-US` | **profile locale 落唔到機**：`PROFILE_PROP_MAP` 有 timezone 無 locale 載體 → 機上 locale 永遠 = image 默認 en-US；DB 嘅 ru-RU 只存喺 DB |
| egress | 103.194.185.206（HK）；identity 預期 27.45.51.73 | **綁定過期**：實際出口 ≠ expected_egress_ip（W3 verify 必然 FAIL） |

- **gate 喺邊度**：`apps/api/src/services/identity-egress-service.js:190` → `checkRegionConsistency({egressRegion, timezone, locale})`（packages/shared/src/region.js）— tz／locale 兩軸獨立對出口屬地，**唔啱即 ADMIT 409**。fx1 而家「過」只因為 `region=NULL` 跳過；若宣稱 region=HK：tz 軸（BR≠HK）+ locale 軸（ru-RU→RU≠HK）**兩軸都烂** → 過唔到。
- **要改欄位（數據級，D4 開新號照做）**：
  1. `identity_fingerprints.timezone` → 同出口屬地連動（HK 出口 → `Asia/Hong_Kong` 等池值）；
  2. `identity_fingerprints.locale` → region subtag 同出口（`en-HK`／`zh-Hant-HK`）；
  3. `identity_egress_bindings.region` 填 ISO2（例 `'HK'`）**先至啟動 gate**；`expected_egress_ip` 對返實際釘死出口（fx-2 現 27.45.51.73 ≠ 實測 103.194.185.206）；
  4. pool 生成：tz × locale 獨立 random（POOL_TIMEZONES × POOL_LOCALES）→ 建議 region-aware 配對（`ISO2_TO_LANGUAGE` 已經喺 region.js 等住用）；
  5. locale 無 prop carrier（見上）= plumbing 缺口，**代碼級**、屬 S5/後續批 — 純改數據改唔到 web 面 language。
- fb 數據點補記（fb 機已拆，照 S2 讀值）：d4-fb profile tz=America/Sao_Paulo（pool 抽中）、d4-gm Asia/Singapore — 全部屬 POOL_TIMEZONES 16 池值，即 R50「TZ 屬地未同出口聯動」= 生成策略問題，非單機事故。

## stealth4 標準 Chrome 啟動包（S4 重掃直接用）

載體 = `/data/local/tmp/chrome-command-line`（**root:root 先有效**；首 token=程式名）。**唔屬 image 層** — per-machine provisioning 寫入（/data 層，重啟 Chrome 保留，唔使砌 image）。fx1 現行檔已照此表生效。

| 參數 | 來源/職責 | 邊度 |
|---|---|---|
| `--disable-background-timer-throttling` `--disable-renderer-backgrounding` `--disable-backgrounding-occluded-windows` | gen1 反節流規避包（BeginFrame / S1 chunk 牆規避；S2 靶D 實證有效） | **靜態默認**（provisioning 預設） |
| `--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1` | **S3 新增**（R46 pointer media 扳子，本檔前後對帳實證） | **靜態默認** |
| `--webrtc-ip-handling-policy=default_public_interface_only` | WA-RESCAN ICE 洩漏扳子（packages/shared/src/stealth-browser.js 默認政策；run-ice.sh 同源） | **靜態默認**（operator 可調政策值） |
| `--remote-debugging-port=9222` | 自動化会话控制 | **靜態默認** |
| `--proxy-server=socks5://<gostBind>:<gostPort>` | 釘死出口（gost sidecar） | **每機變**（例 `socks5://172.38.200.1:20080`） |
| `--user-agent=<UA>` | R38 桌面 UA 注入 | **默認唔注入** — leakscan B9：未注入態 UA-CH 全鏈 clean；注入先造成 UA=Windows × sec-ch-ua-platform=Android 三至四層矛盾 |
| `--no-first-run` | Android Chrome 唔跳 FRE（S2 陷阱 3） | 保留（無害）；FRE 靠 native tap 穿 |
| `--touch-emulation` | R46 備選扳子 | **唔疊用**（blink-settings 已精確控位） |
| candA（`debug.sf.auto_latch_unsignaled=1`、`debug.sf.hwc.min_duration=0`） | S2 靶D BeginFrame 根治 | **唔係 Chrome 參數** — image rc `stealth4-extras.rc` 行 androidboot 載體（`ro.boot.oem_ro_stealth4_sf_*`） |
| display wake（`KEYCODE_WAKEUP` + `stay_on_while_plugged_in=7`） | headless redroid 隐形閘（S2 陷阱 1；本段實測仍會瞓） | **provisioning checklist**，非 Chrome 參數 |
| WebView 側 carriers（`webviewcommandline` prop／`/data/local/tmp/webview-command-line`／`settings global webrtc_ip_handling_policy`） | stealth-browser.js 三載體 provision | fx1 實態：**全部未 provision**（null／冇檔）→ D4 provisioning 要照 `buildBrowserArgsProvisionScript` 執行；release WebView 食唔食檔案 = s1 已知存疑，真正 in-app 扳子喺 WebSettings |

## 加分項 — DevCheck AI（老細工具，/tmp/devcheckai.apk 7.06MB）

`adb install` ✓（10 秒裝得入）→ 跑一次 → **Trust Score 10/100 =「Not a genuine device (Cloud phone)」** → 卸載 ✓（`pm list packages -3` 淨返 Chrome；sdcard 截圖清乾淨）。**無 arm64 native crash**（一振即中，唔使 KL）。

自報身份讀值（≈30 欄，兩屏截圖＋uiautomator XML 落檔）：Brand=Nothing／Model=Galaxy6FS／Android 14／CHIPSET=galaxy-6fs／16 cores 64-bit／ABIs=x86_64 掛頭（R40 同脈）／**CPU=AMD Ryzen 7 9700X 8-Core Processor（宿主 /proc/cpuinfo 直露）**／GPU=AMD Radeon Graphics（IMG/AMD 故事對返）／**RAM=94179 MB（宿主 MemTotal 直露；真機 8–16G）**／1080×2400@420dpi 60Hz ✓／**Battery：Health=Unknown、Voltage=0mV、current/charge=Long.MIN 哨兵（app 側無電池）**／Network：Connection=**Ethernet**、VPN=Off／「This model isn't in the reference database yet」。

**新數據點（交 S4 重掃要目，leakscan-v2 未覆蓋）**：①宿主 CPU model name（app 側 /proc 面）②宿主 RAM 總量 ③app 側 BatteryManager 哨兵值（同 RESCAN 電池 story 修復面要 re-probe：props 層 vs EXTRA 層可能兩張皮）④DevCheck 呢類「消費機自檢分」直接俾雲機判定 — 建議 S4 用同工具做前後對照裁判。

## S3 要目 — 邊啲扳到／邊啲屬層級限制

| 靶 | 結果 | 層級 |
|---|---|---|
| R46 pointer media 全假 | **扳到**（`--blink-settings` 寫入標準啟動包，前後對帳 ✓） | 載體啟動層（/data provisioning 檔，唔使砌 image） |
| R46 connection.type=ethernet | **扳唔到（今段）** — 根喺 framework EthernetTransportFactory(eth0)，啟動參數冇扳子 | framework/image 層（RRO／拓撲），交 S5 拍板 || R41 platform 分歧 | **基準表決=armv81（Chrome）**；WebView 活機冇扳子（引擎內部生成） | image 層：換 arm64 WebView APK（stealth4 下一版清單）+ 版本拉齊 Chrome |
| R50 TZ↔出口屬地 | **數據級欄位清單交 S5**（TZ 三連鏈本身 ✓ 正常） | DB 欄位（timezone/locale/region/expected_egress_ip）+ pool 生成策略 + locale prop carrier 缺口（代碼級） |
| 啟動參數統一 | **表已定**（本檔 §stealth4 標準 Chrome 啟動包；fx1 現行檔已生效） | /data provisioning 層（唔使砌 image）；WebView 側 carriers 待 provisioning 執行 |
| DevCheck（加分） | **裝得入、跑得到、讀到 30 欄、已卸載零殘留**；Trust 10/100「Cloud phone」 | — （另交 4 個新洩漏數據點俾 S4） |

## 殘餘／KL 交 S4・S5（本段誠實清單）
1. **WebView platform=i686**（未扳）— image 層換 arm64 WebView APK 先解決；換完 S4 重掃必覆讀兩載體 platform。
2. **connection.type=ethernet**（未扳）— framework 層；三選項交 S5 拍板（RRO／拓撲／KL）。
3. **maxTouchPoints=1**（未扳）— 輸入設備能力層；leakscan B11 舊賬照殘。
4. **R50 欄位清單**（見上）— D4 新號建立時照清單改數據；fx-2 呢個測試 identity 照殘（唔改數據，D4 未起表）。
5. **DevCheck 新數據點 ×4**（CPU 宿主名／RAM 94G／app 側電池哨兵／第三方雲機裁判分）— 屬 S4 重掃矩陣新增行。
6. DevCheck 於 fx1 曾短暫存在（裝→跑→卸），**零帳號零 secret 輸入**；onboarding 有「Skip」，無登入牆。
