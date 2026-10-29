# WA-FIX2B R4 — FIX2 s5 補完真機複測判定（redroid-rdev-fx-2，2026-10-29）

機件:redroid-rdev-fx-2（template fx-adv-stealth3 → image lib 後期熱換 = stealth3b layer bytes fc849e97…,見「regression 教训」）;identity redroid-rdev-fx-2(egress 綁 27.45.51.73);RAM gate ADMITTED(projected 2,746 ≥ 2,100 @ live=6)。
載體口徑:**release WebView 125(org.chromium.webview_shell)via CDP = chrome://gpu/D1 同款探測**;無 Chrome app(pm list 得 com.android.webview + webview_shell)。探測方法 s1 同款(fx-cdp.mjs)。

## 1. GLES 面（dumpsys SurfaceFlinger glGetString）
- 修前(stealth2/host 直通,s1 props-gl + r2-gl-strings 記錄):vendor "AMD"、renderer "AMD Radeon Graphics (radeonsi, raphael_mendocino, ACO, DRM 3.57, 6.8.0-117-generic)"、version "OpenGL ES 3.2 Mesa 24.0.8 (git-441f064c1c)"
- 修後(fx-2 實讀,`redroid-rdev-fx-2-props-gl.txt` + ship 重讀):`GLES: IMG, AMD Radeon Graphics, OpenGL ES 3.2 V@0615` — radeonsi/chip/ACO/DRM/kernel/Mesa token 全殺,vendor 唔再係 AMD
- 殘餘:renderer prefix "AMD Radeon Graphics" = **amdgpu firmware sku via DRM ioctl**(kernel 側,唔係 image 檔案字串 — cstr patch 到唔到);vendor token "IMG" 唔係 profile 名(等長 3-byte 限制,"Qualcomm"/"Adreno" 入唔到 GL_VENDOR 原位)

## 2. WebGL unmasked 面（chrome://gpu 口徑,CDP 實讀）
- 修前(`s1/browser-fx1-lvp.json`):unmaskedRenderer "AMD Radeon Graphics (radeonsi, raphael_mendocino, ACO, DRM 3.57, 6.8.0-117-generic)"、unmaskedVendor "AMD"
- 修後(`redroid-rdev-fx-2-cdp-ship.json`):unmaskedVendor **"IMG"**、unmaskedRenderer **"AMD Radeon Graphics"**(零 radeonsi/chip/ACO/DRM/kernel)、version "WebGL 1.0 (OpenGL ES 2.0 Chromium)"、**WebGL 存活**(getContext 正常)
- 零洩漏口徑:GL_RENDERER 面 "llvmpipe" 無、"Mesa" 無、"radeonsi" 無;GL_VENDOR 零 "AMD" ✓
- **regression 教訓(stealth3 → stealth3b)**:stealth3 將 130 個 'AMD\0' cstr 全 rename(ARM)→ **WebView ES2 全死**(getContext('webgl')=null;ARM/ATI/IMG 三種 replacement 全部重現 → 唔係 Chromium vendor 規則,係功能 dispatch token 被改)。offset-level 二分(bisect-results.txt,r1–r8)定位兇手 = **'AMD\0' #128 @ file offset 1917602**(DRI loader gate 字串)。stealth3b = 129 rename + gate 保留 → WebGL 存活 + 字串全效。**stealth3 tag 作廢(開機冇 WebGL = 最_big 指紋異常,唔好開 stealth3 機)**;A/B 對照 evidence:cdp-s2lib-AB(stealth2 lib 復活)、cdp-arm-only、cdp-formatonly(format-only 已證 format ops 無辜)、cdp-img-full。

## 3. Canvas 逐機異（R3 成果真機複測）
- 修前(s1 結論):同 host 同 image 同集 → hash 全同(`s1/S1-RESEARCH.md` §canvas:KNOWN LIMITATION 時代)
- 修後(fx-2 實測,同一探測頁同 D1 口徑):
  - baseline(Light bucket,mount 源 sha a3218b4d = Roboto-Light):**sha256 dff79defa26cb4a2…**(多次讀值一致)
  - swap Black(90e34722)→ **8b97a89dc7ea2c4a…** ≠ baseline
  - 還原 Light → **dff79def…**(逐 byte 復現)
- A≠B 口徑(誠實):**單機 variant 前後對比 = 兩值實證**(CEO 23:46 批准口徑);fx-3 兩機同場因 RAM 窗口未開(3 attempts 全 RAM_GATE_DENIED @ MemAvail 8,196–8,638 < 9,400)未有實據。機制 = 決定性 seed(profile FNV-1a)揀 weight variant → bind-mount Roboto-Regular 換檔 → 光柵化輸出異;兩機矩陣留 D4(4 台 a1–a3 + fx 機)
- 殘餘:跨機 hash 兩兩矩陣未跑完(留 D4 前);唔宣稱「打散晒所有引擎指紋」

## 4. WebRTC ICE（載體複測 = s1 結論延續）
- 修前(s1):host priv + srflx pub 雙洩漏;command-line 三件套(setprop / data-local-tmp file / settings webrtc_ip_handling_policy)全部喂唔入 release WebView(實證)
- 修後(fx-2 實測 ×3 probes 一致):候選 `host 172.38.200.11(私)+ srflx 27.45.51.73(pool exit,STUN 回)` — 無 flag 載體下行為如常
- **KNOWN LIMITATION(俾老細,有數)**:release WebView 125 喺 redroid 冇任何可寫 flag 載體(app 層 WebSettings 先改到 iceServers/policy);browserleaks 級探測會見 public srflx(真人手机同樣有 srflx — 洩漏面 = 私網 host candidate);3 探測 candidate 形態零變化 = 配置層已盡,代碼層載體屬 app 集成範圍(D4 平台實戰先有真載體)
- egress 對帳:ICE srflx = 27.45.51.73 = identity 綁定 IP ✓(pool exit 會 rotate:同時 18443 curl 出 103.194.185.206 — per-connection rotation 屬 pool 設計,watchdog drift cosmetic 已記)

## 5. 電池 story
- 修前(s5 時代讀值):全默認(present false、level 0、status 1)
- 修後:provisioning 套用成功(API log "battery drift applied" level 46 + 腳色 marker);重放驗證(`redroid-rdev-fx-2-battery-final.txt`):status 3 / level 46 / present true / plugged 0 ✓
- 殘餘(誠實):**fresh boot 後 readback 返 defaults** — provisioning 落地比 framework 啟動期 BatteryService reset 早(wipe race);drift tick 每 30min 步驟只重 apply level(present/status/plugged 唔會自動復)→ **建議(俾老細拍板):drift sweep 遇 defaults 時重跑 full story script**,屬产品建議非本單範圍

## 6. wlan MAC
- 修前(s5 記錄):無規劃 MAC(eth0 橋接隨機)
- 修後(fx-2 實讀):eth0 MAC **3c:b0:ed:95:8a:c2** = devices.mac_address(planDeviceMac 規劃,DB↔live 對帳 ✓;`redroid-rdev-fx-2-mac.txt`)
- 殘餘:容器冇 Wi-Fi radio → `wifi_macaddress` null、wlan0 不存在(redroid 設計如常;判語口徑 = eth0 規劃 MAC)

## RAM gate 記錄(本輪)
- fx-2 create:ADMITTED @ currentMiB 9,946 / projected 2,746 ≥ 2,100(postBootTarget 2100,老細 22:15 選 B)— `ram-gate decision` log 落檔
- fx-3 create:窗口未開 — 23:41–23:46 CEO 拆 a4 後 9,425 一度過線,我 attempt c/d/e 時已返 8,615–8,638 → 3×RAM_GATE_DENIED(PROJECTED_BELOW_TARGET);**誠實口徑:fx-3 未開機**,canvas A≠B 用單機前後對比

## 判定彙總
FIX2 s5 未竟複測 **補完**:GLES/WebGL/canvas/WebRTC/電池/MAC 六面全部真機讀值;修後狀態見各節「修後」;殘餘 3 項(firmware sku prefix、WebRTC 載體 KNOWN LIMITATION、battery wipe race)+ 1 項待 D4(跨機 canvas 矩陣)。判語標準 = 真機讀值,冇「patch 咗 = 修好」。
