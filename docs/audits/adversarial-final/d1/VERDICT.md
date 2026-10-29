# D1 靜態指紋維 — 判語(4 真機 redroid-rdev-adv-a1..a4 @stealth tag 86e823fa)

口徑:每條判語附 evidence(本目錄檔);冇 evidence = FAIL;唔准推斷。測時 2026-10-29 18:36–18:52 HKT。
引擎偏差記錄:容器無 Chrome app,D1-7/chrome://gpu 面 = `org.chromium.webview_shell`(WebView 125.0.6422.113 Chromium 引擎,CDP 真測 + device screencap 真截圖 `shot-a{1..4}.png`)。

## D1-1 getprop 全量掃 — **PASS(12/12 ×4)**
- `fingerprint-compare-12.txt`:4 機 12 項 profile props 全部 = DB profile 真值(逐行 got/exp 對照)
- `ro.hardware` / `ro.boot.hardware` = profile hardware 值(edge-2wj / magic-65p / pixel-2gc / phone-4ys)— **零 redroid/goldfish/ranchu/emulator 洩漏**
- 全表洩漏掃描(grep 全 getprop,579 props/機)洩漏位逐個列:**11 行/機,4 機同形態**:
  - `ro.boot.redroid_{dpi,fps,gpu_mode,width,height}`(5 行,kernel cmdline 面)
  - `ro.product.vendor_dlkm.{brand,manufacturer,model,device,name}`(5 行,vendor_dlkm 分區 build 面)
  - `ro.vendor_dlkm.build.fingerprint`(1 行,redroid/... 字串)
  - 以上 = 殘餘訊號,入「剩餘風險清單」;非 D1-1 AC 斷言對象(AC 主斷言 ro.hardware)

## D1-2 GPU 字串 — **FAIL(殘餘訊號;根因 = 設計缺口)**
- `sf-gl-a{1..4}.txt` + `gpu-props-a{1..4}.txt` + `browser-a{1..4}.json`(gl 段):GLES/GL_RENDERER 4 機全 = `AMD Radeon Graphics (radeonsi, raphael_mendocino, ACO, DRM 3.57, 6.8.0-117-generic)`(OpenGL ES 3.2,Mesa 24.0.8)
- 判定:零 SwiftShader/llvmpipe/NVIDIA ✓;但 GL_RENDERER = **AMD Radeon 桌面 iGPU 字串,非宣稱機型 Adreno/Mali 手機 GPU** → AC「= 宣稱機型手機 GPU」不成立
- 根因 = 設計缺口:`redroid_gpu_mode=host` 直通宿主 GPU,image 無 per-profile GPU 名注入;WebGL `WEBGL_debug_renderer_info` 同字串(browser 面實測)

## D1-3 sensorservice — **FAIL(根因 = 環境)**
- `sensors-a{1..4}-{s1,s2}.txt` + `sensors-a1-full.txt`:4 機 `dumpsys sensorservice` = **`No Sensors on the device`(devInitCheck=-19)**,零加記/陀螺儀,無波動可言
- 真機 0 sensors = 強平台偵測訊號(app 層 SensorManager.getSensorList 會見空表)
- 根因 = 環境:redroid image 無 sensor HAL;stealth tag(oemprop 層)未覆蓋 sensors

## D1-4 battery — **FAIL(根因 = 環境)**
- `battery-a{1..4}-{s1,s2}.txt`:level=0、voltage=0、temperature=0、present=false、status=1;60s 兩次採樣恆零
- AC「非恆零/恆100、狀態自洽」不成立(level 恆零 + present=false 不自洽)
- 根因 = 環境:無 battery HAL 注入(同 D1-3 同源的 image 缺口)

## D1-5 MAC / OUI — **PASS(主斷言)+ 1 記錄項**
- `iplink-a{1..4}.txt`(adb 層)+ `iplink-docker-side.txt`(容器層):兩層讀值逐機一致 ✓;4 MAC 兩兩唯一 ✓
- `oui-lookup.txt`(macvendors.com 實查):a1 64:ec:65=vivo ✓(brand vivo)、a2 0c:b9:83=Honor ✓(honor)、a3 d8:da:f1=HUAWEI ✓(huawei)、**a4 60:70:6c=Google ✗(brand nothing)= OUI 品牌不對應,記錄為殘餘訊號(手機厂商 OUI 段主斷言仍成立:Google 為智能機厂商 OUI)**

## D1-6 4 機交叉唯一性 — **PASS(15 欄全唯一)**
- `uniqueness-matrix.txt`:android_id、MAC、12 項 ro.* = 14 欄全對全唯一;UA 欄見下(補)
- UA 來源 `browser-a{1..4}.json`:UA 內 model 逐機不同(Edge2WJ/Magic65P/Pixel2GC/Phone4YS,Build id 亦不同)→ **UA 唯一 ✓(共 15 欄全唯一)**
- 注意:UA 帶 `wv`(WebView)標記 = 引擎面殘餘(真 Chrome UA 無 wv);記錄入風險清單

## D1-7 瀏覽器維 — 分项:
- ① WebGL Renderer 判語:**零 SwiftShader/llvmpipe/Mesa llvmpipe ✓;但 unmaskedRenderer = AMD Radeon(非 profile 機型 Adreno/Mali)= 同 D1-2 同判 FAIL(設計缺口)** — `browser-a*.json` gl 段
- ② Canvas 指紋 4 機兩兩不同:**FAIL — 4 機 toDataURL hash 全同(298d28a3cc70a30a9dbfe5852d289f51a4ff84ffcc…,同字串見 browser-a*.json canvas 段)= 關聯性紅旗**(同引擎同 GPU 直通 → 繪製輸出全同;記錄,唔降標)
- ③ screen/DPR vs 宣稱機型:**PASS(逐機)** — a1 1080×2400@400dpi→CSS432×960 dpr2.5 ✓;a2 1080×2340@395→438×948 dpr2.46875 ✓;a3/a4 1080×2400@420→412×915 dpr2.625 ✓(物理=宣稱 overrides;dpr=physical/160 逐機自洽)
- ④ maxTouchPoints + 真觸控:**MTP=1 >0 ✓(×4);真觸控事件回傳 = NOT VERIFIED(3 次注入 tap/long-press/motionevent DOWN+UP 頁內計數恆 0;根因 = 環境:redroid headless `mCurrentFocus=null` 無 window focus,InputDispatcher 唔派發 — `touch-reread.txt`)**

## 環境缺陷(既有,非本單引入)
- 容器內 `input tap` 派發失敗(focus=null)影響 touch 面 NOT VERIFIED(D1-7④)
