# W3 真機待辦清單（IP↔身份強綁定 — live egress 矩陣）

**狀態：NOT VERIFIED（NV4 紀律）** — ADR-027 §27 嘅代碼段（unit + mock integration 全綠、canary 零洩漏實錚）只證明**邏輯**正確。本清單 = 真實外網 + 真機矩陣，全部跑完 + 回填之前，**`WA_W3_EGRESS_BINDING_ENABLED` 生產保持 OFF**。

**前置（dedicated host，唔好喺生產 host 跑）**：
- 1–2 部 redroid 真機（template 同生產一致、proxy template 有真實 upstream proxy）
- **≥2 個真實出口 IP** 嘅 proxy（例：兩個不同出口嘅 socks5 訂閱）— D5 多身份獨立性必須兩個獨立出口
- 1 個 **IP-echo endpoint**（admin 控制、公网可達、經 proxy 可達）：回覆 `HTTP/1.1 200` + body 含 `client_ip=<源 IP>` + 回顯 query 嘅 `nonce`（例：`https://echo.example/ip?nonce=<n>` → `client_ip=1.2.3.4 nonce=<n>`）。**echo 必須回顯 nonce**（probe 腳本嘅防假證據契約）。
- 一個 **DNS 觀察點**：上游 DNS logger（自建 unbound/kresd + query log）**或** DoH echo（例 `https://dns.google/resolve` 類回顯源 IP 嘅服務）— D4 用。
- 環境變：`WA_W3_EGRESS_BINDING_ENABLED=true`、`WA_W3_EGRESS_ECHO_HOST/PORT`、（可調）`WA_W3_EGRESS_STALE_MS` / `WA_W3_EGRESS_FAIL_THRESHOLD` / `REDROID_HEALTH_POLL_MS`。

---

## D. 真機出口核對矩陣

| # | 項目 | 點樣跑 | 期望結果（通過標準） | 狀態 |
|---|------|--------|----------------------|------|
| D1 | **probe 腳本真機可行性**（ADR-027 §27.2 未實證項） | boot 1 部 device → 等 boot-time verify | device 行到 `egress.state=VERIFIED`；旁證：機內 `timeout`/`mkfifo`/`nc` 存在（`which timeout mkfifo nc`）；`EGRESS=OK nonce=... ip=...` 回傳（diagnostics `network.egress` 或 audit 旁證）；**無** `connect-failed` / shell 報錯（echo 配置正確嘅前提下） | ☐ |
| D2 | **出口核對實證（MATCH）** | binding 嘅 `expectedEgressIp` = proxy 真實出口（host 端 `curl -x <proxy> https://ifconfig.me` 先對上）→ boot device | `egress.state=VERIFIED` + `lastObservedIp == expectedEgressIp`；`network.networkReady=true`；binding `lastVerifiedAt` 有值 | ☐ |
| D3 | **proxy 靜默死亡 → N 秒內偵測**（核心場景） | device VERIFIED 後，喺 **proxy 供應商後台 kill 該 proxy**（或切斷 proxy 上游），唔使 platform 做嘢 | **≤ 1 × REDROID_HEALTH_POLL_MS（默認 30s）**：`egress.state=UNREACHABLE` + `networkReady=false`（任務凍結）；**≤ threshold × poll（默認 60s）**：intervention 出現（`blocked_pending_review`、`EGRESS_PROBE_TIMEOUT` 或 `EGRESS_PROBE_FAILED`）。記錄實際偵測秒數回填本表。**負向驗證**：死咗嘅 device 唔可以 dispatch 任何新任務（worker `get_device_status` = BLOCKED） | ☐ |
| D4 | **DNS 洩露探測**（ADR-027 §27.3） | (a) device VERIFIED 時機內 `nslookup canary.<你控制嘅域>` → DNS 觀察點核對 query 源 IP == pinned egress IP；(b) 機內 DoH 打回顯 endpoint，比較回顯源 IP == pinned；(c) **負向**：kill proxy → 觀察 DNS query 係咪出現非 pinned 源 IP（= 洩露）→ 同時斷言 R3 netcheck ≤1 tick FAILED（漏窗 = R3 偵測窗口，平台已凍結 dispatch） | (a)(b) 源 IP = pinned（DNS 行 tunnel 實證）；(c) 如有非 pinned 源 IP 出現：記錄窗口長短 + R3/W3 凍結有冇先喺窗口內發生 — **任何「流量用咗非 pinned IP 出街」嘅窗口都係安全事件**，halt + 回報 CEO | ☐ |
| D5 | **多身份出口獨立性** | 2 個 identity + 2 個獨立出口 proxy（binding A→IP_A、B→IP_B）→ 2 部 device 同時 boot、同時跑 probe（tick 同步） | 兩 device 各自 `VERIFIED`，`lastObservedIp` 各 = 自己嘅 pinned IP（**互唔同**）；旁證：proxy 供應商後台 / 公共 IP 回顯，同一分鐘內兩身份出口互唔同；DB unique constraint 實錚（第三個 binding 試抢 IP_A → 409 `EGRESS_IP_CONFLICT`） | ☐ |
| D6 | **中途換 IP（drift 實證）** | device VERIFIED 後，**改 proxy 供應商出口**（同一 proxy 認證、出口 IP 變咗；或 binding 未改但 proxy 換咗 IP）— 唔改 platform | **≤ 1 tick**：`egress.state=DRIFTED` + `lastObservedIp` = 新（錯）IP + critical intervention（`blocked_pending_review`）；device **零副作用**（container 繼續 running、net 軸保持 HEALTHY — 人眼可核）；**恢復**：proxy 返去原 IP（或 admin 更新 binding 到新 IP）→ 下一次 probe 成功 → `VERIFIED`；**干預唔自動解**（human resolve 先至 close）— 實錚 human-owned 契約 | ☐ |
| D7 | **binding rotation（admin 主動改 IP）** | admin `PUT /api/identities/:id/egress` 改 `expectedEgressIp`（proxy 同步換） | bound device 即刻 reset `UNCHECKED`（gate 關）→ 新 IP probe 成功 → `VERIFIED`；audit `identity.egress_binding_update` 有 `previousEgressIp`；**canary 紀律**：全程 API/audit/intervention 無任何 proxy URL 字面（抽 audit 檢 `socks5://` 零命中） | ☐ |
| D8 | **echo endpoint 死 = 永唔 VERIFIED** | 配好 W3 ON 但**唔配 / 切斷** echo endpoint → boot device | `egress.state=UNREACHABLE` + `lastErrorCode=EGRESS_ECHO_NOT_CONFIGURED`（或未配置時同款）；device 可 boot 完成但**永遠唔入可用池**（fail-closed 實錚：「開咗 W3 但冇人核對」嘅狀態唔存在） | ☐ |
| D9 | **stale 兜底（watchdog 停擺）** | 調高 `WA_W3_EGRESS_STALE_MS` 到 60s，令 watchdog tick 週期 > stale TTL（例 poll=120s）→ 觀察 | `egress.stale=true` + gate 關（payload 層計算，唔依賴 tick）— 實錚「watchdog 死咗都有兜底」 | ☐ |
| D10 | **canary 真機零洩漏複核** | 用帶**真 credential** 嘅 proxy 跑 D2/D6 一次（真機 log 面） | 抽 API response / audit / intervention / **host 端 log（API log + worker log）** / 機內 logcat（t2s log 只有 `socks5://<device-net-gateway>:<gostPort>` 本機地址，**無**上游 credential）— 上游 credential 字面**零出現**。任何出現 = 安全事件 halt + CEO | ☐ |

## 執行紀律

1. **先 D1**（probe 腳本真機可行性）— D1 失敗 = 腳本層問題（toybox 差異），修腳本先再行其他（mock 過唔代表真機過，NV4 紀律）。
2. D2 → D3 → D6 → D5 → D4 → D7 → D8 → D9 → D10；D3 嘅實際偵測秒數 + D4 嘅 DNS 源 IP 證據 + D5 嘅雙出口證據**必須**喺本表對勾旁邊回填 snippet（時間戳 + 值）。
3. 任何一項發現**流量行咗非 pinned IP 出街**（D4/D6 負向窗口）= **halt 全矩陣 + 回報 CEO**（安全事件，唔係 flake）。
4. 跑完：本表打勾 + 回填 + 更新 ADR-027 索引狀態（`live egress NOT VERIFIED` → 實證結果）；`WA_W3_EGRESS_BINDING_ENABLED` **保持 OFF 直到老細拍板常態開**（常態開 = 全部 D 項 ✅ + 老細 sign-off）。
