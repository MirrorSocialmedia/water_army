# Egress Group 調度（WA-IPGROUP — 鐵律 2：同出口 IP 嚴禁併發）

> 目標：Google/FB 防封。同一個出口 IP 任何時刻只准一個 identity 喺度操作
> （包括登入動作）；組內相鄰 run 之間再隨機錯峰。跨組並行唔受阻。
> 狀態：**hermetic 測試全綠；真機/live-stack NOT VERIFIED**（驗證併
> WA-ADVERSARIAL-FINAL，見 release-status.md）。

## 1. Group 模型（邊個算「同一組」）

解析源單一：`packages/shared/src/egress-group.js`（scheduler 與 engine 共用，
永遠唔好第二處拼寫）。每個 identity 按優先序解析出 group key：

| 層 | 來源 | group key | 用途 |
|----|------|-----------|------|
| 1 | `identity.metadataJson.egressGroup`（label，正則 `^[a-z0-9][a-z0-9._-]{0,63}$`，自動 trim+lowercase） | `grp:<label>` | **1 IP:N 機制** — identity_egress.expectedEgressIp 係 DB-unique（一 identity 一 IP），要多個 identity 共用一個出口就標同一個 label |
| 2 | `identity_egress.expectedEgressIp`（W3 pinned binding） | `ip:<位址>` | 已 pin 代理嘅 identity 自動成組，零配置 |
| 3 | 無配置 | `identity:<uuid>`（SINGLETON） | gate 短路 = 未配置艦隊行為 100% 不變（零回歸保證） |

## 2. 零併發執行（兩層，DB-backed = 多 replica 收斂）

- **軟 gate（scheduler）**：`ensureRuns` 派發前評估組狀態 — 組內有 active run
  （queued/running/retrying 計）→ `group_busy` defer；錯峰窗未過 → `jitter_wait`
  defer。Defer 係誠實嘅：membership 保持 PENDING（復用 `queued_group_wait`
  語義），下一個 tick 自然重試，唔燒任何預約。
- **硬 gate（engine）**：run 揸住 `egress_group` resourceLease（CAS on lease row）
  先准 claim。兩台 worker 搶同一組：acquire() 話事，輸家 defer（job
  moveToDelayed，run 留 QUEUED，**等位期间零資源持有** — slot 都會還返去）。
  同一 runId 重覆送達 = RENEWED 冪等（唔會自我阻塞，亦唔會殺死 live twin 嘅 lease）。
- 順序：soft gate（2b，抵便宜檢查先行）→ 全局 slot（3）→ **group lease（4a，
  slot 之後 — 等位 job 永遠唔會霸住成個出口等 slot）** → claim CAS。
- Lease 生命週期：heartbeat（10s 拍）同 slot lease 一齊 renew；丟失 → abort
  `EGRESS_GROUP_LEASE_LOST`（對稱 slot-lost，寧停唔錯）；所有 defer/terminal
  路徑立即釋放；崩潰殘留由 reconcile 清掃（owner terminal → 釋放；owner live
  → 同 owner 重新 claim，永不靜默搶佔）。
- Defer 上限：`batchMaxGroupDefers`（默認 80）× `batchGroupWaitMs`（默認 15s）
  ≈ 20 分鐘 → 誠實 `BLOCKED_EGRESS_GROUP` failed terminal（永不無限 spin；
  手動 retry = 現行 FAILED_FINAL → RESERVED 流程）。

## 3. 隨機錯峰（相鄰 run 之間嘅間隔）

**分布寫明**：UNIFORM（均勻）over **閉區間整數 [minMs, maxMs]**，默認
**60,000–300,000ms（60–300 秒）**。抽樣值：

```
jitter = minMs + FNV1a32("<groupKey>|<prevRunId>") mod (maxMs - minMs + 1)
```

- **決定性**（同一組 + 同一 prevRunId → 所有 replica 計出同一個值 = 無狀態收
  斂）；每個新 terminal run 都係新 prevRunId = 每個間隔獨立抽樣。
- 計時起點 = 組內**最後一個 terminal run 嘅 finishedAt**（cancelled 都算
  terminal — 安全優先，照錯峰）。
- **AppSetting 可調**：key `egress.group_jitter_ms`，valueJson
  `{value:{minMs,maxMs}}`；邊界 0–3,600,000ms；min>max 自動 swap（log 警告）；
  非法/超界 fail-safe 返默認（永不阻塞派發）。寫入面：
  `PUT /api/egress-groups/jitter`（admin，見 api-reference.md）。

## 4. 排隊與可觀測

`GET /api/egress-groups`（viewer）回每一組：`activeRunId/Status`（出口忙唔忙）、
`pendingMemberCount`（**組待行數** = RUNNING batch 入面 PENDING 會員數，減咗
正喺組上跑嗰個）、`waitingRunIds`（已排隊 run）、`nextEligibleAt`（**下次放行
估計** = 最後 terminal + 決定性抽樣，任何 replica 計到一樣）、
`jitterWindowMs`（而家嘅窗口）。SINGLETON 組唔入 payload（無隊可觀）。
Scheduler tick 回嘅 `groupDeferred[]` 帶逐會員嘅 defer 原因 + 估計時間。

## 5. 與 per-account limiter 嘅關係（正交兩軸，AND 關係）

- **GmailProvisionCounter / per-account limiter（T5/ADR-030）管「帳號」維度
  嘅頻率**：每 identity 每日配額、每 IP 每日配額、帳號間隨機間隔窗。
- **Egress group gate（本單）管「出口 IP」維度嘅互斥**：同組嚴禁重疊 + 組內
  相鄰 run 錯峰。
- 兩者**互不替代、互唔覆蓋**：一個 run 要兩邊都過（AND）。登入動作由 group
  串行覆蓋（喺組上期間係 exclusive），但唔好當佢係頻率限制 — 反返轉個
  per-account 日配額亦唔會替你防「同 IP 兩個帳號同時郁」。
- 注視點：`WA_GMAIL_MIN/MAX_INTERVAL_MS`（5–15 分鐘）係**帳號創建**節奏；
  `egress.group_jitter_ms`（60–300s）係**出口操作**節奏。兩套窗口各自獨立調。

## 6. 測試與驗證邊界

- hermetic 回歸矩陣：`tests/unit/egress-group.test.js`（串行零重疊時間斷言、
  跨組+singleton 並行、gate 語義、engine HELD→defer→exhaust→release、
  reconcile 清掃、status 契約）+ `tests/integration/egress-groups-api.test.js`
  （RBAC/W3 switch/payload/secret-free/jitter tuning）。
- 真機（多 redroid 共用一個出口 IP、登入動作實測、TTL 崩潰演練）：
  **NOT VERIFIED**，併 WA-ADVERSARIAL-FINAL 執行。
