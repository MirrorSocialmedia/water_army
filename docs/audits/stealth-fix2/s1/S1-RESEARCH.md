# WA-STEALTH-FIX2 — S1 修復方案真機驗證(rdev-fx-1,單台單 boot)

機:container `redroid-rdev-fx-1`(template `fx-adv-lvp` = adv-stealth clone + `ro.hardware.vulkan=lvp` roOverrides;tag `14.0.0-240527-gms-mtg-oemprop-stealth`;identity profile find-1qq/google/gs101,1440x3200@525 dpr3.28)。建機 20:48,`sys.boot_completed=1` @20:48:55(30s)。
方法:`s1-driver.sh` + `fx-cdp.mjs`(CDP against org.chromium.webview_shell,同 D1 口徑);evidence = 本目錄 `battery-*.txt`/`props-gl.txt`/`browser-fx1-lvp.json`/`gl-angle-vulkan.json`/`webrtc-*.json`。

## 1. 電池(A)— 修復路徑實證 PASS(支持面比工單假設窄)
- prod battery story(stealth-battery.js dumpsys 腳本)經 `docker exec` 落機**即時生效**:`status:3`、`present:true`、`level:79` 全部落 `dumpsys battery` 框架面(app 讀 BatteryManager sticky = 同源)。
- **支持面實測(本 image BatteryService shell `set`)**:支持 = `unplug/reset/status/level/present/ac/usb/wireless/dock`;**不支持 = `temperature/voltage/health/plug/technology/audio/icon/current/charge-counter`(`Unknown set option:`,見迴圈探測)**。prod 腳本 v1 的 `set temperature/voltage` 喺此機係靜默 no-op(不影響 marker)— **修復腳本 v2 必用窄支持面;temperature/voltage 恆零 = 殘餘風險(根因 = image battery HAL,非 shell 面)**。
- `dumpsys battery reset` 還原基準(level 0/present false)= override 只存在 BatteryService 記憶體 → **每 boot 必重新 apply(現有 design 正確)**。
- 建機 provisioning 失敗根因(既有缺陷):**API 容器 adb 不可達 → `waitForAdbBootCompleted` 2400s timeout → battery skip**(docker logs `boot not observed` ×4 佐證);**docker-exec getprop `sys.boot_completed` 輪詢 = 可用替代探測(fx-1 實測 30s 見 1)** → s2 boot 探測加 exec-seam fallback。
- 漂移:級別 = f(seed, time) 純函數(慢降、floor 21、每步 ~30min),搭 net watchdog tick 重新 `set level` 即可(無新狀態)。

## 2. GPU(B)— 實測推翻「env prop」路徑(工單優先序要修正)
- **`ro.hardware.vulkan=lvp` 經 roOverrides(`ro.boot.oem_*` carrier)注入失敗**:fx-1 實測 `ro.hardware.vulkan=radeon`;carrier 殘留 `ro.boot.oem_ro_hardware_vulkan=lvp`(全機 getprop `ro.boot.oem_*` 只剩 4 個:本 carrier + 3 個 cpu/mem 資訊位)— **carrier 的 setprop 被 init 早期已設的 ro 值擋死(ro 一設不可改;T2 教訓重現:patch 錯層唔算數)**。
- GLES/WebGL 面:fx-1 WebGL unmaskedRenderer = `AMD Radeon Graphics (radeonsi, raphael_mendocino, ACO, DRM 3.57, 6.8.0-117-generic)`,與 D1-2 adv 4 機完全同字串(host Mesa 直通;GLES 讀 EGL driver,唔讀 vulkan prop)。
- **`--use-angle=vulkan` 經 command-line 機制 = 無效**(unmaskedRenderer 無 ANGLE 字串)— 根因見 §4(release WebView 唔食 command-line)→ **vulkan 層 cstr patch 只影響 Vulkan-facing 探測;WebView release 嘅 GLES/chrome://gpu 字串喺 image wave2 修唔到,除非換 debuggable/ANGLE WebView build**。
- image 內 vulkan 層候選齊:`/vendor/lib64/hw/vulkan.lvp.so`(+ 其他厂商)= s3 新 tag cstr patch 對象(`vulkan.lvp.so` deviceName cstr,待 s3 用 `strings` 定位「llvmpipe (LLVM…)」式字串)。
- **S1 裁決(俾 s3)**:GPU 字串路徑 = (1) image tag v2 內 **build.prop 層直接改 `ro.hardware.vulkan := lvp`**(唔靠 carrier)+ **vulkan.lvp.so deviceName cstr patch → 宣稱機型 GPU 名**(T2 式);(2) **WebView GLES 面標 KNOWN LIMITATION**(host Mesa 直通字串,老細拍板,唔准当修好);判語標準照工單 = chrome://gpu unmaskedRenderer 真探測。

## 3. WebRTC(D)— 雙洩漏喺 fx-1 重現;三種 flag 機制全部無效
- baseline candidates:`host 172.38.200.11(容器私網) + srflx 27.45.51.73(真出口)`— D2-0③ 形態重現(host+srflx 雙洩漏)。
- **機制探測(逐個實測,全部 candidate 無變化)**:`setprop webviewcommandline` ✗、`/data/local/tmp/webview-command-line` file ✗、`settings put global webrtc_ip_handling_policy` ✗ → **release WebView(com.android.webview 125,非 developer build)喺 redroid 度唔讀 command-line 三件套**;image **無 Chrome app**(pm list:得 com.android.webview + webview_shell)→ 平台實戰(D4)瀏覽器面係 WebView-embedded app,flag 要由 app 層(WebSettings/自製 launcher)帶。
- **S1 裁決(俾 s2/s5)**:產品層 = 瀏覽器啟動參數配置化(AppSetting)+ provisioning 三件套寫入(best-effort,全部留 evidence);**真效果要搭其中一條可用槓桿**:(a) device network  subnet 屬地化(host candidate = phone-式 LAN IP,唔再 172.38 Docker 形)— 產品已有 `ensureDeviceNetwork`,subnet 可配置化;或 (b) tun2socks 開啟時 UDP STUN 自然斷(s1 環境未開 tun,disable_udp 之取捨 = 拓撲決定,唔係 flag 決定)。**s5 複測口徑:實測 candidate 無 172.38/172.x 容器形 host IP(+ srflx = egress 自洽)**。

## 4. Canvas(C)— 數據俾老細拍板(唔准当修好)
- fx-1(dpr 3.28、model/Build/dpi 全部同 adv 唔同)canvas toDataURL sha256 = `298d28a3cc70…`(同 D1-7② adv 4 機全同 hash)= **「同 host 同 image 同引擎 → hash 全同」實證加固:連 dpr/螢幕/機型都唔影響 readback**。
- 候选(全部要嘛改 renderer 要嘛改引擎輸入,lvp 路徑今輪未生效):字體集(同 image 同集)、Skia 逐機開關(需 command-line/app 層,見 §3)、逐機 dpr(已證無效)。**建議裁決 = KNOWN LIMITATION:同 host 同 tag 全同,跨 host(Mesa/GPU 版本)先有異;跨機群關聯風險 = 同 hash 4+ 機時先成立**。

## 5. DNS(E 附屬)
- D2 實測 resolver = 8.8.8.8 直通(同 host 出口同 NIC)。s2 產品面 = 配置化 `settings put global private_dns <區域性 DoH provider>`(fx-1 環境可寫入驗證 readback;真效果受 CN 直通環境限制 — D2 記 Cloudflare DoH whoami 不可達)。屬地校驗(三方一致)先係主修復,DNS resolver = 加分項。

## 環境備註
- API 容器無 adb(TOOLS 既有記錄)= boot 探測缺陷根因;修復验证性開機全程經產品 API + docker exec,零繞路。
- fx-1 teardown 經產品 API(DELETE),teardown ledger 見 progress 檔。
