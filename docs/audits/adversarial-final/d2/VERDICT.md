# D2 網絡維 — 判語(gen2,2026-10-29,HEAD 851cdd8)

嚴格標準:冇 evidence = FAIL;不降標;每條標根因(代碼/環境/設計)。

## D2-0 老細自測表(四項)

### ① tun 接管無旁路 — **FAIL(結構發現;無 fail-closed 可言)**
- 容器 netns:`lo + eth0` only,**無 tun0**;main 表無默認 route(netd eth0 表 default 生效);`settings global http_proxy = null` ×4 → `net-probes.txt`(d2-driver.sh 18:44-18:47)
- fail-closed 測試:a4 停 sidecar → ping 8.8.8.8 通 + WebView fetch **通**(經 27.45.51.73 host 直通)→ `failclosed.txt`;sidecar 重啟後再測 OK(18:51)
- sidecar 零直連探測:4 台 gost sidecar log 只有 `listening`(零連接記錄)→ 設備層根本唔用 sidecar = `docker logs redroid-matrix-b-gost-redroid-rdev-adv-a*`
- 容器 egress 實測(WebView 內 fetch ipinfo):**27.45.51.73 ×4 = host 直通,唔係 e1(103.194.185.206)** → `net-a1..a4.json`
- 根因 = **設計(拓撲配置)**:WA_W3_EGRESS_BINDING 關 + tun2socks/proxy 未注入容器 → e1/e2 gost 只在出口層(s1 證)存在,設備流量直連 host。「設備流量經共享 egress 群」於本環境 **唔成立**
- **不寫「已安全」**:出口漂移/屬地斷言必須按實測 egress(=27.45.51.73)判,唔可按 s1 label 判。

### ② IP 屬地 vs DNS — **FAIL(resolver 屬地不一致);路徑一致 ✓ 記錄**
- egress 屬地:27.45.51.73 = **CN / Guangzhou / AS17816 China Unicom Guangdong**(`net-a*.json` geo 欄)
- DNS resolver 實測:容器 UDP/53 **直問 8.8.8.8(Google DNS,经 eno1 同 host 出口同 NIC 同源)** → `dns-udp53-sample.txt`(25s alpine tcpdump 樣本,含 172.38.200.9↔8.8.8.8 雙向往返)
- 判定:路徑一致 ✓(DNS 與 egress 同 NIC 同源,無旁路洩漏);resolver 屬地 = Google anycast(無 egress 本地屬地綁定)→ AC「IP 屬地 vs DNS 解析屬地一致」按實測 **FAIL**。根因 = **環境**(image 默認 8.8.8.8,無出口地 DNS)
- Cloudflare DoH whoami 在 CN 直通環境不可達(Failed to fetch)= 記錄(`net-a*.json` dnsWhoami raw)。

### ③ WebRTC 洩漏 — **FAIL**
- 真測(CDP,WebView 125 `RTCPeerConnection` iceCandidate):host candidate = **172.38.200.x(容器 local IP 洩漏)** + srflx = **27.45.51.73(真實外網 IP 洩漏)** 兩者俱在 → `../d1/browser-a*.json` 的 `webrtc` 欄 ×4
- AC「host candidate 零容器 IP、零真外網 IP」雙破 = **FAIL**。根因 = **設計**:無 WebRTC IP policy 過濾(且無 tun 可藏)

### ④ TZ/語言 vs 出口 IP 屬地三方一致 — **FAIL**
- egress = CN(廣州);profile TZ = Europe/Paris / Australia/Sydney / Asia/Bangkok / America/New_York ×4 各異;`navigator.language = en-US` ×4;egress 屬地無一與 TZ 匹配 → `net-a*.json` loc 欄
- 判定 = **FAIL(三方不一致)**。根因 = **設計**:指紋池(TZ/locale)與出口屬地無聯動(預警屬實,實測坐實)

## D2-1 同組出口一致性 — **PASS(按實測 egress 判)+ NOT VERIFIED(第二 IP fleet 級)**
- 4 機 egress **同 = 27.45.51.73**(WebView 層 fetch,`net-a1..a4.json`,19:07 前後採樣)→ 拓撲「1 IP : 4 帳號」於設備層 **成立** ✓
- 但 e1 gost(103.194.185.206)**唔在設備路徑上**(見 D2-0①);s1 嘅 e1/e2 屬出口層探測(host→socks5),引用為 egress 出口證據,唔可引用為設備路徑
- 第 5 機(第二 IP 對照組 b1):19:07 RAM 寬鬆時(9.3 GiB)重試建機 → **RAM_GATE_DENIED**(projected 2091<5400,liveCount=5 含歷史 lease)→ `b1-create.txt` → 「第二 IP fleet 級」= **NOT VERIFIED**(原因:RAM gate 拒;e2 出口層證據引用 s1 `s1-env/egress-topology.txt`)

## D2-2 出口漂移 — **PASS**
- 窗口 18:35→19:03+,36 樣本/120s 週期:e1 18×103.194.185.206、e2 18×27.45.51.73,**零跳變** → `drift-probe.csv`(≥30min ✓)
- 附記:本窗口測嘅係「出口層 whoami」穩定性;設備層 egress=host 直通 = 同路徑恆同(自洽)。

## D2-3 JA3/JA4 抓包 — **值層 FAIL / 骨架層 PASS / 可識別性:家族級可識別(Chromium)**
- 抓包:alpine tcpdump `-i eno1 'tcp port 443'` 窗口 19:11:28–19:12:5x,4 機依序 force-stop→載入 ipinfo.io+httpbin.org 各 2 端點 → `ja3-capture.pcap`(523KB)+ `ja3-driver.log`(每機 fetch 時刻)
- 自寫解析器(依賴=Python 標準庫):`ja3-parse.py`(pcap→TCP 流重組→ClientHello→JA3[MD5]/JA4[SHA256-12]+GREASE 剝除;公式註明於檔內)→ 全量輸出 `ja3-443.txt`,設備窗口摘錄 `ja3-devices.txt`
- **採樣歸屬**:視窗內 Chromium-family hello(16 套件)a1:19:11:46/52/54,a2:19:12:02/03/08/09/10,a3:19:12:18/29/30,a4:19:12:34/41/43 → `ja3-skeleton.txt`(dev 標注);窗外流標 `?`(boss 主機背景噪音,誠實標注不歸因)
- 值層:同版本 Chromium(WebView 125.0.6422.113)×4 機所有流 JA3 **全 unique**(每連接 GREASE 套件@0 + ECH-GREASE 隨機三元組)→ AC「同版本跨機一致」值層 **FAIL**;根因 = **設計(Chromium TLS 堆內稟 GREASE/ECH 隨機化,非本產品缺陷)**;無公開穩定基線(GREASE 世代)→ 按 AC fallback「記錄實測值 + 跨機一致性」處理
- 骨架層:4 機**密碼套件順序逐字節一致**(GREASE@0 + 0x1301/02/03 + 49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53)+ 擴展骨架核心一致 {0,5,10,11,13,16,18,(21),23,27,35,43,45,51,65037,65281}+3 隨機位 → 跨機同族 **PASS** → `ja3-skeleton.txt` 尾段
- 可識別性:固定 16 套件序 + GREASE + h2 = 可識別「Chromium 家族」(iOS/desktop-Firefox 可分);但**無法**由 JA3 區分本機組 vs 任意其他 Chromium 機群(判語:家族級可識別,個體級不可識別 = 對養號係中性偏好)
- Node 控制面對照(host 直連 node fetch):OpenSSL 形態(52 套件/12 擴展/無 GREASE,ALPN h1t)→ `ja3-443.txt` ts≈19:12:32/33 兩流(視窗歸屬存疑,只作形態對照不作判語)

## 匯總
| 項 | 判語 | 根因 |
|---|---|---|
| D2-0① tun 無旁路 | FAIL(無 tun;無 fail-closed;設備直通) | 設計/拓撲配置 |
| D2-0② 屬地 vs DNS | FAIL(resolver=8.8.8.8 ≠ 出口屬地);路徑一致 ✓ | 環境 |
| D2-0③ WebRTC | FAIL(host+srflx 雙洩漏) | 設計 |
| D2-0④ 三方一致 | FAIL(TZ×4 不匹配 CN egress) | 設計 |
| D2-1 同組一致性 | PASS(實測 egress 同 IP);第二 IP fleet 級 NOT VERIFIED(RAM gate) | — |
| D2-2 出口漂移 | PASS(36 樣本零跳變) | — |
| D2-3 JA3/JA4 | 值層 FAIL / 骨架層 PASS;家族級可識別 | 設計(Chromium GREASE) |

**D2 小結**:設備同組同出口拓撲於「host 直通」形態下成立且穩定(漂移零);但「gost 出口群喺設備層被繞過」係結構性發現——任何宣稱「出口受控/可切換 IP」嘅判語必須重新驗證(D4 啟動前應先決定係咪開 W3/tun)。屬地/DNS/WebRTC/TZ 四項全部按實測 FAIL 記錄,無降標。
