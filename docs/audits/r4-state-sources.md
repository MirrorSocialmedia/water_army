# R4 — Phase 4 狀態來源盤點（MD §6.1）

- 日期：2026-10-20
- base：main @ c48a49f（R3 完成後）
- 目標：**API / worker / 前端唔再各自推算互相矛盾嘅狀態** — 每欄位有唯一資料來源、唯一寫入路徑、明確更新條件、列明讀取者。
- 方法：全 repo 搜尋 `proxyState`、`running`/`healthy`/`degraded`/`failed`、tun2socks process check、TUN interface check、health probe timestamps、Redroid device status、前端網絡狀態欄/badge；逐寫入點核實代碼行。

---

## 1. 權威狀態核心（R3 已建，R4 不重做）

| 組件 | 位置 | 性質 |
|---|---|---|
| 狀態機 | `apps/api/src/services/redroid-health.js` | pure（零 side effect）：7 狀態 + 合法轉移表 + `assertNetTransition`（HEALTHY 入口 **必須** 帶 fresh bidirectional-TCP-canary PASS evidence — 結構性「no blind HEALTHY」） |
| 唯一寫入路徑 | `redroid-service.js` `persistNet()` | net_* 欄 + legacy `proxyState` 投影一次寫入；非法轉移 = **reject + audit `net_transition_refused` + 零寫入** |
| 權威探測 | `verifyNow()`（control plane + data plane 全套） | container → netcheck（process/tun0/table-100/rule-5000/effective route）→ TCP canary（nonce+sha256 雙向）→ proxy leg |
| watchdog | `healthTickDevice()` + `tickWatchdog()`（30s sweep，`REDROID_HEALTH_POLL_MS`） | 独立監控；stuck-STARTING guard；fail-closed 降級；recovery lock/lease + backoff + max retry（DB lease 跨 crash） |
| 持久化 | DB `net_*` 欄（13 欄，migration 6001983） | restart 後 state 還原（R3 Phase D 實錚：byte-for-byte restore + 新 process 由 persisted anchor 觸發 recovery） |

**結論：權威狀態 = `Device.netState`（+ 隨行 net_* 欄）。任何邊界（API view / worker / UI）都必須經 `buildNetPayload(row)` 投射，唔得自行推算。**

---

## 2. 欄位盤點表（每欄位：唯一來源 / 寫入位置 / 更新條件 / 讀取者）

### 2.1 網絡健康（R4 主角）

| 欄位 | 唯一資料來源 | 寫入位置（line = c48a49f） | 更新條件 | 讀取者 |
|---|---|---|---|---|
| `Device.netState` | netcheck + canary 驗證事件 | **只** `persistNet()`（:789）— 全 repo 唯一寫入點 | `assertNetTransition` 驗證後寫；HEALTHY 入口要 fresh canary PASS evidence；definite loss → 立即 BLOCKED；soft fail → cf++ → DEGRADED(1)/BLOCKED(threshold) | `buildNetPayload`（API view）、watchdog、`scheduleRecovery`、UI（R4）、worker（R4 tool） |
| `netStateSince` | 同上 | `persistNet()` transition 時 | 每次狀態改變 | view（stateSince）、stuck-STARTING guard |
| `netCheckedAt` | 每次 verifyNow 完成 | `persistNet()` `ev.checkedAt` | 每 watchdog tick / refresh / provision / diagnostics verify | view `checkedAt` + **STALE 判定**（> `REDROID_HEALTH_STALE_MS` 60s → stale=true, networkReady=false） |
| `netLastSuccessAt` | canary+全套 PASS 時刻 | `persistNet()` `ev.lastSuccessAt`（只喺成功路徑寫） | 全部必要 check PASS | view `lastSuccessAt` |
| `netConsecutiveFailures` | 連續失敗計數 | `persistNet()` `ev.consecutiveFailures` | 每次 verify 失敗 +1；HEALTHY 重置 0 | view、DEGRADED→BLOCKED 門檻 |
| `netLastErrorCode` / `netLastErrorDetail` | 最近失敗代碼/原因（machine-readable） | `persistNet()` `ev.errorCode/errorDetail` | 失敗路徑寫；HEALTHY 寫 null | view `lastError{code,detail,at}` |
| `netLastCanary` | 最近 canary 原始狀態行（`CANARY=PASS/FAIL nonce=... reason=...`） | `persistNet()` `ev.lastCanaryLine` | 每次 verify（container running 時） | view `lastCanary{result,latencyMs/nonce/reason}` |
| `netRecoveries` | 本 episode 自動恢復次數 | `persistNet()` `ev.recoveries`（recovery 時）/ HEALTHY 重置 0 | recovery attempt 觸發 | view、budget 判定（maxRetries / stallMaxRetries） |
| `netLastRecoveryAt` / `netNextRecoveryAt` | 上次恢復時間 / **persisted backoff anchor** | `persistNet()` | recovery 觸發；watchdog arm；manual retry 清空 | view、`computeRecoveryDecision`（crash-safe 排程） |
| `netManualIntervention` | FAILED 人工介入旗 | `persistNet()`（FAILED→true）/ HEALTHY / manual retry 清 | 見左 | view（UI 顯示「需要人工處理」） |
| `netRecoveryLockOwner` / `netRecoveryLockUntil` | 恢復 lock（DB lease） | `acquireRecoveryLock` / `releaseRecoveryLock`（raw SQL conditional UPDATE） | 單飛：另一 process 持 lock → 本 tick WAIT（唔 spin） | `scheduleRecovery` |
| `Device.proxyState`（legacy） | **`netState` 嘅保守投影** | **只** `persistNet()`（:810，`NET_TO_LEGACY_PROXY`）+ createDevice 初建行（:1577 `off|provisioning`） | 投影表：HEALTHY→running，DEGRADED→stopped，BLOCKED/FAILED→error，STARTING/VERIFYING→provisioning — **unhealthy 絕不投影 running**（fail-closed，R3 Phase A 實錚） | `deviceView.proxy.state`（pre-R4 消費者）；UI R4 起**唔再**用佢顯示網絡狀態（改讀 `network.state` 文字） |
| `proxy.network`（computed，唔落庫） | `buildNetPayload(row)`（pure） | 每次 view 計算 | row 變化即時反映 | `deviceView.proxy.network`、`refreshDevice.network`、diagnostics network zone、worker tool（R4）、UI（R4） |

### 2.2 裝置其他狀態欄（邊界核實 — 各有獨立來源，互不推算）

| 欄位 | 唯一資料來源 | 寫入位置 | 更新條件 | 讀取者 |
|---|---|---|---|---|
| `Device.containerState` | **Docker daemon inspect**（source of truth） | createDevice（:1569 `provisioning`）、`runDeviceAction`（:1814 result.state / :1809 `missing`）、recovery restart（:1056）、`refreshDevice`（inspect） | 每次 inspect / action / refresh | `deviceView.containerState`（UI 容器 badge）、provision 判定、diagnostics |
| `Device.adbState` | **adb `get-state`（whitelist op）** | `refreshDevice`（online/offline/unknown）、createDevice（`unknown`）、container missing（`unknown`） | refresh 時容器 running 先查；adb 不可用 = `unknown`（**never implied-healthy**） | `deviceView.adbState`（UI badge） |
| `Device.gpuStatus` | **in-device render check（P5 未實裝 → 永遠唔係 verified）** | createDevice（:1573 `unverified`\|`software`）、diagnostics gpuVerification（現行唔寫回 — 保持誠實） | 只有真 in-device 渲染驗證可改（MD §2.4） | `deviceView.gpuStatus`（UI badge「未驗證」） |
| `Device.binaryState` / `binaryVersion` | **in-device binary staging check（R1）** | `checkTun2socksBinary` + `setBinaryState`（provision 第 3 步） | provision 時 fail-fast check（missing/invalid/error → FAILED，device 絕不 running） | `deviceView.proxy.binaryState`；R4 起 = `network.checks.binary` 來源 |
| `gostPort` / `gostBind` / `hasUrl` | 分配 + 加密落庫（`proxyUrlEncrypted`） | allocateGostPort / createDevice / template | 裝置生命週期固定；**URL 永不離開 server**（view 只出存在性） | `deviceView.proxy.*` |

### 2.3 任務平台狀態（核實：與網絡狀態**無關聯**，唔得混）

| 欄位 | 來源 | 註 |
|---|---|---|
| `TaskRun.status` | `TaskRunService` 狀態機（`@water-army/shared` TASK_RUN_TRANSITIONS） | AI 任務（LLM provider）生命週期；**TaskDefinition 無 deviceId 欄** — 現行架構 AI 任務唔綁定 redroid 裝置 |
| `container`（docker 管理頁 `state`） | Docker daemon（containers 模組） | 與 redroid device 嘅 `containerState` 係兩碼事（docker-service vs redroid-service），命名相近但邊界清楚 |

### 2.4 前端狀態欄/badge（c48a49f 現狀）

| 位置 | 現狀 | R4 gap |
|---|---|---|
| `Devices.jsx`（list）:203-208 | containerState / adbState / gpuStatus 三個 badge（全部**有文字**） | **冇網絡狀態欄** — 加 `network.state` 文字 badge |
| `DeviceDetail.jsx` | Container / ADB / GPU 三卡 + 4-zone diagnostics；**完全冇網絡/proxy 卡** | R3 權威 payload（`device.proxy.network`）喺 UI **零可見** — 加 Network 卡：state 文字 badge（HEALTHY/VERIFYING/DEGRADED/BLOCKED/FAILED/STARTING/STALE）、checkedAt/lastSuccessAt（timeAgo）、consecutiveFailures、lastError、canary 結果、networkReady、manualIntervention、retry 按鈕 |
| `redroid-utils.js` | gpuStatusBadge / adbStateBadge / zoneBadge（全部文字+class，誠實原則） | 加 `netStateBadge(net)` — 全 7 狀態 + STALE 變體嘅**文字** badge（MD §6.3：唔單止顏色；重試中 = VERIFYING/RECOVERING 唔好沿用舊綠 badge；過期 = STALE 或按不健康） |
| UI 本地推算 | **零** — UI 純渲染 `deviceView`（useApi fetch，冇本地 state machine） | 維持：前端唔推算，只投射後端 payload |

### 2.5 Worker 狀態來源（c48a49f 現狀）

| 位置 | 現狀 | R4 gap |
|---|---|---|
| `apps/worker/src` 全目錄 | **零 redroid/device 引用**（grep 實錚）— worker 只行 AI 任務（LLM provider + Docker 管理 tools，全部經 API service token） | worker 冇途徑讀裝置網絡 fail-closed 訊號 → 網絡依賴決策冇權威依據。R4 修：加 **read-only tool `redroid.get_device_status`**（service token → `GET /api/devices/redroid/:id`），回傳 redacted 投影（`networkReady` + `network.state` + checkedAt/lastError.code），tool description 明寫「networkReady=false → 唔好派網絡任務」→ worker 側訊號 deterministic（同一 payload、同一計算） |
| 「resume/retry 策略 deterministic」 | AI 任務重試 = TaskRunService `maxAttempts` + `concurrencyKey`（與裝置無關） | 裝置網絡維度：現行**唔存在**「task 派发到裝置」queue（TaskDefinition 無 deviceId — 見 §2.3），故無可 resume 嘅 device-bound task；gate 落喺 worker 訊號層 + 任何未來 device-bound 派發必須先查 `networkReady`（寫入 tool description + audit doc 契約） |

---

## 3. 矛盾點核實（R0 baseline 列過嘅，R3 後現狀）

| R0 矛盾 | R3 後現狀 | R4 動作 |
|---|---|---|
| `refreshDevice` 唔觸 proxyState → tunnel 死咗照報 running（fail-open） | **已修**：refreshDevice 行 `healthTickDevice`（:1961-1966）；proxyState 改由 persistNet 投影 | 核實收工（有測試：redroid-net-health.test.js） |
| PROXY_STATES 無 transition 驗證 | **已修**：persistNet = assertNetTransition，非法 = reject + audit + 零寫入 | 核實收工 + 加 §6.4 重複/延遲事件測試 |
| health payload 無 timestamp/無 fail 計數/無 lastErrorCode | **已修**：net_* 13 欄 | R4 補 `checks{binary,process,interface,routePolicy,tcpCanary}` 分解（MD §6.2 概念 schema）+ `lastErrorCode` flat field — **additive**，唔斷現有消費者 |
| UI 無網絡狀態 | **未修**（R4 範圍） | §2.4 |
| worker 無 fail-closed 訊號 | **未修**（R4 範圍） | §2.5 |
| idempotency key replay 陷阱（R3 live-found）：delete 後 600s 內重用同 key → replay 返已刪裝置 view（create 200，GET 404，phantom device） | **未修**（R4 範圍） | replay 驗證 row 存在（唔存在 → invalidate key + 重新 create）+ delete 時 invalidate key（defense in depth）+ 回歸測試 |

## 4. 零 secret 契約（核實）

- `buildNetPayload` 結構性零 secret：字段全部係 machine-readable 狀態碼/時間/計數/canary 行；**冇** proxyUrl 欄位（:405-440 代碼審計）。
- `persistNet` audit details：name/from/to/reason/errorCode/source/計數 — 零 URL/credential。
- canary host/port = 管理員配置嘅**非 secret** 目標（MD §5.3「管理員設定嘅自有 canary」）；probe 輸出 = 狀態行。
- R4 新增 `netLastChecks` 持久化（checks 分解）：flat 狀態值（alive/dead/up/down/present/missing/tunnel/direct/PASS/FAIL/UNKNOWN）— 零 secret，寫入前經同一 pure 函數。

## 5. R4 改動清單（由本盤點推出）

1. **§6.2**：`netLastChecks Json?` 欄 + migration；`verifyNow` 持久化 checks 分解；`buildNetPayload` 加 `checks{binary,process,interface,routePolicy,tcpCanary}` + `lastErrorCode`（additive）。
2. **§6.3 API**：idempotency replay 驗證 + delete invalidate；audit details 補 `relatedTaskId`（device-level 事件 = null，契約完整）。
3. **§6.3 worker**：`redroid.get_device_status` read-only tool（registry + handler + api client method）— fail-closed 訊號入 worker。
4. **§6.3 UI**：`netStateBadge`（文字，全狀態+STALE）；DeviceDetail Network 卡；Devices list 網絡欄；retry 入口。
5. **§6.4 測試**：逐條加（見測試 plan）。
6. **Docs**：api-reference.md network payload 段同步（checks/lastErrorCode/STALE/networkReady）。

## 6. 解決方案落地（2026-10-20 R4 交付時補記）

| Gap | 狀態 | 落地 |
|-----|------|------|
| UI 無網絡狀態 | **已修** | `DeviceDetail` Network 卡（5 checks / timestamps / recovery lock / manual intervention / retry 入口）；`Devices` list 網絡欄；`netStateBadge`/`netCheckBadge` 全狀態文字（stale→STALE、VERIFYING=RECOVERING、fail-closed 永唔假綠）— `apps/web/src/components/redroid-utils.js` + `tests/unit/redroid-utils.test.js` |
| worker 無 fail-closed 訊號 | **已修** | `redroid.get_device_status` READONLY tool（service token → `GET /api/devices/redroid/:id`）；redacted 投影（state/stale/timestamps/consecutiveFailures/lastError.code/checks）+ deterministic `dispatch: ALLOWED\|BLOCKED`（= `networkReady`）；registry description 明寫 gate 語義 — `packages/shared/src/tool-registry.js` + `apps/worker/src/tool-helpers.js` |
| idempotency replay 陷阱 | **已修** | 雙層：(a) replay 前驗證 row 存在（唔存在 → invalidate key + fresh create）；(b) delete 時 sweep map 入面指向該 device 嘅 done entry。回歸：create→delete→同 key recreate = 201 新 id（`tests/integration/r4-state-consistency.test.js`） |
| §6.4 五條必加測試 | **已落**（6 條） | `tests/integration/r4-state-consistency.test.js`（process+canary / dns+tcp / stale / live-view fixture 對拍 / late-event+restart no-overwrite + idempotency）；`tests/unit/r4-payload-contract.test.js`（`NET_PAYLOAD_KEYS`/`NET_CHECK_KEYS` 精確 key set + 三邊界一致 + fail-closed checks） |
| api-reference.md 同步 | **已落** | `proxy.network` 完整契約（17 key + checks 5 key + 語義）、`NET_TO_LEGACY_PROXY` 投影表、`proxy/retry` 端點補錄、路由總數 68→69 實核 |
