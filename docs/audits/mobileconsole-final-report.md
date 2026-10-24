# Mobile Console 最終報告（P0–P5 收口）

> 交付物：施工 MD Phase 5 — `docs/audits/mobileconsole-final-report.md`
> 日期：2026-10-24（P5 實測）
> 範圍：Mobile Console 全生命周期收口 — 單機即時串流操作 Redroid 設備（screencap PNG 視頻 + 鍵盤/觸控輸入 + 5 路 fleet + 人工介入）
> 證據根目錄：`logs/mobileconsole-p1/`、`logs/mobileconsole-p2/`、`logs/mobileconsole-p3/`、`logs/mobileconsole-p4/e2e/`、`logs/mobileconsole-p5/e2e/`

## 0. 總結判定

| 項 | 結果 |
|---|---|
| 功能（單機 console：串流 + 輸入 + 狀態機 + 權限） | **DONE**（P2 E2E 10/10，P5 T60 UI 回歸 LIVE） |
| 負載（5 路並行穩定性） | **DONE**（P3 4/4 PASS，FPS 邊界合格） |
| 人工介入（T40–T49 + P5 路徑零洩密） | **DONE** |
| 安全 hardening（P5：unauthorized 矩陣/log leak/rate limit/輸入驗證） | **DONE**（T50–T59 全 PASS，4 項 gap 已修 + 回歸測試） |
| 文件收口（README/api-reference/threat model/ADR/runbook） | **DONE**（見 §2.6） |
| Teardown 零殘留 | 見 §8（teardown 後填） |
| 已知限制 / NOT VERIFIED | 見 §5、§6（H.264、25/50、自然觸發 intervention 等 6 項，全部有原因 + 補驗路徑） |

**一句話：Mobile Console 按 MD Phase 0–5 交付收口；證據分層完整（mock→integration→E2E→真機）；6 項 NOT VERIFIED 皆因宿主/設計邊界而非缺陷，補驗路徑已記錄。**

## 1. 測試環境

| 項 | 值 |
|---|---|
| host | kenneth-System-Product-Name · Linux 6.8.0-117-generic (x64) · RTX 3090 ×2 |
| 真機 | redroid 14.0.0-240527-matrixa-r3 ×5（`redroid-brmc-poc/s2/s3/s4/s5`，720×1280/320dpi，各 4GiB，adb 16500–16504） |
| 軟件 | water_army main（P5 @ 本收口 commit）；scratch stack：api 16490 / web 16492 / sidecar 16493（api child）/ PG 16494 / Redis 16495 |
| 視頻源 | `screencap` PNG（ADR-020 常規預設；H.264 未用 — gralloc blocker，見 §5 NV1） |
| 權限模型 | viewer（唯讀串流 + 讀 intervention）/ operator（controller 串流 + intervention 操作）/ admin（全部 + 配置） |

## 2. 分階段結果

### 2.1 P0 — PoC（redroid 真機 + adb + screencap 可行性）

- redroid 真機 boot（privileged + gpuMode:host）+ adb tunnel + screencap PNG 幀 + `adb input` 输入路徑驗證。
- 證據：`logs/mobileconsole-poc/`（boot-ladder、screencap 幀、input 探測）。
- 產出：ADR-019（screencap 常規預設 / H.264 留後路）。

### 2.2 P1 — 單機 console API（lease/ticket/sidecar/WS）

- 串流 lease（30s TTL、5 路全域 cap、device-scoped 唯一持有）、一次性 ticket（30s、server-side revalidate）、sidecar（scrcpy-jar 校驗 fail-closed + WS 隧道 + screencap 循環 + adb input 代理）、WS 全鏈認證（cookie session + Origin allow-list + ticket 單用）。
- 證據：`logs/mobileconsole-p1/`（T01–T0x raw JSON + p1-summary.json）。
- 測試：unit + integration（lease 狀態機、ticket replay、origin 矩陣、sidecar 生命周期）。

### 2.3 P2 — 單機 console E2E（真機 + 瀏覽器）

- **10/10 PASS**：web login → device list → console 開啟（T21）→ **LIVE 實幀**（canvas non-blank，WS binary frame 直觀觀察，T22）→ 輸入路徑（tap/text，T23–T24）→ 斷線重連（sidecar SIGKILL → RECONNECTING → 新 ticket → LIVE，T27）→ viewer 唯讀 → 權限矩陣。
- 證據：`logs/mobileconsole-p2/`（p2-results.json + t21/t22… 截圖 + ws-obs.json 幀計數）。
- 產出：ADR-020（穩定性定義 + FPS 邊界裁定）。

### 2.4 P3 — 五路負載（fleet 並行）

- 逐級 L1→L2→L3→L5（各 ~11min）：

| 級 | 總頻寬 | host CPU avg/max | FPS/tile | STALL(60s) | 輸入成功率 |
|---|---|---|---|---|---|
| L1 | 20.0 Mbps | 21.2% / 30.6% | 3.63 | 0 | 100%（18/0） |
| L2 | 37.3 Mbps | 27.3% / 38.7% | 3.25 | 0 | 100%（36/0） |
| L3 | 53.6 Mbps | 32.8% / 40.6% | 3.15 | 0 | 100%（54/0） |
| L5 | 75.8 Mbps | 41.2% / 55.0% | 2.83 | 0 | 100%（60/0） |

- **穩定性 4/4 PASS**（5 部正確畫面 / 可接收手動操作 / 5min 無持續黑屏 / ~3-4fps 邊界合格）+ isolation（停 s5 → 其餘 4 路 3.2min 零中斷）。
- Fleet E2E 4 場景 5/5 PASS（第 6 路 409 終極裁判 / close→re-acquire / 雙用戶搶末 slot 201+409）。
- 詳細：`docs/audits/mobileconsole-p3-load-report.md`（數據源 `logs/mobileconsole-p3/`）。
- 產出：ADR-020 req 2/3/8 收口。

### 2.5 P4 — 人工介入（Needs Attention）

- Intervention 狀態機（OPEN→ACKNOWLEDGED→IN_PROGRESS→RESOLVED/DISMISSED + 重開）、signal 寫入（production hooks：network/adb/boot/container + operator_report 受控路徑 + external_verification 強制 blocked_pending_review）、dedupe（device::category::source + signalCount 聚合）、Needs Attention UI（list/detail/deep-link/設備 banner）+ audit。
- **E2E T40–T49 全 PASS**（含 T42 四層零 secret 實證、T45 三權限 console 截圖、T48 audit 計數）。
- 證據：`logs/mobileconsole-p4/e2e/`（p4-e2e-summary.json + t42–t49 raw）。
- 產出：ADR-021。

### 2.6 P5 — 安全 hardening + 文件收口（本段）

#### Hardening 實測（gap 發現 → 修復 → 回歸）

| # | Gap（發現方式） | 修復 | 回歸測試 |
|---|---|---|---|
| 1 | 無 stream create / intervention create 的 request rate limit（MD §11.9）— flood 可打爆 lease/DB | `createRequestLimiter`（per-user fixed window）：stream create+reconnect **10/min**、intervention create **30/min**；RBAC 之後（401/403 唔耗 budget）、system signal 路徑豁免 | `tests/unit/p5-request-limiter.test.js`（5）+ `tests/integration/p5-rate-limits.test.js`（4） |
| 2 | sidecar WS 默認 100MB maxPayload + 輸入無限速 — blind-pipe DoS 可穿 API 隧道 | `maxPayload 64KiB`（超 → 1009 close）+ per-session 輸入 token bucket **30/s burst 30**（超 → `STREAM_INPUT_RATE_LIMITED`） | `tests/unit/stream-sidecar-p5.test.js`（2：oversized frame + input flood） |
| 3 | 剪貼簿/截圖 key 唔喺 scrub 敏感表 — intervention evidence（free-form JSON）可帶 `clipboard`/`screenshot` base64 入 DB/API/audit | `scrub.js` SENSITIVE_KEY 加 `clipboard / screenshot / screencapture / screenimage / screencap` | `tests/unit/scrub.test.js`（P5 用例） |
| 4 | （T57 canary 實測揭露）free text 裸 `password=xxx` + user-only proxy URL 穿過 scrub — 入 `history.detailsJson.summary` | ① `BARE_SECRET` 值規則（`password=/token:` 等裸指派 → 整串 redact；`password=***` 既有 placeholder 冪等唔重掩）② `proxy[-_]?url` 入 SENSITIVE_KEY（MD §13 proxy URL 永不入 log/DB）③ `appendHistory` chokepoint 對 `note`+`details` 統刮（resolve/dismiss/reopen 路徑） | `tests/unit/scrub.test.js`（P5 bare-secret 用例）+ T57b/c/d canary E2E |

#### 安全 E2E 矩陣（`scripts/mobileconsole-p5/p5-security.mjs`，T50–T61）

| 段 | 覆蓋 | 結果（run #11，2026-10-24） |
|---|---|---|
| T50 | unauthorized：6 REST + 2 WS raw upgrade（無 cookie/無 Origin）→ 401/403 fail-closed | PASS（8/8 probes） |
| T51 | viewer 越權：controller acquire 403 / intervention create 403 / viewer-mode 201 正控 | PASS |
| T52 | 跨用戶劫持：operator heartbeat/WS ticket/close 對 admin lease → 403 `STREAM_LEASE_OWNER_MISMATCH` ×3；admin WS 無 ticket → 401 | PASS |
| T53 | Origin 劫持：evil origin 403 / 缺 Origin 403 fail-closed / allowed+ticket 101 正控 | PASS |
| T54 | ticket 重放：consumed ticket 第二次 → 401 `STREAM_TICKET_REPLAYED`；過 TTL → 409（EXPIRED/CLOSED 雙 reclaim 路徑皆拒） | PASS |
| T55 | viewer 唯讀：WS 實到 LIVE + tap/text → `STREAM_READ_ONLY` | PASS |
| T56 | 容量：5/5 持滿 + 409 `STREAM_DEVICE_HELD` ×5 + 放 1 格 → 201 | PASS |
| T57 | **log-leak canary**（鍵盤 text / password / proxy URL / clipboard 四 canary）：API 讀回零命中 + DB-backed 讀回零命中 + API log 零命中 + 零 base64 PNG + 零 >10KB 行 | PASS |
| T58 | rate limit 實測：intervention burst 30/min 429+Retry-After + dedupe 單行聚合；stream burst 10/min 429+Retry-After | PASS |
| T59 | 100KB 超框 → sidecar 1009 拆隧道，API+sidecar 健康、session 歸零 | PASS |
| T60 | UI 回歸：admin 瀏覽器 console → LIVE（banner 已連線 + WS binary 幀實到） | PASS（見 run #11 記錄） |
| T61 | 零殘留：所有 lease 關畢 usage 0/5、run intervention 刪畢 | PASS |

- 證據：`logs/mobileconsole-p5/e2e/p5-security-run11.log`（+ summary JSON + t60-console-live.png）。
- 收口 full suite：**1276 tests / 1270 pass / 0 fail / 6 skipped**（基線 1263/1257/0/6，+13 新測試，零回歸）。

#### 文件收口

| 文件 | P5 更新 |
|---|---|
| `README.md` | Mobile Console 段（用法/權限/環境變量/限制/NOT VERIFIED 總表 NV1–NV6） |
| `docs/api-reference.md` | Stream Console 段（5 REST + 1 WS、認證鏈 8 步、WS frame 協議、rate limit 摘要）；端點總計 105→110 |
| `docs/threat-model.md` | T9 段（8 風險 × 8 緩解 × 殘餘 a–d）+ 風險摘要表行 |
| `docs/architecture-decisions.md` | ADR 索引表（019/020/021/022）+ §22 ADR-022（P5 hardening 決策） |
| `docs/runbook.md` | §12 Mobile Console 串流運維（lease 生命周期/sidecar 重啟/容量/故障對照/日誌 canary 驗證） |

## 3. 證據分層（三類）

| 層 | 內容 | 位置 |
|---|---|---|
| **mock/unit** | 狀態機、scrub 規則、rate limiter、sidecar 守衛、lease/ticket 邏輯（1270 pass 全量） | `tests/unit/`、`tests/integration/`（`npm test`） |
| **integration（HTTP 級）** | RBAC 矩陣、429 行為、dedupe、lease API contract（fastify inject + 真 PG/Redis scratch） | `tests/integration/`（p5-rate-limits 等） |
| **E2E（真機 + 瀏覽器）** | P2 10/10（單機 LIVE+input+重連）、P3 fleet 4/5 場景、P4 T40–T49、P5 T50–T61 | `logs/mobileconsole-p{2,3,4,5}/` |
| **真機負載** | 5×redroid 真機 × 5 路並行 11min/級 × 4 級 + isolation + 5s 資源採樣 | `logs/mobileconsole-p3/`（ladder CSV + p3-resources.csv + 截圖） |

## 4. 已知限制（非缺陷）

1. **視頻源 = screencap PNG**（~3fps @720×1280，p50 ~146ms）— H.264 未啟用（§5 NV1）；MD 穩定性定義「~3-4 FPS 即合格」，操作可用性由輸入路徑獨立保證（P3 輸入成功率 100%）。
2. **5 路 = 單機設計上限**（MD §4.1 全域 cap；第 6 路 409 固定碼）— 25/50 路屬多機 fleet 規模（NV2）。
3. **Rate limit 狀態 per-process in-memory**（container 重啟重置 counter）— MD MVP 註記可接受；共享 Redis limiter 可唔改 call site 落位。
4. **screencap 循環 per-session 串列**（sidecar 內）— 5 路并行已 P3 實測可承受；>5 路需 sidecar 水平拆分（超出本 MD）。
5. **WS 輸入 30/s**（token bucket）— 人手操作量級 10× 餘量；機器人自動化唔係本產品目標用戶。

## 5. NOT VERIFIED 總表

| # | 項 | 點解未驗 | 現有證據邊界 | 補驗路徑 |
|---|---|---|---|---|
| NV1 | **H.264 端到端** | redroid image gralloc blocker（P0 實測：scrcpy H.264 路徑喺該 image 無法取幀） | screencap 回退全鏈可用（P2/P3/P5 全部 LIVE）；sidecar H.264 代碼路徑存在但無真機流量 | 換 scrcpy 兼容 image（或 host 側 hw codec）後跑 P2 矩陣 + codec 斷言（sidecar 已留 `VIDEO_SOURCE=scrcpy` 開關） |
| NV2 | **25/50 路並發負載** | 單機設計上限 5 路（MD §4.1）；25/50 屬多機 fleet 規模，超出本 MD 單機範圍 | 5 路 = 75.8 Mbps / host CPU 41% avg（P3）— 線性外推單機 ~25 路到 CPU 上限（80%） | 多機 fleet 調度（sidecar 水平拆分 + lease 分布式 cap）落位後另開負載單 |
| NV3 | **自然觸發 intervention**（production signal 自動入 Needs Attention） | E2E 只用受控 `operator_report` 注入（MD 允許嘅 qa/test 路徑）；自然觸發要真 network/adb/boot 事故 | 4 條 production signal 寫入函數（network/adbOffline/bootTimeout/containerOffline）unit+integration 覆蓋 + T40–T49 狀態機全鏈 | 真機事故注入（拔網/kill container）後核 Needs Attention 計數 — 低優先（寫入路徑同 operator_report 同一 writer，已驗） |
| NV4 | **live egress（gost 代理實出網）** | 本環境出網受控；gost canary 通過但 console 場景（proxy URL 入 evidence → scrub → 實出網驗證）未做 | proxy 配置/校驗/URL scrub（MD §13）unit+T42 四層零 secret 實證 | 有出網許可嘅環境跑一次 proxy 配置 + canary 出網探測 |
| NV5 | **cookie slot 並發（server fix）** | scrcpy 路徑专用（cookie jar slot 並發修正）；screencap 常規預設唔行 scrcpy 路徑 | scrcpy 路徑未啟用（NV1），該 fix 無真機流量 | 跟 NV1 一齊：H.264 啟用後做 slot 並發壓力 |
| NV6 | **GPU verified 狀態** | 5 機 redroid `gpuMode:host` 跑通（boot+串流+輸入全實測），但 GPU 渲染正確性（vs CPU 回退）無幀級比對 | `configured_unverified` 標記（honest state）；串流幀 rate/延遲正常（P3） | 幀 hash 比對（GPU vs 强制 CPU）— 低優先，唔影響功能 |

## 6. 容量 / 性能摘要（引 P3 報告）

- 單路基線：20.0 Mbps / 3.63 fps / host CPU 21.2%（L1，607s）。
- 五路滿載：75.8 Mbps / 2.83 fps / host CPU 41.2% avg（55.0% max）/ RAM MemAvailable min 25.0GB（host ~26.5GB 基線）— **無壓力**。
- 延遲：p50 ~146ms / p95 ~267ms（L1/L2 ms 級補跑）。
- STALL(60s 無幀) = 0 全級；socket 斷開 = 0；sidecar session dead = 0。
- 輸入：560 樣本 dual-source 一致，成功率 100%。
- 詳細 + 原始 CSV：`docs/audits/mobileconsole-p3-load-report.md`。

## 7. 安全模型摘要（P5 後）

- **認證鏈（WS 8 步）**：Origin allow-list（fail-closed）→ cookie session（RBAC）→ lease owner 校驗 → ticket 單用（30s TTL，server-side revalidate）→ sidecar 二次校驗 → 隧道。
- **零洩密**：scrub 三重（敏感 key / URL userinfo / 裸 secret 指派）+ `appendHistory` chokepoint + intervention 全路徑（create/note/details/audit）+ 5s 內 T57 四 canary 實證（API/DB/log 三層零命中 + 零 PNG base64）。
- **DoS 守衛**：request rate limit（10/min stream、30/min intervention，RBAC 後、429+Retry-After）+ sidecar inbound（64KiB frame cap、30/s 輸入 bucket）+ 5 路全域 cap + lease 三重回收（TTL/reaper/WS-dead）。
- 完整 threat model：`docs/threat-model.md` T9 段（8 風險 × 8 緩解 × 殘餘）。

## 8. Teardown + 零殘留驗證

> （teardown 執行後填實數：containers/nets/ports/dataDir/Redis lease 各 = 0 驗證輸出；compose 用戶 stack 5/5 未動；30000=200。）

## 9. Pre-push sensitive scan（ironclad #6）

> （scan 後填：全 repo grep production credential / API token / 真人資料 = 0 命中；dev-only localhost 密碼 flag 清單。）

## 10. 收口證據

- Full suite：**1276 / 1270 pass / 0 fail / 6 skipped**（`npm test`，2026-10-24）
- Commit 鏈（729c9d0 → 收口）：
  - `80acd2b` P5 stage 1 — rate limits + sidecar inbound DoS guards
  - `ccb5ade` P5 stage 2 — scrub clipboard/screen-capture keys
  - `a74b423` P5 stage 3 — security E2E matrix (T50–T61)
  - （stage 2b bare-secret+proxyUrl+note scrub / stage 3b E2E harness / stage 4 docs / 本報告 — 收口 commit）
- Push：origin/main（收口後填 final hash）
