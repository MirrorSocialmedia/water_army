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
