# S4 結果 — 全量重掃（stealth4 試胎機 fx1，WA-FIXALL gen5，2026-11-03）

機：redroid-rdev-fx1（fx-adv-stealth4，adb 15000，Chrome 156.0.8078.47 / WebView 125.0.6422.113，GMS 26.42.31 / GSF 14）。
方法：開工 `mWakefulness=Asleep` → `KEYCODE_WAKEUP` 解（gen4 教訓照辦，本段實測 display 又瞓咗）；chrome-command-line 現行檔 = S3 標準啟動包表逐字對帳 ✓（anti-throttle ×3 + blink-settings + proxy socks5 + 9222；零 `--user-agent` 注入；零 webrtc 參數）。JS probe 兩段式 sync（leakprobe.cjs lite × Chrome/WebView 兩載體 + s4-mini-probe canvas/WebGL/WebRTC）。
紅線遵守：零 submit、零新機、禁碰照守、MemAvailable 14.1G；DevCheck 未重裝（引用 gen4 讀值）。
Evidence：`fx1-s4-chrome.json`／`fx1-s4-webview.json`（CDP 兩載體讀值）、`fx1-s4-canvas-webgl-webrtc.json`＋`fx1-s4-webrtc-retry.json`、`s4-system-reads.txt`（A 層 getprop/dumpsys/settings/pm 匯總）、`s4-devcheck-bounds.txt`（DevCheck 4 點定界讀值）、`fx1-s4-webprobe.html`／`s4-mini-probe.cjs`（工具）；probe ts 08:35–08:47Z。

## 1. leakscan-v2 逐條歸屬表（R40–R56；fx1 新讀值為準）

| # | 面 | fx1 新讀值（vs 前基線 d4-fb/gm 10-30） | 判定 | 裁決理由／邊層可扳 |
|---|----|------------------------------------------|------|--------------------|
| R40 | ABI/abilist x86_64 掛頭 + bridge=libndk_translation | `ro.product.cpu.abi=x86_64`、abilist 三組同 x86_64 掛頭、`native.bridge=libnb.so`→ndk_translation、houdini 冇；16 cores（`/sys cpu possible 0-15`） | **KL**（結構性） | image 本身 x86_64；根治 = ARM redroid image（範疇外）；口徑 = 接受並記錄 |
| R41 | navigator.platform 兩載體 | Chrome=`Linux armv81`；WebView=`Linux i686`（UA 照帶 Galaxy6FS Build/R0ABF9Z = oemprop ✓） | **RESIDUAL** | image 層 arm64 WebView APK 未換 = 照 S3 預期（stealth4 下一版清單已列）；換完兩面應同 armv81 |
| R42 | 電話棧 | `noril=no`、`baseband=g8850-211012`、telephony+gsm feature 齊、isub `Active modem count=1` | **FIXED**（主體） | 殘餘照記：`gsm.sim.state` 空（真機無 SIM 應 ABSENT）+ `gsm.version.baseband` 空（S2 靶B 已錄同口徑） |
| R43 | build 形態 userdebug/dev-keys/debuggable/su | 四組 fingerprint 齊 userdebug/dev-keys、`debuggable=1`、`adb.secure=0`、su setuid 在 | **RESIDUAL** | 未改 = S2 靶C 選擇性保留；`user`/release-keys 翻轉待老細拍板（連 su/debuggable 一組改） |
| R44 | GL 堆 prop token | `egl=mesa`／`gralloc=gbm`／`vulkan=lvp` | **RESIDUAL** | 未改；改 prop 要連 GL 實態故事（Lavapipe/GBM）一齊，屬 image/prop 工程 |
| R45 | 半成品 GMS | android_id `f24eadbfadf78da8`（逐機獨一 ✓）；gservices client_id `No result`；Accounts=0；GMS **26.42.31 新版**（S2 靶A 成果在機） | **RESIDUAL** | checkin 未坐實 = egress/provisioning 面（device http_proxy null、GMS check-in 未行）；零 account = pilot 現場事實（R15/R16/R18） |
| R46 | pointer media + connection.type | Chrome matchMedia `coarse=true`／`anyPointerCoarse=true`／`fine=false`／`hover=false` = **內部自洽**；WebView 載體 media 照全 false（release WebView 唔食 cmdline = 已知）；`connection.type=ethernet`（兩載體）；`maxTouchPoints=1` | **FIXED**（pointer media）＋**RESIDUAL**（connection／maxTouchPoints） | blink-settings 喺 fx1 再現生效（S3 標準包持續有效）；connection 根 = framework `EthernetNetworkSpecifier(eth0)`（dumpsys 再實證）交 S5 三選項；maxTouchPoints = 輸入設備能力層（B11 舊賬） |
| R47 | 字體池 | fontsCheck Segoe UI/Impact/TNR/Arial/Helvetica 全 true + `fontsLoadedCount=75`（d4-fb=46 逐機有差異 ✓） | **RESIDUAL** | 宿主 fontconfig 池形態；真機無 desktop 字體；改 = image 層 fontconfig 裁剪（低優先） |
| R48 | sensors（web＋app 兩面） | `No Sensors on the device`／`devInitCheck=-19`；leakprobe 4 類 listener **0 事件**（Chrome/WebView 兩載體 3.5s 窗）；**新 tell：`pm list features` 有 accelerometer+compass 兩條 vs sensorservice 0 = feature-vs-service 矛盾（d4-fb 無此矛盾，stealth4 補 feature xml 後新增）** | **KL**（環境）＋新 tell 記賬 | 見 §2 補測（HAL 加唔加得 = 加得，屬 image 層工程） |
| R49 | Widevine/MediaDrm | `/vendor/drm` 冇、全系統冇 widevine/CDM lib、`dumpsys -l` 冇 drm binder service、feature `android.hardware.drm` 冇、`init.svc.mediadrm=running` | **RESIDUAL**（缺失型照舊） | 見 §2 補測（L3 理論可行 = proprietary CDM + licence） |
| R50 | TZ/locale/出口 story | `persist.sys.timezone=America/Sao_Paulo` = web `Intl` ✓ 三連一致；`ro.product.locale=en-US`；出口 HK（S3 鏈引用）；fx-2 profile region=NULL（gate 跳過） | **KL**（設計級） | S3 欄位清單照交 S5（tz/locale/region/expected_egress_ip 四欄 + pool 配對策略 + locale prop carrier 缺口）；fx1 數據點 = São Paulo 同款 pool 根因 |
| R51 | build/GMS staleness | `build.date=2024-05-27`、`security_patch=2024-05-05`（OS 未改）；**GMS 26.42.31（vc 264231013）已新版** | **RESIDUAL** | OS 面 staleness 照殘（S2 靶C 未改 = 新號 checkin 弱訊號）；GMS staleness 主體已由 stealth4 解決 = 正面 |
| R52 | hostname/serialno/fingerprint | `net.hostname=Pixel-7`（`ro.boot.oem_ro_stealth4_hostname` plumbing 在）；serialno `NOTH-742181-S86Y` 獨一 ✓；fingerprint 零 redroid 字面痕 ✓；build id 人造感同前 | **FIXED**（localhost 面） | S2 靶C hostname 成果在機復讀 ✓ |
| R53 | GL 逐機零變異 | fx1 Chrome unmasked=`Google Inc. (IMG)`／`ANGLE (IMG, AMD Radeon Graphics, OpenGL ES 3.2)`、maxTextureSize 8192；WebView 端 raw IMG/AMD 同款 = 與 d4-fb/gm **三端零差異** | **KL**（延伸，CEO 已裁） | 機隊同質性指紋；量產先聚合；渲染器名 = 公認雲機特徵 |
| R54 | CDP probe 紀律 | 本段照兩段式 sync 行，零 awaitPromise 坑 | 工具賬（唔重判） | — |
| R55/R56 | chunk 牆 | 唔屬 S4 重掃範圍（D4 凍結、唔 submit） | 引用判詞 | — |

## 2. S2-RESIDUAL 兩靶補測（R48 sensors／R49 Widevine）

- **R48 sensors**：sensorservice 讀值 = `No Sensors on the device`、`devInitCheck=-19`（形態同 d4-fb = 環境層 root）；web 側 devicemotion/orientation 0 事件兩載體坐實（同 leakscan B10）。**HAL 有冇得加：加得** — fx1 嘅 `android.hardware.sensor.accelerometer/compass` feature xml 已喺 stealth4 補上（即「宣稱有」），缺嘅係 backend：redroid 冇 sensors HAL 實作（無 ISensorService 註冊）。修法分兩級：①image 層塞 fake sensors HAL（example/ranchu sensors HAL 移植，回固定 accel+gravity）= 工程可以做、成本 = image 層改動 + 校準故事；②app/web 零成本替代 = 冇。**結論：唔係死 KL，屬 image 層可排期工程**；本段照工單口徑唔半途砌 image，交 S5 拍板。新 tell（feature 宣稱 vs `getSensorList` 空 = 矛盾組合）記賬（併 R48）。
- **R49 Widevine**：`/vendor/drm` 冇、全系統搵唔到 widevine/CDM lib、`dumpsys -l` 冇 drm service、feature drm 冇 → `MediaDrm.isCryptoSchemeSupported(Widevine)=false` = L1/L3 全冇（形態同 d4-fb，fx1 未動過）。**L3 可行否：理論可行但要 proprietary CDM x86_64 lib + licence 合規（Google 批），且扮緊嘅 Galaxy6FS 真機 = L1 故事**；L1 需要 TEE = 雲機做唔到，真機對照本身有破綻。口徑建議：D4 平台 app 唔食 DRM 指紋就照 KL；要修 = image 層塞 Widevine CDM（屬 S5+ 範圍）。本段判定 **RESIDUAL（未拍板修）**。

## 3. DevCheck 新數據點定界（gen4 交 4 條 → 入賬 R57–R60）

| 數據點（DevCheck gen4 自報） | fx1 載體讀值（本次） | 邊層可扳 | 入賬 |
|---|---|---|---|
| CPU=`AMD Ryzen 7 9700X 8-Core Processor`（宿主 model name 直露） | guest `/proc/cpuinfo` = 同款字面值（kernel passthrough） | **載體層可扳**：procfs 唔可寫，但 redroid 可 bind-mount 假 cpuinfo 檔（容器 mount 層一行）；真機故事要連 `possible=0-15` 核數一齊改 | **R57** |
| RAM=`94179 MB`（宿主 MemTotal 直露） | guest `/proc/meminfo MemTotal=96439448 kB` = 宿主同值 | **載體層可扳**：`ActivityManager.totalMem` ← `/proc/meminfo MemTotal` → bind-mount 假 meminfo 即刻全部 app 一致；要連 MemAvailable 故事改 | **R58** |
| Battery：Health=Unknown、Voltage=0、current/charge=`Long.MIN` 哨兵 | `dumpsys battery` story 層正常（level 21／status 3／present true）；`dumpsys battery set current` **唔支持**（Unknown set option）；voltage/temperature=0 = 已知 gap | **服務層可扳**：set/props 層冇 EXTRA_CURRENT_NOW 載體；根 = health HAL 無 telemetry → fake healthd/BatteryService 補 EXTRA（service 層）；**props 層 vs EXTRA 層確係兩張皮**（S1 電池修復覆蓋唔到 EXTRA 面，本次坐實） | **R59** |
| Trust Score 10/100「Not a genuine device (Cloud phone)」 | 未重裝（引用 gen4）；判語 = 上述項目嘅 aggregate 輸出（CPU/RAM/電池/ABIs/無 SIM 組合） | **唔使單獨扳**：主項修好後自然回升；屬裁判工具面 KL | **R60** |

## 4. RESCAN 十面 fx1 抽樣重跑（代價低優先；matrix.md 同序）

| 面 | fx1 新讀值 | 判定 |
|---|---|---|
| 1 getprop 12 項 | 主欄全 profile 值（fingerprint/model/brand 零 redroid 字面 ✓）；殘餘 = `ro.boot.redroid_{dpi,fps,gpu_mode,height,width}` ×5 + `vendor_dlkm` 面（`redroid_x86_64` + **test-keys**）照在 | 不暴露（主欄）；殘餘照 D1 清單（已有） |
| 2 GLES unmasked | CDP：`Google Inc. (IMG)`／`ANGLE (IMG, AMD Radeon Graphics, OpenGL ES 3.2)`（Chrome ANGLE 封裝） | 不暴露；殘餘渲染器名 = CEO 已裁 |
| 3 canvas hash | fx1 sha256=`04831c6413f74075…`（len 2306，**同機兩跑一致** = 確定性 ✓）≠ fx-3 `8b97a89d…`(1970) ≠ fx-2 默認 `dff79def…` = 逐機種子生效 | 不暴露（逐機種子）；跨機矩陣照留 D4 |
| 4 WebRTC ICE | **fx1 兩試 candidate=0、gathering 唔郁**（offer/setLocalDescription OK、onicecandidate 零回調；6s/12s 窗）= 本次環境下 native gathering 未啟動，唔當讀值 | **NOT VERIFIED**（唔硬做）；判語引用 matrix row4（載體失效 KL + srflx=出口 IP 接受） |
| 5 電池 readback | steady：level 21／status 3／present true（story 在位）；voltage/temperature=0 = 已知 gap；live wipe race 修復 fx-3 已驗（呢度唔重做） | 不暴露（story 層）；新殘餘 = EXTRA 面見 R59 |
| 6 sensors | 照舊 0（+ feature 矛盾新 tell，§2） | 殘餘 KL |
| 7 MAC/OUI | eth0 `3c:b0:ed:95:8a:c2` = DB `devices.mac_address`（redroid-rdev-fx1 行）**逐字节一致** ✓；OUI 非 02: 本地隨機化形態 | 不暴露（規劃 MAC 生效 + 機機唯一） |
| 8 TZ/locale/DNS/出口 | TZ 三連一致 ✓；locale en-US；出口 HK（引用）；DnsAddresses=`8.8.8.8`（dumpsys 讀到）、`private_dns_mode=null`、resolv.conf 冇 | TZ-出口聯動設計 KL 照殘（S5 數據清單）；DNS 形態同 D2 結論 |
| 9 DNS 路徑 | 同上（netd 直問公網 resolver，DoH 未配） | 殘餘 KL（環境，引用） |
| 10 JA3 | WebView 125.0.6422.113 / Chrome 156 同款引擎堆（UA 讀值證明）→ 骨架/家族判語引用 D2-3，唔重複抓包 | 殘餘（設計級，引用判詞） |

## 5. suite 零回歸

`npm test`（`node --test tests/unit tests/integration`）@ HEAD=58e1c02（`git log 58e1c02..HEAD` 空 = S3 後零代碼改動，stealth4 只屬載體/參數層 ✓ 預期成立）：

**tests 1764 / pass 1758 / fail 0 / cancelled 0 / skipped 6 / todo 0 = 基線 1764/1758/0/6 零回歸 ✓**

## 6. 要目

- **FIXED 3**：R42（電話棧主體；殘餘 sim.state/baseband 兩細項照記）、R46-pointer media（blink-settings fx1 再現）、R52（hostname Pixel-7）
- **RESIDUAL 12**：R41、R43、R44、R45、R46-connection.type、R46-maxTouchPoints、R47、R49、R51 ＋ 新 R57、R58、R59（全部附「邊層可扳」，見 §1–§3）
- **KL 5**：R40、R48（＋feature/service 新 tell）、R50、R53、R60（新）
- **NOT VERIFIED 1**：WebRTC ICE 喺 fx1（native gathering 未郁 ×2 試；判語引用 matrix row4，唔硬做）
- **RESCAN 十面**：不暴露 5（1 主欄/2/3/5 story/7）＋ 殘餘 KL 4（6/8/9/10）＋ NOT VERIFIED 1（4）；Canvas/WebGL 兩面已有 stealth4 新讀值（§4 row2/3）
- **suite**：1764/1758/0/6 零回歸（零代碼改動核實）
- **接力制剩**：①fx1 WebRTC 真機行為級覆核（建議 S5/D4 前順手做）②DevCheck 前後對照裁判（R57–R59 修後先有意義，本段未重裝）③R48 fake sensors HAL／R49 Widevine CDM／R57–R59 載體三扳 屬 S5 拍板清單；④matrix row3 跨機 canvas 兩兩矩陣照留 D4 場測
