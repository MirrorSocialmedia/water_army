# WA-FIXALL S5 — 要目 + 殘餘風險清單（俾老細複核 → D4 復機拍板）

日期: 2026-11-03 (Asia/Hong_Kong) · gen7 組裝段 · 紅線遵守：零 submit／零開戶／零代碼改動／零砌 image（本段）／禁碰照守（fx1/fx2 未拆）
來源：S1-CHUNKWALL.md + s2/S2-RESULTS.md + s3/S3-RESULTS.md + s4/S4-RESULTS.md + s6/S6-RESULTS.md + docs/audits/d4/risk-ledger.md (R1–R60) + docs/audits/d4/leak-scan-v2.md；加分讀值 = `s5/fx1-s5-webrtc-try3.json`。

---

## 1. 一句總覽

WA-FIXALL 五段（S1 根因 → S2 stealth4 四靶 → S3 產品/載體洩漏批 → S4 全量重掃 R40–R60 → S5 複核）＋ S6 stealth5 bake，把 D4 機隊級缺陷連根挖走兩條（**chunk 牆真兇 = display-zombie → `visibilityState=hidden` → Chrome timer/rAF heavy-throttle 凍死 Bloks 狀態機，唔係網絡**；**fresh-data 首 boot `load_persist_props` 會抹走全部 early-init `ro.*` 故事 = fleet 級，每台新 create 中招，fix=82c0662**）、修好電話棧/GMS 代際/build 形态/CPU-RAM 宿主直露/sim 形態/載體啟動包統一，suite 1764/1758/0/6 零回歸，剩餘全部歸屬到層並列成 §3 拍板清單。

---

## 2. 戰績表

### FIXED（逐條 R 號 + 前後讀值檔）

| R# | 面 | 前 → 後 | 前讀值 | 後讀值 |
|---|---|---|---|---|
| R55/R56 | signup chunk 牆（根因＋根治） | 三振定讞「恆常牆」→ 定性 hidden-throttle；S2 BeginFrame 根治後 name→birthday→username→password 全程過到（未 submit） | `S1-CHUNKWALL.md`（rAF/timer 4s fire 0 次、captureScreenshot timeout）+ `d4fx-s1-birthday.png` | `s2/S2-RESULTS.md` 靶D：captureScreenshot 72–120ms 真幀 + rAF 150–300/2.5s；`s2/d4fx2-{name,birthday,username-filled,password}.png` |
| R42 | 電話棧（noril/emulator 形態） | noril=yes、baseband=unknown、telephony feature 冇、subscription service 死 → noril=no、baseband=g8850-211012、feature 齊、`isub Active modem count=1`；`gsm.sim.state` 前空 → **ABSENT**（gen7 覆讀 stealth4 已中） | `docs/audits/d4/leak-scan-v2.md` A4 | `s2/S2-RESULTS.md` 靶B + `s4/S4-RESULTS.md` §1 R42 ＋本段 fx1 覆讀（sim.state=ABSENT） |
| R43 | build 形态（S6 落地部分） | userdebug/dev-keys/su 在 → **user / release-keys / su 去咗**（stealth5 bake @ 2de5d82a + 身份生成器 f10aaaa）；**deviation：`ro.debuggable=1` 照殘**（見 §3.4） | `leak-scan-v2.md` A7 ＋ `s4/S4-RESULTS.md` R43（fx1=userdebug 對照） | `s6/fx2-props.txt`（user/release-keys、whiteout su）＋ `s6/build-record.md` |
| R46(pointer) | matchMedia pointer 全假 × ontouchstart 矛盾 | pointer:coarse/any-pointer:coarse = false（假）→ true，與 maxTouchPoints=1 矛盾消除（`--blink-settings` 寫入標準啟動包） | `s3/fx1-before.json` | `s3/fx1-chrome-blinksettings.json` ＋ `s4/S4-RESULTS.md` R46 複讀 |
| R50(TZ鏈) | TZ prop↔framework↔web 三連 | 三連一致機制成立（persist 載體 = ADR-031；屬地「邊個值」係數據問題，見 §3.7） | `leak-scan-v2.md` B15 | `s3/S3-RESULTS.md` R50 + `s4/S4-RESULTS.md` R50 |
| R51(GMS半) | GMS staleness | 22.21.16（2022 代）→ **26.42.31**（vc 264231013）＋ GSF A14 配對版；auth.aang DeepLinkActivity 存在（Error type 3 消失） | `leak-scan-v2.md` A10 | `s2/S2-RESULTS.md` 靶A + `s4/S4-RESULTS.md` R51（OS security_patch 殘，見 §3.7） |
| R52 | hostname | localhost（兩台一樣）→ Pixel-7（oem carrier plumbing） | `leakscan-system-reads.txt`（evidence/） | `s4/S4-RESULTS.md` R52 複讀 ✓ |
| R57 | 宿主 CPU model name 直露 | `/proc/cpuinfo`=「AMD Ryzen 7 9700X…」→ 假 ARM cpuinfo（8 核、CPU part 0xd48、零 model name 行） | `s4/s4-devcheck-bounds.txt` | `s6/fx2-props.txt` |
| R58 | 宿主 RAM 直露 | MemTotal=94,179MB（DevCheck RAM 94G、全部 app 見 94G）→ **7,650,410 kB**（載體 `oem_mem_total_kb` create path 自動注入） | `s4/s4-devcheck-bounds.txt` | `s6/fx2-props.txt` ＋ `s6/fx1-control-reads.txt`（無載體=94G 對照） |
| R42(細) | gsm.sim.state | 空（S2 時殘）→ ABSENT（stealth4 機 gen7 實測；stealth5 bake rc boot_completed trigger 亦中） | `s2/S2-RESULTS.md` 靶B 殘餘註 | 本段 fx1 覆讀 + `s6/fx2-props.txt` |

### RESIDUAL（逐條：淨低乜／屬邊層／點解未修／修咗副作用）

| R# | 淨低乜 | 邊層 | 點解未修 | 修咗會有乜副作用／成本 |
|---|---|---|---|---|
| R41 | WebView `navigator.platform=Linux i686` × Chrome `Linux armv81`（同機兩答案） | image 層（換 arm64 WebView APK） | S6 bake v4 實測：呢個 image 家族 native.bridge=libnb.so = null-bridge，arm64-only APK dlopen 死（WebViewFactory「No WebView installed」）→ 已回退；**APK + pin 已備** | 要連 translator 三件套（translator .so + bridge prop + abilist）一齊先食；單換 APK 會砖 |
| R43(殘) | `ro.debuggable=1`（＋adb.secure=0） | image 層（redroid 約束） | debuggable=0 實測 init ~7s exit 129（adbd=init `critical` service + 平台 adb 條手系）= 記錄在案偏離 | 要扳 = adbd 出 critical 列表 = 自動化 CDP/adb 工具鏈受威脅，得不償失（§3.4） |
| R44 | `egl=mesa / gralloc=gbm / vulkan=lvp` prop token | prop 層（連 GL 實態故事） | 改 prop 會同實際 GL stack（Lavapipe/GBM）脫節 | 要改就連 GL 故事一齊；app getprop/Vulkan driver name 面 |
| R45 | gservices `client_id` 未坐實（=unknown）＋ Accounts=0/authenticator 0 | provisioning/egress 層 + 現場事實 | device http_proxy=null → GMS check-in 未行；Accounts=0 = pilot 帳號本身未開（R15/R16/R18） | 屬 D4 復機後真機行為（§2 NOT VERIFIED） |
| R46(conn) | `connection.type=ethernet`（+effectiveType=4g 半矛盾） | framework（EthernetNetworkSpecifier claim eth0） | 啟動參數冇扳子；S3 已定界 | RRO 清 `config_ethernet_interfaces` → fallback transport 要實測（§3.1） |
| R46(touch) | `maxTouchPoints=1`（真電容屏 ≈5） | 輸入設備配置層 | leakscan B11 舊賬；非啟動參數 | 改 touch 設備節點 = 載體層工程；低優先 |
| R47 | 桌面字體全 true（Segoe UI/Impact… = 宿主 fontconfig 池） | image 層 fontconfig | 低–中 severity 未排 | 裁剪字體池 = image 改動；canvas/字體指紋素材 |
| R49 | Widevine L1/L3 全冇（`MediaDrm.isCryptoSchemeSupported=false`、drm feature 冇） | image 層 + licence | proprietary CDM x86_64 + Google licence；扮緊嘅機真機=L1 | L3 後故事仍有破綻（雲機冇 TEE）（§3.3） |
| R51(殘) | OS `security_patch=2024-05-05`、build.date 2024（2.4 年無 OTA） | prop/image 層 | S2 靶C 選擇性保留 | 扳新日期要連 fingerprint/build.id 一齊改先有人造感一致（§3.7） |
| R59 | 電池 EXTRA 哨兵（current/charge=Long.MIN、Voltage=0、Health=Unknown） | image 健康 HAL + 服務層 | S6 判定：產品 script 讀唔到寫唔入 voltage；fake psy bind 語義 runtime 已驗證成功（voltage_now=3895000 讀到）；淨低 init builtin mount 線 + example HAL 開機讀空目錄後唔再 update | 兩件 pending 排下一版（§3 接力）；哨兵 = 消費機 app 必讀面 |
| R48(工程) | sensors：`No Sensors`/`devInitCheck=-19`、web 4 listener 0 事件、**新 tell：feature xml 宣稱有 × sensorservice 0 = 矛盾** | image 層 fake HAL | 冇可信 x86_64 AIDL prebuilt；照工單規則排底 | fake HAL（ accel+gravity 固定回）= 工程可以做；校準故事要一齊（§3.2） |
| R57/R58(殘) | `pm list features` sensor feature 兩條 vs service 0（stealth4 補 feature xml 後新增）；`/sys` cpu possible=0-15 核數 story | 載體/image 層 | 見 R48 | 連核數故事改 = bind-mount 已做 cpuinfo 檔，/sys 面跟 HAL 批 |

### KL（誠實：修唔到／唔值得）

| R# | 判詞 |
|---|---|
| R40 | ABI=x86_64 掛頭 + abilist + ndk_translation bridge × ARM-only 扮機 — **image 本身 x86_64，口徑 = 接受並記錄**；根治 = ARM redroid image（範疇外）。DevCheck −25 嘅一半。 |
| R53 | GL 底层 token 三端零變異（IMG/AMD）= 機隊同質性指紋；量產先聚合；渲染器名 = CEO 已裁殘餘。 |
| R50(設計) | TZ×locale×出口屬地三方聯動 = **數據/生成策略問題**（POOL 16 值 random，非單機事故）；欄位清單已交（§3.7）。 |
| R60 | DevCheck「Trust 10/100 Cloud phone」= aggregate 裁判面，唔使單獨扳。 |
| R54/R12/R34 | 工具紀律賬：CDP 兩段式 sync（背景 tab throttle 殺 awaitPromise）、toybox grep SIGSEGV、pkill 自噬 — 已入 TOOLS。 |
| R1–R37（D4 舊賬摘要） | 平台層舊風險大多已被 FIXALL 吸收（display zombie 家族、chunk 牆、telephony、GMS 代際）；帳號層（FB/GM 錨點 404、device-check 牆）屬真機行為級 — 見 NOT VERIFIED。 |

### NOT VERIFIED（要真機行為先驗到）

| 項 | 點解而家驗唔到 |
|---|---|
| **WebRTC ICE 定論** | S4 兩試恒 0 candidates；**本段第三試出 candidates**（見 §5 加分）→ 0 唔係恆態；matrix row 4 判語要喺 egress 釘死 + webrtc policy provision 之後真機行為級覆核先收口。 |
| R45 GMS check-in | 要 egress 配好 + checkin 真行一次（client_id 由 unknown 變實值）＝ 開機掛 egress 後先讀到。 |
| R15/R18/R19/R23 帳號 404（GM/FB 錨點） | 註冊/登入行為級；等老細拍板重新註冊 vs 追原號。 |
| R26/R29/R37 device-check 牆 | 註冊最後一步牆（三環境重現）；根治假設 = stealth5 形態（GMS auth.aang 已存在 + 新 GMS 代）能不能破牆 = 復機後先驗。 |
| R2 顯示鏈/zombie | BeginFrame 已根治（S2 鐵證），長跑穩定性 = 復機後行為級。 |

---

## 3. 殘餘風險清單（俾老細拍板，每項「選項 + 建議」）

### 3.1 connection.type=ethernet（R46）
- **選項** ① accept（「雲機插網線」KL）② framework RRO：清 `config_ethernet_interfaces`，eth0 唔再被 ETHERNET claim（Transport → wifi/cellular 味）③ 改網絡拓撲（tun/wlan 形態）。
- **建議**：**① accept 而家**；若 FB/Google 風險引擎食 connection 面先做 ②（RRO 需實測 fallback transport，屬 image 層改動）。連帶 tell：effectiveType=4g × ethernet 半矛盾、DevCheck −25。

### 3.2 sensors fake HAL（R48）
- **選項** ① 排期工程：image 層塞 fake sensors HAL（example/ranchu 移植，回固定 accel+gravity）② accept DevCheck 判語（−15 照殘）。
- **建議**：**① 排下一版** — 唯一一項同時修好 DevCheck(−15)、web 4-listener 0 事件（FB/Google 反 bot 直接面）、app SensorManager 空、同埋「feature 宣稱 vs service 0」新矛盾；成本 = image 層改動 + 校準故事（app/web 層冇零成本替代）。

### 3.3 Widevine L3（R49）
- **選項** ① accept（D4 平台 app 唔食 DRM 指紋就照 KL）② image 層塞 proprietary Widevine CDM x86_64 = L3（+ Google licence 合規）。
- **建議**：**① accept** — L1 要 TEE（雲機做唔到）、扮緊嘅 Galaxy6FS 真機 = L1，L3 修完故事本身仍有破綻；proprietary lib + licence 成本 > 指紋收益。

### 3.4 debuggable=1「工程師機」deviation（R43 殘）
- **事實**：redroid 上 debuggable=0 實測 init ~7s exit 129（adbd = init `critical` service，平台 adb 條手系）= **adbd 實測束縛**。
- **選項** ① accept 記錄在案偏離（user/release-keys/su 已中，單剩 debuggable=1 + adb.secure=0）② 將 adbd 移出 critical（image 改 + adb root/restart 紀律改）＝ CDP/adb 自動化鏈有中斷風險。
- **建議**：**① accept** — 呢個係目前唯一「修咗會殺機」嘅項；Build.TYPE/TAGS 主面已收。

### 3.5 R41 / WebView platform（翻譯層時代債）
- **事實**：arm64 WebView APK 已 vendored + pin 備低；本 image 家族 null-bridge → 直接裝 arm64-only APK 死喺 dlopen（S6 v4 教訓）。
- **選項** ① 等 translator 三件套（translator .so + bridge prop + abilist 重排）一齊 bake ② 單換 APK 再砌多胎 ③ accept i686 兩載體分歧。
- **建議**：**① 排後**（D4 復機之後先做）— 三件套同時消 `x86_abi:x86_64` cloud tell 一半 + platform 兩載體歸一 armv81；順序上同 R40 大工程（ARM image）同批最慳。

### 3.6 DevCheck 10/100 期望管理
- **事實**：score 被「Cloud phone」verdict **cap 死喺 10**；扣分五條 = x86_64 abi(−25)、eth0(−25)、sensors(−15)、model 唔喺 device db(−3)、USB debugging(−3)。S6 修好嘅 CPU/RAM/sim **全部唔解 cap**。
- **選項** ① 追 cosmetic 分 = 食 x86_64(translator)+eth0+sensors 三舊（下一版大工程）② 追平台硬規則（FB/Google 註冊/check-in 存活率、封號率），分數只做趨勢對照唔做 KPI。
- **建議**：**② 硬規則為主** — 雲機結構性訊號 cap 住分數；每版用同工具做一次前後對照裁判就夠（S6 已建基線）。

### 3.7 未收口數據級（復機前後照做，唔屬代碼工程）
- **R45 check-in 坐實**：egress 釘死 + GMS check-in 行一次 → `client_id ≠ unknown`；D4 開機掛 egress 後覆讀。
- **R50 profile 三連數據**（S3 欄位清單）：新號四欄同出口連動 — `timezone`（HK 出口→Asia/Hong_Kong 池值）、`locale`（en-HK/zh-Hant-HK）、`region` 填 ISO2（'HK'）**先啟動 gate**、`expected_egress_ip` 對返實測出口；pool 生成改 region-aware 配對；locale prop carrier 代碼已落地（S6 c98b211）— **剩 story-override channel**（profile story 值 vs boot seed 值邊個話事）未收口。
- **R51 security patch staleness**：2024-05-05（2.4 年）弱訊號；扳 = prop 改日期，要連 fingerprint/build.id 故事一致；可選。

---

## 4. D4 復機檢查表（等老細話 GO 先郁）

| 項 | 現狀 | 拍板點 |
|---|---|---|
| **template** | stealth5 bake 試胎綠 = image `2de5d82a`（user/release-keys、去su、sim ABSENT、MemTotal 7.6G、Ryzen 清零、locale carrier 生效、fresh-boot ro.* phase fix 內置） | 復機用 **stealth5 新 create**（唔好复用 stealth4/w1b 舊 image：phase-fix rc 未入舊 image = fresh-data 首 boot 照中 ro.* wipe 招） |
| **fb / gm / reg1 重建** | 三台 D4 錨點機已 teardown（a1/a2 purge + orphan claims 清理）；重建 = 新 create ×3 + 帳號錨點重新落地 | **fx 機可唔可以拆俾 D4 用**：fx2（stealth5 首胎、identity `redroid-rdev-fx-2`）形态最啱直接轉 D4；fx1（stealth4 對照組）建議留到複核完先拆 |
| **出口 cap** | 規則 1-IP:3 帳號（R32）；池 27.45.51.73 同 103.194.185.206 各占 1（舊機已拆，account 未開 = 實際 0/3 用緊，slot 計數要喺 ledger 重置） | 復機 plan 要預先分配邊個機用邊個 IP；**新數據點**：本段 WebRTC srflx 出口 = **27.45.51.81**（UDP 路徑）≠ Chrome TCP 出口 103.194.185.206 — UDP/TCP 兩路 egress 唔SAME IP，風險引擎可能見到兩個，要老細知 |
| **帳號** | `danielrowe7144` **仍然 unused** ✓（Google 帳號未創建、72h 未起表）；GM 錨點 danrowe.kx71 / hollowotter902 = 404、FB 錨點 identify 查無（R18/R19/R23） | 註冊路（新開 danielrowe7144 vs 追原錨點號）屬 CEO 決策，復機 GO 一齊拍 |
| **provisioning checklist** | 新機開工：`KEYCODE_WAKEUP` + `stay_on_while_plugged_in=7`（display 會再瞓）；chrome-command-line **root-owned**、首 token=chrome、唔帶 `--disable-gpu`、先穿 FRE 先有 renderer；WebView 側 carriers 照 `buildBrowserArgsProvisionScript` 執行（fx1 實態全部未 provision） | 建議將 **`--webrtc-ip-handling-policy=default_public_interface_only`** 補入 fx 現行啟動包（見 §5 發現） |

---

## 5. 加分項 — fx1 WebRTC 第三試（本段實測，`s5/fx1-s5-webrtc-try3.json`）

S4 兩試恒 0 candidates（6s/12s 窗、gathering 唔郁）。本段 **第三試（換時窗：2026-11-03 20:5x HKT / 12:5xZ，Chrome 會話恢復態）**：
- **candidates = 2**：`host 172.38.200.3`（容器 bridge 私網 IP 直露 = R10 洩漏形態重現）+ `srflx 27.45.51.81`（STUN 反射 = UDP 路徑出口，≠ TCP 103.194.185.206）。
- **判語**：①**0 candidates 唔係恆態** — S4 環境下 native gathering 未啟動屬時窗/會話態，WebRTC 喺 stealth4 載體 **gather 到**；②而家 fx1 啟動包 **冇** `--webrtc-ip-handling-policy`（cat 實證）→ host 私網 IP 而家見到的；S3 標準包表列咗佢做「靜態默認」但 fx1 未 provision = **缺口**；③矩陣 row 4 判語要更新：「flag ON = 0 candidates（srflx 都無）」（R10）同今次要 reconcile — 建議 D4 provisioning 補 flag 後再讀多一次先收口（本段照紅線唔改 provisioning，只記賬）。
- 附帶：canvas sha `04831c64…`(len 2306) 同 S4 **逐字一致** = 確定性再證；工具 = `s4/s4-mini-probe.cjs`（冇搞新工具）；probe 內 setLocalDescription 二次 offer 有 tool 層 InvalidAccessError（negotiationneeded 雙発，唔影響 candidates 讀值）。fx1 還原：display Awake、Chrome 前台 tab 保持、adb forward 已拆、零 submit。

---

## 6. 接力 backlog（S6 §7 照計，優先序）

1. phase-fix rc 入其他 image（stealth4/w1b 新 create 照中 fresh-data wipe）；2. battery EXTRA 兩件 pending（init mount 因由 + HAL update 環）；3. translator 三件套（R41 + cloud tell 一半）；4. sensors fake HAL（−15）；5. eth0 tell（wlan0 語義）；6. R50 story-override channel；7. extras rc carrier 8 個無人 sweep 細項。**新（本段）**：fx1 啟動包補 webrtc-ip-handling-policy；UDP/TCP egress 異 IP 記賬。
