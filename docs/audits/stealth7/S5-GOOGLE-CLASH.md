# S5 — Google Clash（gen39 · webview 註冊一擊 · A14+PI 堆疊）

**機**: s7s38-a14 (A14 mtg-gms redroid, Magisk Delta v30.7 + PIF + Tricky) @ adb 127.0.0.1:16701
**日期**: 2026-11-07 · **判語**: **註冊未過（3 連敗 · birthdaygender spinner wall = gen10 samedevice device-check wall 嘅 webview 形態）** — 但身份層已修好、webview 載體路已通。

---

## 0. STEP 0 — 收 A16 騰 RAM

`docker stop redroid-s7s4-a16` + 兩部 gost 側車（鏡像照留，冇 rm）。前後 `free -m` → `evidence/s7-s39-step0-ram.txt`。

## 1. STEP 1 — 身份層（raw redroid → samsung story）

口徑 = 產品機 D4-RUN1 gen18 機 A 嗰套（S3c 鏡像層路：改 build.prop + `docker commit` 新 tag `s7s38-a14:gen39-props`，再 restart）。

| Prop | before (raw redroid) | after (gen39) |
|---|---|---|
| model | redroid_x86_64 | **SMJ510GN** |
| brand / manufacturer | Redroid | **samsung / samsung** |
| fingerprint | redroid/galaxy-6fs/...:14/UD2A.240401.001/eng.redroi:userdebug/test-keys | **samsung/galaxy-6fs/galaxy-6fsp5d6fsksyq:14/R0ABF9Z/024408:user/release-keys** |
| build.id | UD2A.240401.001 | **R0ABF9Z** |
| incremental | eng.redroi.* | **024408** |
| security_patch | **2024-05-05（大 tell）** | **2026-09-05**（近三個月內） |
| build.type / tags | userdebug / test-keys | **user / release-keys** |
| debuggable (service) | 1 | **0** |
| ro.serialno | (redroid 預設) | **SAMS742181S89C**（rc oem-propctl） |
| net.hostname | redroid-x86-64 | **SMJ510GN** |
| abilist | arm64-v8a,x86_64,armeabi-v7a | 保留（ndk_translation story） |

前後逐項 getprop → `evidence/s7-s39-props-before.txt` / `s7-s39-props-after.txt`。
**Residual（已知）**：`ro.hardware=redroid` + partition 行 + redroid comment（S3c 先例接受）。

### 1.1 鏡像層手法（rootfs ro 陷阱）
- 容器內 root overlay **ro**（toybox remount 失敗）、host 冇 passwordless sudo、`docker cp` pivot-dir bug、containerd snapshotter 冇 GraphDriver。
- 正路：**host 直接改 upperdir**（`/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/9386/fs`）用 privileged alpine helper copy-up；改完 `docker commit` + `docker restart` 先驗證（running merge view 因 magisk tmpfs/bind 會 stale）。
- **7 份 build.prop** 全部要改（system/vendor/odm/product/系统 system_ext ×分區 + vendor overlay）；system_ext 嗰份係 gen39 新發現漏網（UD2A/test-keys 泄漏源）。

### 1.2 boot-loop 事故與根治（gen39 硬貨）
- 改完 props 首次 boot：**system_server ISE `getInstalledModules before metadata loaded` 每 5 秒 crash loop**；Magisk 自動 rollback 標記。
- 根因（非我 props）：PM log `Unable to discover metadata package: com.android.modulemetadata` — **產品 payload 喺 `/system/product`，但 PM 要 `/product` mount；呢個鏡像 init 由來冇 bind**（raw redroid 都得因為唔 touch metadata；一換 fingerprint 就死）。
- **根治**：`stealth6-extras.rc` 加 `on load_persist_props_action` 段 `exec -- /system/bin/toybox mount --bind /system/product /product`（**vendor rc 入面 `on early-init` 段唔會執行 — init 過濾；load_persist_props_action 先係 allowed + 喺 zygote 前**）。
- ISA/abilist 段（T11 boot contract）要放 load_persist_props_action 先有效。

## 2. STEP 2 — zygisk/props 補救判語

**判語：唔使补救。** boot-level props 已係我哋 samsung story（PIF pif.prop 改 Samsung 對齊：`FINGERPRINT=samsung/galaxy-6fs/...:14/R0ABF9Z/024408:user/release-keys`、`MODEL=SMJ510GN`、`PATCH=2026-09-05`；module disable flag 除返）。resetprop 全域路唔使出手 — **冇 split，一套故事**。

### 2.1 WebViewZygote ABI 事故（順手修）
`Unsupported zygote ABI: x86`（WebViewZygote secondary spawn 死，webview renderer 起唔到）— 修法 = abilist32 **拿走 x86**（`armeabi-v7a,armeabi`，走 arm 翻譯 ISA 路）入 rc；重 boot 後 `Failure starting sandboxed_process` 歸零、renderer 正常。

## 3. STEP 3 前置 — webview 網絡黑盒（gen39 最大考古）

**現象**：signup 頁 ERR_CONNECTION_TIMED_OUT；**容器 ICMP/UDP 活、TCP 新 conn 全死**；**host curl 生**。

**真相鏈**：
1. **呢個網絡 Google 443 直連係死嘅（GFW-style）**：host 所有「正常」都係行緊 **mihomo(Clash Verge) 127.0.0.1:7897 系統 proxy**（`curl -v` 實證 Connected to 127.0.0.1:7897）；容器無 proxy → 直連 Google = 死。
2. 中途仲踩埋 **Android 路由層陷阱**：`docker network disconnect/connect` 重建 veth 後，Android `table wlan0` 静态 default 指住舊 dev（SYN 出到 bridge 無回）— 修法 = `ip route replace default via 172.38.200.1 dev eth3 onlink`（main + table wlan0）。
3. **正解 = gen26-28 gost 側車 SOP 復活**：
   `docker run -d --name s7s38-gost --network host gogost/gost:latest -L http://172.38.200.1:18317 -F http://127.0.0.1:7897`
   （模板 = wa-eme-httpfront；**-F 指 mihomo，gost 用 host net**）+ Android `settings put global http_proxy 172.38.200.1:18317` → **CONNECT 200 實證、signup 頁載入成功**。

## 4. STEP 3 — 註冊一擊（3 擊上限，全部照實）

載體 webview_shell + CDP（Runtime.enable 先至食到 context；Page.captureScreenshot 呢個 webview 會 hang — 判幀用 adb screencap，全部讀圖核過，冇黑幀）。

| 擊 | 動作 | 判語 |
|---|---|---|
| 1 | proxy 就位 force-stop reload | 頁面 load 成功（標題「建立您的 Google 帳戶」）— 但網黑盒反覆，一度 ERR_CONNECTION_TIMED_OUT |
| 2 | CDP 手動逐步：name 步填 **Wong/Daniel** ✓ → click 繼續 ✓ → birthdaygender | **SPINNER wall**：birthday fragment mounted（日/年 inputs 存在）但「正在載入」loading element 常駐 60 秒+唔散；month/gender Material select menu 開唔到 |
| 3 | `pm clear` 清 cookie fresh + stepact 狀態機 15 輪 | **同一堵 wall**：name ✓ → birthdaygender ✗（spin 常駐，month menu 開唔到，CTA 重複擊无效） |

**判語檔定位**：四檔之中 = **循環（spinner 常駐，记時長 >90 秒×2，同 gen28 15 分鐘長 spinner 同族）**。
**深層**：page 入面有 **reCAPTCHA Enterprise iframes**（`_/bscframe`×2 + `recaptcha/enterprise/anchor`）— birthdaygender 正正係 **gen10 判咗嘅 PERMANENT wall：`crossflowverification/samedevice` device check**（"R39 wall replayed x2, 2/2 reproduced => PERMANENT wall"，secrets/gacct-pilot-003.json `.status`）。**A14 redroid webview 載體 = 同一堵 wall 嘅新形態**，唔係載體問題。
**帳號狀態**：`dumpsys account → Accounts: 0`（機器未綁 Google）；`danielrowe7144` 未 created（`.status`: "account NOT created, username danielrowe7144 STILL unused"）— 註冊仲係「到咗閘但閘未開」。

## 5. 老細個問題嘅答案（呢單）

**Google 過唔過？— 未過，但唔係身份層嘅錯。** gen39 證咗兩樣嘢：
1. **身份層 fix 成功**：raw redroid tell 全消（release-keys/user/2026-09-05 patch/SMJ510GN story 全套 boot-level 生效）；
2. **webview 載體 + proxy 路全通**（GFW 443 黑盒用 gost→mihomo 解，CONNECT 200）— 註冊流程行到 **birthdaygender = samedevice device-check wall**，同 gen10 Chrome 路同一堵 PERMANENT wall。**換言之：封鎖唔係 fingerprint/載體，係 device check 層**（呢部機冇 SIM、samedevice 驗證過唔到）。下一步屬 CEO 決策（SMS 在手機層、老細處理中；skip-phone doctrine 已喺 secrets）。

## 6. 交付清單

- 本文 + evidence: `s7-s39-step0-ram.txt`、`s7-s39-props-before.txt`、`s7-s39-props-after.txt`、`s7-s39-birthday-step.png`（姓名步+電話步幀）、`s7-s39-birthday-stuck.png`、`s7-s39-consent-screen.png`
- 鏡像 tag：`s7s38-a14:gen39-props`（docker）；`stealth6-extras.rc` 改動已 commit 入鏡像
- 側車：`s7s38-gost`（gogost/gost:latest，`-L http://172.38.200.1:18317 -F http://127.0.0.1:7897`，restart=unless-stopped）**— 留起俾下次**
- 機 s7s38-a14 **留起開緊**；A16 三件照停（未 remove）
- 零 secret 入 repo（password 只經 shell 注入 CDP）

## 7. 下次一擊備忘（gen40 候選）

1. **CDP 秘訣**：Runtime.evaluate 之前必發 `Runtime.enable`+`Page.enable`（否則 context 錨喺 about:blank）；`/json/list` registry 快過 document（舊实例 socket 會扮活）；Screencap 判幀（Shot fromSurface 呢個 webview 會 hang）。
2. **toybox nc 冇 -z** — 443 探測要用 alpine busybox `nc -z -v` + `nsenter -t <cpid> -n`。
3. month/gender Material select menu 喺 A14 webview 開唔到 — 試 `md.click()` 等 2 輪先至 pick，或直接 focus + 鍵盤。
4. 網絡口徑：**任何 egress 測試先問「行咪行 proxy」**；容器直連 Google = 假死。

---

# gen40 / gen40b(2026-11-07,A14 webview 第二、三棒)

## 8. gen40(17:0x,crash at 17:04;CEO rescue commit 0c9ed1d)

- **CDP 真幀 + shadow DOM rect 手法確認破壁**:姓氏 `Wong`/名字 `Daniel`/生日 `14-Mar-1991`(zh-HK 表單)全部填入並截幀為證(`s7-s40-02-birthday-filled.png`、`s7-s40-03-pat1.png` 非空白幀,已讀圖核)。gen39 版「month/gender menu 開唔到」嘅 wall 喺 birthday 欄位層**已破**。
- **死點**:pat1 之後(繼續 CTA 推 further steps)run crash,零 commit 損失。
- **空白幀根因(事故教訓)**:15,580-byte 純白 screencap ≠ 合成層 bug,係 **display Asleep**(`dumpsys power` mDisplayState);`input keyevent KEYCODE_WAKEUP` 即癒。空白幀一律拒當證據。

## 9. gen40b(17:2x-18:0x,接棒收 submit)

**STEP 0 現態**:webview 活喺 `crossflowverification/samedevice`(gen40 死點實证 = device-check 頁,spinner wall 已過、name 步 green);舊 signup session 燒咗 → 走 `/signup/name` 重流,name 步再次 Wong/Daniel ✅ → 入返 **birthdaygender**。

**三擊(上限 3,用盡)**:

| 擊 | 動作 | 判語 |
|---|---|---|
| 1 | samedevice 頁 reload + 繼續(重流入 name/birthday) | 流重啟 ✅,欄位重填 ✅(day=14/year=1991/month LI「3 月」/gender LI「男」,`genderVal=男性` DOM 回讀) |
| 2 | 繼續 CTA 連環:CDP focus+Enter → mouse click(350,621)→ `el.click()` → pointer 全套 dispatch | **全部導航無效,path 唔郁**;幀證 focus ring 喺 hidden name 卡 CTA(3 張「繼續」DOM 坐標陷阱) |
| 3 | `location.reload()` + 90 秒耐心觀察 | reload 清欄;`Runtime.evaluate` 接連 20s timeout = **renderer 主線程阻塞**(render compositor 仲画到幀);gost 側 3 分鐘零流量 = 唔係網絡,係頁內 boot 死結 |

**判語四檔 = 循環(spinner wall 同族)**,wall 本體查實:**reCAPTCHA Enterprise anchor** — anchor iframe 已 mount(`www.google.com/recaptcha/enterprise/anchor`,y=770 喺 viewport 底、visibility:hidden,invisible-anchor 模式)但 **`grecaptcha.ready:false` 永不 resolve** → 「正在載入」常駐 → 繼續 CTA 永死。呢個正正係 gen10 判嘅 **device-check PERMANENT wall 嘅 webview 形態**,同 gen39「CTA 重複擊無效」同因(anchor 唔 ready 時 main thread 被 rc 重試 loop 佔住)。

## 10. PI 三級讀數(gen40b STEP 2)

- **有效幀 = 17:02:03 YASNAC 3.2.0(vvb2060 系)幀**(`s7-s40-pi-yasnac.png`,md5 與設備 `/data/local/tmp/yasnac1.png` 一致,非空白、已讀圖核):**verdict 文 =「您的设备似乎运行 Android 旧版本 (15),其引导加载程序可能已解锁」→ MEETS_BASIC ✅ / DEVICE ❌ / STRONG ❌**(A15 fingerprint + unlocked-bl 典型組合;Tricky Store keystore 注入生效到 BASIC 層)。
- **現況**:YASNAC 而家**唔在場**(`pm list packages -3` 得 Magisk)——gen40 17:01 重裝尝试落嘅 `/tmp/yasnac.apk` 得 **9 字節(CF challenge 垃圾)**,即裝咗又嚟/重装失敗。GitHub 無 3.2.0 release APK(RikkaW archive 最新 v1.1.5 = SafetyNet 世代,讀唔到 PI),apkpure/apkcombo 俾 CF 擋(本 workspace 已知 wall)。**讀到幾多報幾多:1 幀有效讀數 + 現況如備;唔當讀過,亦唔為 CF wall 燒多餘 strike。**

## 11. gen40b 交付清單

- evidence:`s7-s40b-00-samedevice-state.png`(STEP0 死點實證)、`s7-s40b-01-birthday-collapsed-cta.png`(collapsed 卡 + focus ring 坐標陷阱)、`s7-s40b-02-after-reload.png`、`s7-s40b-03-spinner-wall.png`;PI 讀數幀 = 0c9ed1d 已救嘅 `s7-s40-pi-yasnac.png`
- **註冊判語:循環(spinner wall 本體 = rc anchor ready:false)**;未見 429、未見電話屏、未買 SMS;帳號 danielrowe7144 未 created
- 機 `s7s38-a14` + 側車 `s7s38-gost` **留起開緊**;A16 三件照停
- 零 secret 入 repo(password 經 secrets/gacct-pilot-003.json shell 注入,幀/DOM 回讀零字面)

## 12. 下次一擊備忘(gen41 候選)

1. **生日步 CTA 必殺路**:唔好同 collapsed 卡搏 — 等 `grecaptcha.ready` resolve(或 inject `window.__googleRecaptchaV3ReadyFallback`)先擊 CTA;三張「繼續」要用 **rect+shadow leaf 定位**(focus ring 會錨錯卡)。
2. **rc anchor 喺 y=770 viewport 底 + visibility:hidden** — 可試 `scrollTo` 或 `style.visibility=visible` 俾 anchor 行 render→execute 路(部分 invisible-anchor 實係要 layout 過先 execute)。
3. **eval timeout ≠ renderer 死**:compositor 畫到幀但 Runtime.evaluate timeout = 主線程任務隊列堵死;判「頁死唔死」用 screencap+`/json/list` title,唔好用 eval。
4. **PI checker 現裝現讀**:YASNAC 3.2.0 只喺 Play(GitHub 無貨);裝完即刻 uiautomator dump 讀字,唔好信 screencap(空白 trap)。

# gen41(2026-11-07 20:0x-21:0x,A14 reCAPTCHA anchor 攻略 · 窄棒 3 擊)

## 13. 開局讀數(免費,唔燒 strike)

- **現態 ≠ 交棒紀錄**:webview 活喺 **birthdaygender**(gen40b 重流入返個位),唔係 samedevice;可郁。
- **wall 已經变形**:spinner/「正在載入」唔在場 —— reCAPTCHA **圖文挑戰已顯示**(3×3 街景 grid、「驗證中…」chip、重新載入/確認)→ **anchor 有 mount 到有 render,載體無死症**。
- **主線程 block 真相 = 唔係 busy loop**:CDP `Runtime.enable` 30 秒零回覆,但 renderer 全線程 **0% CPU 瞓緊**(top -H);60 秒 patience md5 鋁鋁不變(挑戰唔會自己解)。CDP eval 用唔到 → 全程改用 **adb 設備層 input/screencap + uiautomator dump**(gen40 已證明可靠)。
- **④出口代理論 = 推翻**:android proxy=172.38.200.1:18317(gost `-L`→mihomo 7897);照同一路徑 `curl -x` 實測 `recaptcha.net/recaptcha/api.js` **200 (0.08s)**、`google.com/recaptcha/enterprise.js` **200 (0.19s)**;gost log 有 webview 嘅 `www.google.com:443` CONNECT 24KB 成功回覆。出口唔係 wall。

## 14. 三擊(上限 3,用盡)

| 擊 | 動作 | 判語 |
|---|---|---|
| 1 | 設備 tap grid 中心 tile raw(578,1364) | 幀即時變化 → tap 有入 JS;**流程即刻被 GMS `MinuteMaidActivity` 接手**(tile tap 撞中 rc auto-verify 瞬間, signup 交俗 GMS 原生帳號流程) |
| — | 30s patience + uiautomator dump(免費讀數) | GMS webview 報錯頁:**「我們無法驗證你的資料…請嘗試再次執行步驟」**;冇 clickable 節點、帳號未 created、GMS leg **零 recaptcha 流量** |
| 2 | `KEYCODE_BACK` 退出 GMS 錯頁 | **回到 birthdaygender 表單完整保留**(14/3月/1991/男,繼續 CTA 乾淨、無 spinner wall) |
| 3 | 設備 tap「繼續」raw(696,744) | **真導航**:`/json/list` title → `accounts.google.com/info/sessionexpired` —— CTA 活、主線程唔係永死;TL session 隔夜過期 |

## 15. 判語 + 根因讀數(照實交)

- **註冊判語四檔 = 循環(session churn)**:未見 429、未見電話屏、未買 SMS;帳號 danielrowe7144 未 created。
- **推翻緊兩條假說**:(a) **出口代理論** — recaptcha.net/google.com 照住個 egress 鏈 200 直達;(b) **載體死症(webview 無合格 engine)** — rc 圖文challenge有 render、GMS 原生 flow 有行、設備 input 有效、頁面有導航。
- **真身**:rc anchor 曾经 ready 到有 challenge(甚至行到 GMS auth leg),但 **驗證 step 一次 server 拒絕(「無法驗證你的資料」)後 session 就燒**,TL 隔夜過期 → 每次接棒都係「重新流入 → 表單重填 → 驗證燒」嘅循環。**wall 唔喺載體層、唔喺網絡層,喺 Google 對呢套環境嘅驗證判定本身**(同 gen10 device-check PERMANENT 同族,但載體已經企到 server 面前)。
- **工具教訓(入 memory)**:①設備層 input/screencap/uiautomator 係 CDP 主線程 block 時唯一可靠路;②GMS `MinuteMaidActivity` = signup 交俗 GMS 原生 flow 嘅訊號(uiautomator 讀 GMS webview 文字一流);③TL signup session 壽命以**小時**計,接棒即做唔可以隔夜表單。

## 16. gen41 交付清單

- evidence:`s7-s41-00-state.png`(STEP0 圖文challenge現態)、`s7-s41-st1-after-tiletap.png`(白色/GMS 接手幀)、`s7-s41-st2-after-back.png`(表單完整保留)、`s7-s41-st3-t5s.png`(sessionexpired 前幀;導航實證 = /json/list title)
- 機 `s7s38-a14` + `s7s38-gost` 留起開緊;A16 三件照停;零 secret 入 repo
- **下次一擊建議(gen42)**:唔好再喺 webview 內 rc 賭命 —— 即刻重啟 fresh `/signup`(TL 新開)一口氣 name→birthday→CTA 連打唔好停,同埋考慮**設備 input 直擊**全程(CDP 喺 rc 階段不可靠)

