# T7 全表面曝露審計 — 五層洩漏地圖（2026-10-27）

> **定位**：老細 14:36 指令「全方位去考慮，有沒有其他位置會曝露」— 以 Google / Meta 兩個對手視角，
> 逐層盤點「呢部機開機接佢哋服務，佢哋見到乜」。呢份係**研究/立項輸入**，唔係產品規格。
> L2/L3 立項輸入包：`docs/l2-l3-proposal.md`；採集工具：`tools/exposure-probe/`。
>
> **證據等級紀律**（全文標注，唔准將推論裝成實測）：
> - **[實測]** = 我哋 repo/docs 有真機或代碼段證據（引用路徑）
> - **[文檔]** = 官方/公開來源（列明出處）
> - **[推論]** = 本審計嘅分析判斷，未經我哋實證
>
> **可見度評級**：`易` = 普通 SDK/頁面一次讀到；`中` = 需要專門採集或交叉比對；`難` = 需要 root 級觀察或大規模統計。
> **修復成本**：`低`（image/配置級）/ `中`（需要偽裝層或跨層同步）/ `高`（架構級/持續維護稅）。

## 0. 前提與視角

- **「已管」** = 本 repo 已有機制 + 實證；**「未管」** = 無機制；**「已知洩漏」** = 實測證實而家就爆。
- **大廠視角差異 [推論]**（除特別標注）：
  - **Google**：Play Store（安裝期睇 ABI/設備認證）、GMS/Gsf（app 內讀 `/proc`、property、sensors）、Play Integrity（attestation）、登入 IP 歷史、GSF/AAID。
  - **Meta**（fb/ig/threads）：主要經 **web Chrome + FB SDK app** 採集 — 瀏覽器指紋（canvas/WebGL/navigator）、IP、行為。無 Play Store 視角。
  - 我哋路線 = **browser-first（Chrome 已拍板）**，故 §4 瀏覽器層 + 跨層一致性係主戰場。
- **容器本質 [文檔: redroid 官方設計 + 我哋實測佐證]**：redroid = Docker 內 Android，共享 host **kernel、`/proc`、CPU/RAM 視野、GPU（GL 直通實證見 D4）**。「內核級穿透」係本審計最大一類洩漏。

---

## §1 設備層（硬件 / build 身份）

| # | 表面 | 現狀 | Google | Meta | 成本 | 建議 |
|---|------|------|--------|------|------|------|
| D1 | `ro.product.*` 等 9 項 build 身份 | stock 值爆 `redroid/redroid_x86_64/…:userdebug/test-keys` [實測: logs/realdevice-master/w1/v1v4-a1.json L122-168]；**W1b 真 build template 已實裝**（代碼段全綠）、真機 NOT VERIFIED（ADR-028） | 易（GMS/app 讀 prop） | 中（web 讀唔到；app SDK 讀到） | 中（已做，待真機收口） | **修**（= W1b 真機段 NV-W1b，進行中） |
| D2 | `ro.hardware` / `ro.boot.hardware` = `redroid` | **未管** — W1b 映射表只有 9 項身份 prop，呢兩項**唔在**名單 → W1b 收口後照爆 [實測: packages/shared/src/w1b-image-mapping.js 映射清單 + probe-app CONTEXT_PROPS 已列為 tell] | 易 | 易（app SDK） | 低（build.prop 改值，w1b-l2-l3 §L2-2 已列低價項） | **修**（入 L2） |
| D3 | `ro.kernel.qemu`、prop 總數異常少、`/vendor` 自製檔名（oem-ro-map.rc / oem-propctl） | **未管**（ADR-028 §L2 情報已定案；propCount 已入 probe 採集）[實測: ADR-028；probe-app allPropCount()] | 中 | 中 | 低-中（qemu 刪除=低；propCount 補洞=逐項中；/vendor 檔名 = root 級先見到） | **修 qemu/propCount**（入 L2）；/vendor 檔名 **接受** |
| D4 | **GL_RENDERER 爆 host GPU「RTX 3090」** | **已知洩漏 [實測]**（ADR-028 §L2 真機實測情報；docs/w1b-l2-l3-proposals.md 照錄）— 機內 GL 直接見 host 顯卡 | 易（任何 GL app） | 易（Chrome WebGL 一站直達） | 高（三路線：swiftshader 改名 / 直通改名 / 真機 GPU 池 — w1b-l2-l3 §L2-4） | **修**（L2 貴價項；建議 (a) 起步 + (c) 長期） |
| D5 | 內核串碼/版本：`uname -r` = host Ubuntu 通用內核（非 Pixel GKI 5.10/5.15） | **未管**；容器共享 host kernel = 結構性 [推論]（採集項 → probe 擴充） | 易（app 讀 uname） | 難（web 讀唔到） | 高（改 uname 要 kernel/LXC 級；社区普遍接受露出） | **擱置**（web-first 下 Meta 讀唔到；Google app 端先痛 — 入 L2 情報，唔開工） |
| D6 | **x86_64 ABI + abilist 自相矛盾** | **已知洩漏 [實測]**：abilist = `x86_64,arm64-v8a,x86,armeabi-v7a,armeabi`（v1v4-a1.json:134）但 image 64-bit only、無 ARM 翻譯層（gms-variants §1d [實測]）→ ①真 ARM 手機 abilist 永遠唔含 x86/x86_64 = 結構性 tell；②宣稱 armeabi-v7a 但 load 即 crash = 講假故事 [推論] | 易（Play Store 安裝期即見；GMS 讀 prop） | 中 | 高（真修復 = ARM 版 redroid / houdini — L3 範圍；prop 改名解決唔咗行為矛盾 [推論]） | **接受+記錄**（web 唔暴露 ABI；ARM-only app 先痛 — 餵 L3 決策） |
| D7 | **屏幕幾何固定 720x1280 + 運行時旋轉唔支援** | **已知洩漏 [實測]**：wm size override + keyevent 24 雙 no-op（acceptance-report L7/F15）→ 全艦隊同幾何 + 轉屏行為異常 | 中 | 易（Chrome viewport/orientation 一讀就見；真機用戶轉屏係日常） | 中（virtual display 分辨率可配 [推論]；rotatable 要 display 層改） | **修**（分辨率 per-identity 池化 = 低-中；旋轉 = L2 spike） |
| D8 | **傳感器缺項**（accelerometer/gyro/mag… SensorManager 列表） | **未管、未採集** — probe APK 未讀 SensorManager（擴充項）；redroid 默認傳感器面待實測 [推論；偵測面依據：MDN Sensor API / Android SensorManager，文檔] | 易（app） | 中（web DeviceMotion 需權限，Meta 用得到） | 中（sysfs/HAL 注入 — w1b-l2-l3 §L2-3 中價項） | **採集先行**，再定 L2 注入 |
| D9 | **電池**（/sys/class/power_supply、BatteryManager、JS getBattery） | **未管、未採集**（容器無電池硬件 [推論]；probe 擴充項；JS Battery Status API [文檔: MDN navigator.getBattery]） | 易（app dumpsys battery） | 中（JS getBattery 見 charging/level） | 低-中（dumpsys battery set 類偽裝/sysfs） | **採集先行** + 低價偽裝入 L2 |
| D10 | **RAM/存儲容量指紋**（/proc/meminfo、StatFs、df） | **未管 [推論-強]**：容器未隔离 meminfo → 「Pixel」講緊 host 64GB 級 RAM + host 磁盤（host 規格佐證：acceptance-report §5 RAM 44G 釋放記錄 [實測]）vs 真 Pixel 8/12GB = 量級矛盾 | 易（app 讀 meminfo） | 中（web 讀唔到真 meminfo；JS deviceMemory 另計 — B2） | 中（lxcfs/bind-mount /proc/meminfo [推論]） | **修**（入 L2；browser-first 下優先級中） |
| D11 | **CPU 核數/型號**（/proc/cpuinfo、nproc） | **未管 [推論-強]**：容器見 host CPU（核數 + Intel 型號串）；真 Pixel = 8 核 ARM | 易（app） | 中（web 經 hardwareConcurrency 間接見 — B2） | 中（bind-mount cpuinfo — w1b-l2-l3 §L2-3 已列） | **修**（入 L2） |

---

## §2 系統設置層

| # | 表面 | 現狀 | Google | Meta | 成本 | 建議 |
|---|------|------|--------|------|------|------|
| S1 | **settings DB**（時間格式/用戶設置默認值/device_name 等） | 部分採集（probe dump locale/timezone/deviceName）；**全量 Settings.Global/System/Secure dump 未管**（probe 擴充）— farm image 默認值群（time_12_24、adb_enabled=1、無壁紙/無使用歷史…）同真機「用咗三個月」形態唔同 [推論] | 中 | 中（app SDK 讀 Secure/Global） | 低-中（settings put 批量 per-identity 注入） | **採集先行**（真機對照 diff → 注入清單，入 L2 低價項） |
| S2 | **locale/時區** | profile 層**已生成** per-identity locale/timezone（POOL_TIMEZONES 16 區 [實測: packages/shared/src/fingerprint-profile.js:129]）— 但 **guest 側注入未管**：9 項 carrier 映射唔含 persist.sys.timezone/locale → 推斷全部機實際系統時區 = image 默認（推測一致，probe 對數即證）[推論] | 易（GMS 讀系統時區 + 登入 IP 地理交叉） | 中（JS Intl resolvedOptions().timeZone 直達系統時區 [文檔: MDN]） | 低（carrier 映射表加 persist.sys.* = 生成器+rc 各加一欄 [推論-強；W1b 承載機制現成]） | **修**（高性價比：值已喺 DB，就差落機；IP-時區一致性見 N6） |
| S3 | **輸入法（IME）** | **未管**：sparse image 只 AOSP LatinIME、無 Gboard [實測佐證: acceptance F15 sparse image]；真機普遍 Gboard | 中 | 中（app 端讀 enabled IME） | 低（GMS 變體自帶 Gboard [實測: gms-mtg]） | **接受**（GMS 合併後自然緩解；web-first 唔暴露） |
| S4 | **字體列表** | **未管、未採集** — AOSP x86_64 字體集 vs 真 Pixel（GoogleSans…）差異 = canvas 指紋輸入之一 [推論]；probe 採集項 | 中 | 中（字體列舉喂 canvas 指紋） | 低（font 包入 image） | **採集先行**（對照 diff 後定） |
| S5 | **開發者選項/ADB 狀態**（ro.debuggable、ro.adb.secure、adb_enabled、adbd） | 部分採集（probe CONTEXT_PROPS）；**adb_enabled 常開 = 已知洩漏** — 我哋管線靠 adbd 操作，關咗即自殘 [實測語義: 全平台 ADB 控制面；推論: 偵測方可見性] | 中 | 易（app 讀 adb_enabled = farm tell） | 中-高（無 adbd 管控 = 架構改動） | **接受**（操作需求取勝；記錄入紅旗表） |
| S6 | **SIM/電信深層面** | carrier 注入 **已管 [實測: W1 V0 10/10 byte-identical]**；**未管面**：signal strength、cell info、getSimState、數據類型等 Telephony 深欄 [推論]（probe 現只讀 5 項基礎欄） | 中 | 中 | 中（Telephony HAL 逐欄偽裝） | **採集先行**（probe 擴充深欄），L2 再評 |
| S7 | **藍齒 MAC 語義** | **未管、未採集** — 容器 bt0 存在性 / Settings.Secure.bluetooth_address 形態待測 [推論] | 中 | 中（app 端） | 低（本地隨機注入） | **擱置**（web 讀唔到；採集項入 probe 擴充） |

---

## §3 網絡層

| # | 表面 | 現狀 | Google | Meta | 成本 | 建議 |
|---|------|------|--------|------|------|------|
| N1 | **出口 IP**（per-identity 綁定） | **已管 [實測: W3 D1-D10 全綠 — first-match verify / drift escalation / rotation / collision 409，ADR-027]** | 易 | 易 | 已做 | **已管**；残余見 N2/N4/N5 |
| N2 | **datacenter ASN 本身即訊號** | **已知洩漏、故意接受**（NV4 誠實口徑；residential proxy = 成本路線未拍板 [實測: network-policy §11 零 proxy pool 實裝 + repo 口徑]） | 易（ASN 聲譽 = 標准風控輸入） | 易 | 高（residential = 採購決策唔係技術） | **接受**（老細口徑：誠實記錄，唔冒充 residential） |
| N3 | **TLS JA3/JA4 指紋** | **未管、未採集**。分析 [推論]：Chrome 嘅 TLS ClientHello 本身係主流指紋（Chrome on Android 组合常见，JA3 獨特性低）；但「Android UA + x86_64 宿主 + datacenter 出口」成組出現嘅**組合稀有度**先係風險；另外 gost 代理中轉 = destination 見到嘅 TLS 由 Chrome 原生發出（gost 係隧道轉發，唔代做 TLS）— 呢個係好消息 [推論，採集項：真機段對外部 endpoint 抓 ClientHello] | 中 | 中 | 低-中（若需要 = 出口側 TLS mangle；通常唔值） | **採集先行**（真機段 ja3 採集 + 同真機 Chrome 對照）；預期 **接受** |
| N4 | **DNS 路徑**（DoH + 洩漏） | DoH mimic **已管 [實測: W3 D4b DoH mimic PASS]**；**未驗證面 [實測: acceptance §1.2]**：scratch 環境無 SOCKS5 UDP ASSOCIATE + guest 無 DNS client → 純 DNS-over-tunnel NOT VERIFIED → 生產部署時 DNS UDP 有冇漏出 tunnel 屬 **待真機驗證** [推論-強: 若漏 = 解析器 IP ≠ 出口 IP = 強 tell] | 中（LDa 可觀察 DNS 源 IP） | 易（JS 讀唔到 DNS，但服務端見 resolver 地理） | 低-中（生產：guest DNS 強制入 tunnel = 路由配置 [推論]） | **修**（生產部署 checklist 必驗項 — 已有 W3 機制，差驗證收口） |
| N5 | **WebRTC 本地 IP 洩漏** | **未管、未採集** — Chrome WebRTC ICE candidate 可暴露容器內網 IP（172.17/br-xxx 類 Docker 網段）[文檔: WebRTC ICE 語義；推論: 我哋 container 網段命名直接講「呢度係 Docker」]；Chrome 新版本有 default ICE localhost 收緊 [文檔: Chrome mDNS/redaction 行為，版本相關] — 真機段 probe 採集先收口 | 中 | 中（Meta web 端用得到 WebRTC） | 低（chrome policy `WebRtcLocalIpsOnlyUrls`/about:flags 層面可控 [文檔]；或 tunnel 內亦唔洩 = 待測） | **採集先行**（probe 已內置 WebRTC 採集 — tools/exposure-probe）+ 預留 Chrome policy 開關 |
| N6 | **登入 IP = 操作 IP 一致性 + IP-時區一致性** | 綁定語義**已管 [實測: W3 identity verified + 綁定語義]**；**未管面**：profile timezone 池有 16 個時區但出口 IP 池地理未必匹配（例：identity 講 Asia/Seoul、IP 係 HK datacenter）[推論 — 取決於 egressIps 採購地理，老細配置面] | 易 | 易 | 低（配置紀律：egress IP 地理 = identity 時區池對齊） | **修（政策唔係代碼）**：provision 文件加對齊指引；或短期收窄 POOL_TIMEZONES 到 IP 池實際地理 |
| N7 | **MTU/TTL 側信道** | **未管** — destination 見到嘅 TTL = 代理 VM 出口 hop 數、MTU = 代理鏈路；同真機 4G 出口形態（TTL 分布）唔同 [推論] | 中 | 難（Meta 要靠佢自己邊界設備先量到） | 高（要代理基礎設施層改） | **擱置**（偵測方以此定論嘅公開證據弱 [推論]） |

---

## §4 瀏覽器層（Chrome — browser-first 主戰場）

| # | 表面 | 現狀 | Google | Meta | 成本 | 建議 |
|---|------|------|--------|------|------|------|
| B1 | **UA 與設備身份匹配** | **未管、未採集** — 若 ro.* 扮 Pixel 8 Pro 而 Chrome UA 講 Android 14/x86_64 組合 + Chrome 版本同 Play 更新鏈斷（uncertified 無自更新 [實測語義: gms-variants §1c 認證缺口的延伸]）→ UA/版本漂移 [推論]；probe 採集 UA 全文 | 中 | 易（UA 係 Meta web 風控基本輸入） | 低（UA 對齊 = 採集後核對；Chrome 版本保鮮 = 打包紀律 [推論]） | **採集先行** + 一致性斷言（probe 輸出 vs profile 模板） |
| B2 | **navigator.hardwareConcurrency / deviceMemory** | **未管、未採集** — hardwareConcurrency = **host 邏輯核數**（Chrome 直接讀 OS）、deviceMemory = host RAM 量化值 [文檔: MDN navigator 定義讀 platform 值；推論: 我哋未隔离 → 爆 host]；真 Pixel 8 Pro = 8 cores / 8GB → 「Pixel = 24 cores」類矛盾 [推論] | 中 | **易**（JS 一行） | 中（Chrome 層改呢兩欄冇 policy 開關 [文檔: Chrome enterprise policy 無此項]；要 patch 或擴充層 — 中-高） | **採集先行**（probe 採實值）→ 若矛盾 = L2 連動（改 host 視野先治本 — 同 D10/D11 同一根因：**治 /proc 就一齊治**） |
| B3 | **canvas / AudioContext 指紋語義** | **未管** — 無隨機化 = 每機指紋由（GPU+字體+Chrome 版本）決定 → 全艦隊同 host 同 image = **canvas hash 高度同質** [推論；輸入因子 D4/S4 已實測]。語義目標 = **per-identity 穩定隨機**（同一 identity 每次一致、唔同 identity 唔同 — 每次隨機反而係 tell [推論]） | 中 | 易（canvas/Audio 指紋係 web 風控標准件 [文檔: 學術/業界標准實踐]） | 中（Chrome extension/patch 注入穩定噪聲 = 有開源先例 [推論]；或接受同質 + 靠其他面稀釋） | **採集先行**（probe 出 canvas/audio hash）→ 量同質程度再拍板修/接受 |
| B4 | **WebGL renderer（web 側）** | **已知洩漏（繼承 D4）** [實測 GL=RTX 3090] — WebGL `UNMASKED_RENDERER_WEBGL` 經 ANGLE 大概率見 host GPU 或 SwiftShader [推論 — 待 probe 實採確定邊個]；**一致性炸彈**：Canvas 講 NVIDIA、ro.* 講 Pixel = 直接矛盾 | 易 | **易** | 高（= D4 同項） | **修**（= L2 GL 項；修完 web/app 兩側一齊收） |
| B5 | **plugin / language 列表** | **未管、未採集** — Android Chrome plugins=[]（正常形態 [文檔: Android Chrome 無 PDF plugin 係常態]）；`navigator.languages` 跟系統 locale → 同 S2 連動（未落機 = 全部機同一語言列）[推論-強] | 低 | 中 | 低（S2 修咗就順帶） | **修**（隨 S2） |
| B6 | **screen 幾何（web 側）** | 繼承 D7：外屏 720x1280 + dpr 固定 → 真 Pixel 8 Pro = 1344x2992@dpr~3.5 [文檔: Google 官網規格]；「Pixel 8 Pro 但 720p」= 中等 tell [推論] | 中 | 易 | 中（= D7 連動） | **修**（display 分辨率 per-identity 池 = 同 D7 一單） |
| B7 | **⭐ 指紋跨層一致性（最容易死嘅位置）** | **未管** — 綜合：Chrome 見到嘅 GL(RTX 3090)/CPU 核數(24?)/RAM(8?GB)/屏幕(720p)/時區(默認) 要同 ro.*(Pixel 8 Pro template) + API(profile locale/timezone/carrier) 講**同一個故事**。而家每一層各自為政 [推論-強；輸入全部已實測：D4/D7/S2/B2] | 中（交叉比對需要多源數據 — Google 有 app+web 兩源） | **易**（web 一頁 JS 已同時見到 B2/B3/B4/B6 全部 — 一致性 checks 係 meta 風控標準操作 [推論]） | 中-高（唔係單點修复，係**一致性矩陣工程**：每層偽裝值必須由同一 identity profile 派生） | **修 = 紀律**：立「identity = 單一故事源」原則 — 所有層（ro.*/settings/proc/Chrome）嘅值由 profile 派生 + probe 斷言矩陣鎖死（擴 w1b-consistency 姿勢） |

## §5 帳號 / 行為層

| # | 表面 | 現狀 | Google | Meta | 成本 | 建議 |
|---|------|------|--------|------|------|------|
| A1 | **同 IP 帳號密度** | **已管（語義）** — per-identity 唯一 egress IP + collision 409 [實測: W3 D5 雙身份+collision 409]；密度 = 1:1 = 設計目標 | 易 | 易 | 已做 | **已管** |
| A2 | **建號/登入時間聚集** | **已管 [實測: T5 節流紀律（Kairo 任務簡述引用；repo 側 batch 節流 + schedules）]** | 易 | 易 | 已做 | **已管**；保持節流參數-review 紀律 |
| A3 | **輸入節律機械性** | **未管** — 我哋輸入路徑 = adb input / stream console：tap 座標整齊、無滑動曲線、節律等距 [推論；輸入面語義 ADR-026/024]；Meta web 端見得到 mouse/touch 軌跡機械性（web 操作路徑 = 人肉 via console 嘅部分 OK，自動化部分未管）| —（web 輸入） | 易（web event 軌跡）/ 中（app 端 tap 中樞） | 中（humanization 層 = 座標抖動/節律隨機化 — 未立項） | **擱置→立項候選**（自動化規模上去之前唔使做；開動時優先於多數 L2 項 [推論]） |
| A4 | **App（Gmail 錨點）與 web 指紋一致性 / GSF/AAID 語義** | **未管（架構未收口）** — GMS 變體（MTG/microG）與 W1b 指紋層 **零交集**（老細拍板：PoC 通過後先合併 [實測: gms-variants §3]）→ 現階段 Gmail app 讀到嘅 build 同 web Chrome 講嘅故事處於**兩層未合併**狀態；GSF/AAID：stock image 冇 GSF → AAID 讀取失敗 = app 端tell（app 用家側）[推論；MTG 合併後 = Google 原簽 GSF，AAID 有真值] | 易（GMS 直接讀 ro.*+GSF 註冊） | 中 | 中（= GMS×W1b 合併工程，已排決策） | **等 GMS PoC**（合併時必須帶「跨層一致性斷言」驗收 — B7 原則） |
| A5 | **登入 IP = 操作 IP 一致性** | **已管（語義）** [實測: W3 綁定 + verified 狀態機]**；edge case：proxy 中斷 1-tick 恢復期嘅 request 有冇可能行直連洩真 host IP → fail-closed 驗證 [實測: W3 D3 proxy-death 1-tick 恢復 + D9 stale TTL；直連洩漏路徑已由容器網絡隔離 — 推論-強：docker network 無 default route 出 host] | 易 | 易 | 已做 | **已管** |

---

## §6 「今日開機俾大廠見到乜」紅旗總表

> 假設：**今日**起機（stock/matrix image，W1b 未上、GMS 未合併）、開 Chrome 接 Google/Meta。
> 嚴重度 = 對「扮真機手機」呢個目標嘅殺傷力（P0 = 一見即穿 / P1 = 交叉比對即穿 / P2 = 統計訊號 / P3 = 弱訊號）。

| 排序 | 紅旗 | 邊個見到 | 嚴重度 | 一句講乜 |
|---|------|---------|--------|----------|
| 1 | **GL_RENDERER = host RTX 3090**（D4/B4）[實測] | Meta web 一行 JS；Google app+web | **P0** | 「Pixel 用 NVIDIA desktop 顯卡」— 單項即穿 |
| 2 | **ro.* 全套 stock redroid 值**（D1）[實測] | Google 易；Meta app 易 | **P0**（W1b 上機後解除） | 品牌/型號/fingerprint 直接自報 redroid_x86_64 |
| 3 | **abilist 含 x86/x86_64**（D6）[實測] | Google（Play/GMS） | **P0-P1** | ARM 手機無 x86 — 結構性，扮唔到（除非 ARM 翻譯路線） |
| 4 | **屏幕固定 720x1280 + 唔識轉屏**（D7/B6）[實測] | Meta web 易；Google 中 | **P1** | 「Pixel 8 Pro 得 720p 且無 rotation」— 同號型對唔埋 |
| 5 | **navigator.hardwareConcurrency/deviceMemory = host 值**（B2/D10/D11 同根因）[推論-強，待 probe 實採] | Meta web 一行 JS | **P1** | 「手機有 24 核 / 非手機 RAM」— 同 #1 同類「硬件穿透」 |
| 6 | **ro.hardware=redroid + ro.kernel.qemu**（D2/D3）[實測] | Google/Meta app SDK | **P1** | 經典 emulator/container tell，標准偵測清單常客 |
| 7 | **時區/locale 全艦隊同一默認值**（S2/B5）[推論，待 probe 對數] | Meta web 一行 JS；Google 易 | **P1** | 帳號講首爾、機講デフォルト — profile 有值但冇落機 |
| 8 | **canvas/Audio 指紋艦隊同質**（B3）[推論，待採集] | Meta 統計 | **P2** | 100 個帳號同一個 canvas hash = 牧群指紋 |
| 9 | **datacenter ASN 出口**（N2）[實測-接受] | 兩家都易 | **P2** | 已知接受（NV4 口徑）— 風控減分項唔係一見即死 |
| 10 | **DNS/tunnel 洩漏未驗證**（N4）[實測缺口] | Google/Meta 服務端 | **P2**（若洩 = P1） | 解析器 IP ≠ 出口 IP = 新穿點 — 真機段收口 |
| 11 | **WebRTC 本地 IP（Docker 網段）**（N5）[推論，待採集] | Meta web 中 | **P2** | ICE candidate 見 172.x/br-* = 「呢度有 Docker」 |
| 12 | **無電池 / 無傳感器 / 內核串穿底**（D8/D9/D5）[推論，待採集] | Google app 易；Meta web 中 | **P2-P3** | app 端偵測清單標准項；web-first 路線下緩衝 |
| 13 | **adb_enabled 常開 + settings 出廠態**（S5/S1）[實測/推論] | app SDK | **P2** | 「新機第一日就開住 USB 調試」— 細但累積 |
| 14 | **Play Integrity 全 FALSE**（L3 缺口）[實測: ADR-028 口徑] | 僅 Google（要問嘅場景） | **平台相關** | Gmail/社媒登入唔問；銀行/Google 後端依賴先死 — browser-first 下暫緩 |
| 15 | **Gmail app × web 兩層未合併**（A4）[實測: gms-variants §3 拍板] | Google | **P2**（合併後轉 P1 風險管理） | 合併工程必須帶一致性斷言 |

**一句話總結 [推論]**：今日開機，**web 端（Meta）最先死喐 #1/#5/#7**（一行 JS 齊），**app 端（Google）死喐 #2/#3/#6**（prop 即穿，W1b 收口解一半）。**跨層一致性（B7）係所有修復嘅驗收標準** — 單點修復唔會自動產生自洽故事。

— 完（本檔 = 情報快照；每項修復立項時引用返對應 D/S/N/B/A 編號）
