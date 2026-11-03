# S2 結果 — stealth4 試胎機 fx1 四靶對帳（WA-FIXALL gen3，2026-11-03）

機：redroid-rdev-fx1（template fx-adv-stealth4，image digest sha256:8ec65a4d2125，adb 15000）。
方法：開工現場核對（DB 行喺 id f98b5a19、container exited(137)、data dir 在）→ API start boot 成功（sys.boot_completed=1，無需重建）。
egress：gost sidecar（redroid-matrix-b-gost-redroid-rdev-fx1，host 172.38.200.1:20080）→ 上游 rdev-e1-gost（172.38.223.1:18443）→ mihomo(7897) → **純 socks5 出口 IP = 103.194.185.206（AS4553 Netsec, HK）**。兩側容器 4 日無人跑（exited）→ `docker start` 即復鏈（非重建）。

## 靶A — GMS 應答器（R51/R26 面）：**中**
| 讀值 | stealth3b 前 | stealth4/fx1 後 |
|---|---|---|
| GmsCore | 22.21.16（2022 代） | **26.42.31 (100400-1005867181)，vc 264231013** ✓ |
| GSF | 舊代 | versionCode 34 / versionName 14（A14 配對版）✓ |
| auth.aang DeepLinkActivity | shim 冇 = `am start` **Error type 3** | **component 存在**（`cmd package resolve-activity` 到 + `pm dump` auth.aang 9 hits + `am start` 無 Error type 3）✓ |
| gservices client_id | 未坐實 | **未坐實（殘餘）**：device 層 http_proxy=null（GMS check-in 未行）；gservices content provider 表結構舊（`no such table: gservices`），client_id 要待 egress 配好 + checkin 後先有數 — 屬 S3/provisioning 面，唔屬 image 層 |

## 靶B — 電話棧（R42）：**中（主體）**，1 殘餘
| 讀值 | 前 | 後 |
|---|---|---|
| ro.radio.noril | yes | **no** ✓ |
| ro.baseband | unknown | **g8850-211012** ✓ |
| telephony features | 冇 | **android.hardware.telephony + telephony.gsm 齊** ✓ |
| telephony 服務面 | dumpsys subscription rc=1 冇 service | **phone/isub/isms/imms/carrier_config 全在 service list**、telephony.registry 有 state、`dumpsys isub` = **Active modem count=1** ✓ |
| SIM 形態 | — | defaultSubId=-1（有電台冇 SIM）；**殘餘：gsm.sim.state 空（真機無 SIM 應為 ABSENT）+ gsm.version.baseband 空** |

形態判定：由「無電台（emulator noril）」→「**有電台、冇 SIM 嘅消費機形態**」。TelephonyManager.hasSupport=true 路徑成立。

## 靶C — build/主機形態（R43/R52）：**部分中**
| 讀值 | 前 | 後 |
|---|---|---|
| net.hostname | localhost（兩台一樣） | **Pixel-7**（net.hostname + ro.boot.oem_ro_stealth4_hostname plumbing）✓ R52 |
| ro.build.type | userdebug | **userdebug（保留）**；tags=dev-keys（odm/product/system/vendor 四組一致）；ro.debuggable=1、adb.secure=0、/system/xbin/su setuid **保留** = R43 「工程師機」故事未改 — s2-plan 問「改 user 得唔得」= 今版選擇**唔改**，dev-keys 四組一致性先至係重點；user/release-keys 翻轉留老細拍板（連帶 su/debuggable 一齊改先有意義） |
| security_patch / build.date | 2024-05-05 / May 2024 | 2024-05-05 / 1716819064 **未改**（R51 staleness 殘餘 — GMS 已新但 OS build 仍 2.4 年，新號 checkin 弱訊號） |
| fingerprint/brand 獨一性 | ✓ | ✓（nothing/Galaxy6FS 系，零 redroid 字面） |

## 靶D — BeginFrame / signup 重放（gen1 殘餘牆根治）：**中（根治實證）**
Chrome x86_64 156.0.8078.47 + gen1 規避包（cmdline anti-throttle 3 flags + `--proxy-server=socks5://172.38.200.1:20080` + CDP overlay/lifecycle 每次 nav 後 re-apply + pointer-chain + Input.insertText）。
- **BeginFrame 復活鐵證**：`Page.captureScreenshot` 每一步 **72–120ms 出真幀**（gen1 = timeout 死）；rAF **150–300 fires / 2.5s**（gen1 hidden-throttle 死）；SF 層 candA props 生效實證：`debug.sf.auto_latch_unsignaled=1`、`debug.sf.hwc.min_duration=0`（ro.stealth4.* plumbing → SF props）+ virtual display synthetic vsync 在。
- **重放結果**：name→birthday→**username**→**password** 全程過到（gen1 三振死嘅 birthday→username 已破）。password 步兩格填滿（13 字）、**未 submit**（danielrowe7144 照 unused、72h 未起表 ✓ 紅線）。
- 截圖證據：`d4fx2-name.png / d4fx2-birthday.png / d4fx2-username-filled.png / d4fx2-password.png`（CDP captureScreenshot 真幀；password 幀 = 「Password」h1 + 兩格填 dots）。
- 新形態情報（對 S3+ 有用）：signup form 已換 **combobox 月份 + combobox gender + username radio 三選**（gen1 radio-gender selector 過時）；gender 未選 = Next 靜默 no-op（唔係牆，係 form 完整性）。

### 工具/環境陷阱（本段踩實，入 TOOLS 級）
1. **display sleep = 新機隐形閘**：headless redroid 開機後 `isSleeping=true` → uiautomator null root、FRE 唔郁、SF Idle。正路 = `input keyevent KEYCODE_WAKEUP` + `stay_on_while_plugged_in 7` 先至有得玩（R35 provisioning checklist 要加多呢步）。
2. chrome-command-line 要 **root-owned**（adbd root 先改到 ownership；shell-owned 檔案被食 = R33 陷阱重現路徑）。
3. `--no-first-run` 喺 Android Chrome **唔跳 FRE**（FirstRunActivity 照起）— 照穿 FRE native tap 即可。
4. adb shell 內 toybox grep 大 logcat 會 SIGSEGV（R54 家族，兇手係 grep 唔係被測物）。
5. fx1 container 本身喺 172.38.200.0/24（eth0=172.38.200.3）→ Chrome proxy 直接用 host bind IP 172.38.200.1:20080 就通，唔使 extra route。

## RAM 成本記帳（stealth4 vs stealth3b 口徑）
- 開工前 host MemAvailable 19.0G → fx1 boot 後 idle container RSS **2.12GiB** → Chrome signup session 完成時 **2.45GiB**；host MemAvailable 淨 14.8G（delta ~4.2G，含 Chrome/GMS 後台/gost/cache 雜項）。
- **GMS 後台代價明確**：stealth3b 時代 RAM gate budget = 1,200 MiB/boot；stealth4 單機 idle 已 ~2,100 MiB ≈ **2x**。而家窗口大（D4 機拆咗）唔阻塞；**6–8 台量產時 gate budget 要重新拍板（建議 2,200–2,500/boot）**。
- 加分項 DevCheck AI APK：**KL（本段裝唔到）**— 盤上無 APK、APKPure CDN 403 bot-block（一振收口）；下次用預載 APK 再試。

## 四靶計數
**中：靶A（除 client_id 坐實）、靶B（主體）、靶D（根治實證）**；**部分中：靶C（hostname 中；build 形態選擇性保留 + R51 staleness 殘餘）**。殘餘清單交 S4 全量重掃 + S5 老細複核：client_id checkin、gsm.sim.state=ABSENT、security_patch 日期、R43 user/release-keys 拍板、R40 ABI 面（未動，image 層範疇外照舊）、R48 sensors / R49 Widevine（S2 未做項：sensors HAL 有冇得加 + Widevine L3 — 本段 Focus 四靶，呢兩樣照 s2-plan 屬 stealth4 範圍但 FX1 未測，標 **S2-RESIDUAL 待 S4 重掃判定**）。
