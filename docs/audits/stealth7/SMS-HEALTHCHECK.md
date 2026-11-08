# SMS-HEALTHCHECK — WA-STEALTH7 gen53 決鬥前全量對抗式體檢

**機:** s7s38-a14 @16701(A14 redroid,SM-J510GN 故事,GMS 水管手術後態)
**日:** 2026-11-08(UTC)— 本單 = **體檢唔係手術**:除 docker restart ×1(window 僵死破鎖,17:58Z)外零改動;零 secret 入 repo;黑/白幀即拒;每門 3 連敗照實止。
**對照基線:** gen46 四問(SMS-ADVERSARIAL.md)、gen49–52(S5-GOOGLE-CLASH.md)。**全部 live 實測,未抄舊數**;唯 M4 KeyAttestation 鏈用「沿用 gen46,原因 = keybox.xml md5 未變 + 本 boot keystore2 實報 4-cert chain」(見 M4)。

---

## 九門總表

| 門 | 做法 | 實測(要點) | 判語 |
|---|---|---|---|
| **M1 欄位對帳** | getprop 全矩陣 vs SM-J510GN 故事;pif.prop vs build.prop | 7 區 fingerprint 全同故事、msm8917 全套 ro.*、patch 2026-09-05、hostname 照舊;**PI 層 pif.prop 與 build.prop 無 split**(老細紅線 ✅) | **PASS**(tells 見洩漏分級) |
| **M2 進程/內核洩漏** | logcat -d 洩漏字全扫;/proc/cpuinfo、MemTotal、GPU renderer、sensors、電池 | logcat 無 docker/rancher/localhost;「redroid」×1 只喺档名 redroid-removed-permissions.xml;**cpuinfo = AMD Ryzen 7 9700X ×16 核、MemTotal 92G(RED×2)**;GPU renderer IMG/AMD(ORANGE);GmsCore lib/arm 路徑合理(J5 Prime 都係 arm);電池 86% Charging(set 成功,health/voltage 呢 build 改唔到) | **KNOWN_TELL** |
| **M3 GMS 健康** | checkin 實據、gservices、phenotype、版號、crash 計頻 | **checkin 即時 SUCCESS**(broadcast → 「Checkin Operation finished with result: SUCCESS」);gservices provider 活;phenotype.db 寫入中;GMS 26.42.31;**SUW crash-loop 已熄**(stopped=true 跨重啟,FATAL=0) | **PASS** |
| **M4 PI 三級重讀** | YASNAC 重讀(gen46 API_NOT_CONNECTED 時代理未復甦;而家水管活) | **ATTS 七 verdict(兩個新 request ID 一致):BASIC ✅ / DEVICE ✅ / STRONG ✅ / NETWORK ✅ / STRONG_VM ✅ / INITIAL ✅ / KEY_CERT_VALIDITY ❌**;legacy SafetyNet 有真回應(basic=false/cts=false,legacy 已死語義);keybox md5 = d8f7b3f0…(= gen45c free-pool 交貨)→ 鏈沿用;teeBroken=false | **PASS(新讀數:三盞燈全綠)** |
| **M5 DevCheck 兩頁** | 主頁 + Trust live 重讀(手術後回退檢查) | 主頁 ×3 幀:**Health 100**、**AI 96「Likely genuine」**(gen46 94 → 升 2,無回退)、Battery 86% Charging 倒數計時活;**Trust 明細頁本 boot 未達**(uiautomator 死 + UI tap 不穩,3 連敗止)— 96−100=−4 未拆細(推測 Root −3 + USB −1) | **PASS(主頁)/ KNOWN_TELL(明細未達)** |
| **M6 出廠斷點** | 裝機 app 逐個點名、probe 痕、recent tasks | 3rd-party 只有 **Gmail(留)/Magisk(留)/DevCheck/SafetyNetChecker(文檔叫「YASNAC」命名更正)/KeyAttestation**;webview_shell=系統分區 Browser2;accounts=0;GMS/gm 無「danielrowe」明文;webview **Cookies 有 `__Host-GAPS` + signup cookie 痕**;recent 7 張(含 signup 卡) | **PASS(清單交老細批,冇自行卸)** |
| **M7 出口層** | gost 日志、出口 IP 單一、DNS 洩漏、時鐘 | 出口 = **103.194.185.206**(ipify 經 7897 + DevCheck 兩路同值,單一 HK);48h gost 出口面 **全 Google 域無第三域**;DNS = **8.8.8.8 直出,accounts.google 解析 173.194.203.84(唔係中國值)**;時鐘 skew **≈0s**(機 date = Google 頭 Date 同秒) | **PASS** |
| **M8 帳號/介面** | 帳號、SIM、SUW、proxy、status bar | 帳號 0 ✅;telephony OUT_OF_SERVICE(No SIM 已知紅線);SUW stopped;device_provisioned=1;proxy 172.38.200.1:18317 喺;**transport=ETHERNET(介面名 wlan0)→ status bar 冇 Wi-Fi/訊號格仔**;wifi_on=0 | **KNOWN_TELL** |
| **M9 穩定性** | 容器 restart、crash 計頻、RAM | RestartCount=0(除本棒 docker restart ×1);**新增事故報老細:vending `Unexpected safety source: GooglePlayProtect` bgExecutor fatal ×41 = 每分鐘 3–5 次 crash-loop**(GMS 水管活咗先計到頻)+ **boot 期 `SYSTEM PROCESS: PackageManager — Unsupported isa 'x86_64'` dexopter fatal ×1**(翻譯層出生證明);宿主 available RAM 9.9G | **KNOWN_TELL** |

**總判:九門無 FAIL。** SMS 決鬥可行;RED 只有 M2 兩項(核數/記憶體 — 出生證明級,GMS 至今未拒,見分級)+ 決鬥日清理清單照做。

---

## 洩漏分級(決鬥日體感:GMS/Google 見唔見得到)

### RED(GMS 睇到即致命/最接近致命)
| # | 項 | 邊度見 | 狀態 |
|---|---|---|---|
| R1 | `/proc/cpuinfo` = AMD Ryzen 7 9700X ×16 核(故事 msm8917=4核) | 任何 app 讀 cpuinfo;DevCheck 已讀出 | 鏡像未改;ATTS STRONG 仍綠 → Google 未拒 |
| R2 | MemTotal ≈ 92GB(真 J5 Prime 1.5GB) | /proc/meminfo;DevCheck 讀出 | 同上 |
| (R3) | webview **Cookies `__Host-GAPS`**(瀏覽器有 Google 帳號 session cookie) | signup webview 自讀 cookies | 帳號未開通 → 中性偏痕;決鬥日清 webview data 可抹走 |

### ORANGE(GMS 未拒但露餡)
- `ro.boot.redroid_*` ×5 屬性 + `/vendor/etc/permissions/redroid-removed-permissions.xml` 档名
- GPU props + renderer 自報(IMG/AMD、mesa/gbm/lvp)
- GMS 本機:GmsCore 載 `/product/priv-app/GmsCore/lib/arm`(arm 自報 — 對 J5 Prime 合理,但 + ndk_translation 組合係出生證明)
- **transport = ETHERNET**(真機應 WIFI/CELLULAR)+ wifi_on=0
- 電池 health/voltage/technology 設唔到(A16 限制)— DevCheck 只用 level/present,夠用
- **vending PlayProtect crash-loop ~4/min**(logcat 面;Google 服务端唔見)
- **service.d/98 電池視窗喺 RAM 壓迫下唔夠 120 秒**(本 boot 失敗過 → 即場補 set;boot 後要 dumpsys 覆核)

### YELLOW(出生證明級,只對「肯讀嘅」露餡)
- `ro.product.cpu.abilist` = x86_64 全套(ndk_translation 無 rwx mappings — gen 前案)
- PMS dexopter `Unsupported isa 'x86_64'` boot fatal ×1/boot
- hostname(`kenneth-System-Product-Name`?→ 機內 hostname 已照故事 set,M1 核過)
- DevCheck「redroid (container detected)」紅 chip(summary 顯示,唔扣分)
- `time_zone` global = null(未設 HK)
- recent tasks 7 張(probe 卡面)
- MEETS_KEY_CERTIFICATE_VALIDITY ❌(free-pool 盒證書有效性旗)

---

## 決鬥日清理清單(交老細批,本棒冇動手)
**要收(probe):**
1. DevCheck → force-stop + 收 recent(可卸)
2. SafetyNetChecker(「YASNAC」)→ 同上
3. KeyAttestation → 同上
4. webview_shell(Browser2)→ **清 data(抹 GAPS/signup cookie 痕)** + 收 recent;要留就 force-stop
5. recent tasks 全部清 7 張(尤其「Sign up」卡)
**要改(設定):**
6. `adb disconnect` + USB debugging 熄(AI 分 +預期 96→97+;gen46 结论仍有效)
7. `pm disable-user --user 0 com.android.vending`(Play Store 4/min crash-loop 即停;唔使卸)
8. 電池覆核:boot 後 dumpsys battery 必核 86/present/status/AC(service.d/98 視窗唔夠長 — 即場 set 兜底)
9. (可選)`settings put global time_zone Asia/Hong_Kong`
**唔郁:** Gmail(留)、Magisk(留)、proxy、pif/keybox(md5 照舊)、帳號 0。

---

## 事故記錄(本棒照實)
- docker restart ×1(17:58Z):M4 首讀時 window system 僵死(screencap 五幀同 md5、SystemUI 鐘停、mCurrentFocus=null)→ 破鎖;重啟後 network validated 18:00:40、電池再 set、GMS TLS 照走。
- uiautomator 本 boot 死(null root ×3)→ 全程 screencap + 讀圖;黑幀 15580B(md5 a2f9d4…)即拒 ×2。
- adb 掉線(「device offline」)即場 reconnect ×3(唔算連敗)。
- DevCheck 俾 LMK 殺 ×1(宿主 RAM 壓);KeyAttestation app 開完自收 ×3(UI route 未破 — keystore2 log 已畀 4-cert chain 實據 substitute,照實記「沿用 gen46,原因:同 keybox md5 + 本 boot chain 實報」)。

**evidence:** `s7-s53-m1-reads.txt` … `s7-s53-m9-reads.txt` + 幀 `s7-s53-m2-*`、`s7-s53-m4-yasnac-*`(ATTS 三綠 ×2 時點)、`s7-s53-m5-devcheck-dash/dash2/dash3.png`(100/96/Charging ×3)、`s7-s53-m4-keyattest-*.png`。
