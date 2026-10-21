# water_army API Reference（P6 最終版 — 全 endpoint 總表）

Base：`http://127.0.0.1:3012/api`（web 同源反代；api 本體唔 publish host port）。
本文檔為全 endpoint 嘅單一事實源（P1–P6 全部）；README 嘅分 phase 表係導讀。

## 全局約定

- **Auth**：session cookie（HttpOnly, SameSite=Lax；DB 只存 SHA-256）。401 = 無/壞 session；403 = 角色不足。
- **RBAC 角色階梯**：`viewer < operator < admin`（MD §13.2）。service identity（worker，`x-wa-service-token`）= operator 級、audit 可辨、**approval 端點明確拒絕**（`requireHuman`）。
- **錯誤 envelope**：所有錯誤 = `{"error":{"code","message","requestId"}}` + `X-Request-Id` header；HTTP 狀態碼見每端點列。
- **Body 驗證**：JSON Schema（`additionalProperties: false` — 未知欄位 400，防 mass-assignment）。
- **Idempotency**：建容器 / run-now / task run 支持 `idempotencyKey`（body 或 `Idempotency-Key` header）；回放 = 同結果 + `idempotent-replay: true` header（建容器）或 200（run-now）。
- **SSE 端點**：`text/event-stream`；斷線重連由 client 處理（web UI 有 backoff）；`?after=<uuid>` cursor resume（task events）。
- **Docker 錯誤分類**（`DOCKER_ERROR`）：`CONTAINER_NOT_FOUND`→404／`IMAGE_NOT_FOUND`→404（缺 image reference — 404 係 **image** 嘅，非 container；R5 live 修正：dockerode 合成訊息 "(HTTP code 404) no such container - No such image: <ref>" 會誤導，分級優先於 container-404，message 清理做 `Image not found: <ref>`）／`DOCKER_DAEMON_UNAVAILABLE`→503／`DOCKER_PERMISSION_DENIED`→502／`DOCKER_TIMEOUT`→504／`DOCKER_DISABLED`→503／`OPERATION_PENDING`→503／其餘 `DOCKER_ERROR`→502。
- **通用錯誤碼**：`VALIDATION_ERROR` 400／`NOT_FOUND` 404／`NOT_MANAGED` 403（managed gate）／`NAME_TAKEN` 409／`IN_USE` 409（template 使用中）／`RATE_LIMITED` 429／`INTERNAL` 500。

## Health（無 auth）

| Method | Path | 參數 | 錯誤碼 / 備註 |
|--------|------|------|--------------|
| GET | `/health/live` | — | 恒 200（process 存活） |
| GET | `/health/ready` | — | 200（db/redis 都活）；docker down = 200 degraded（`dependencies.docker.available:false`）；db 或 redis down = **503** + `dependencies.*.error` |

## Auth

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| POST | `/auth/login` | — | body `{username (3–32, `[a-zA-Z0-9_.-]`), password}` | 200 + `Set-Cookie`；401 `INVALID_CREDENTIALS`（未知用户同一 message — timing 對齊防枚舉）；429 `RATE_LIMITED`（5 失敗/60s/**客戶端 IP × 帳號**，per-account，限流中連正確密碼都 429）；400 驗證 |
| POST | `/auth/logout` | 任何 | — | 204；session 即刻失效 |
| GET | `/auth/me` | 任何 | — | 200 `{user:{id,username,role,lastLoginAt}}`；401 |

## Containers（P2）+ managed exceptions（P3）

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/containers` | viewer+ | query `state`（docker state 過濾）、`managed`（`true` = label **OR** admin exception — P6 flag#1 統一口徑）、`q`（name 子串）、`withStats`（逐容器 CPU/mem；單項失敗 = `—` 唔拖慢整頁）、`page`/`pageSize` | 200 `{items,total,...}`；daemon down → 503 `DOCKER_DAEMON_UNAVAILABLE` |
| GET | `/containers/:id` | viewer+ | `:id` = name 或 id | 200 inspect 摘要（state/ports/mounts/labels/env **server-side masked** + `managed`/`managedByException`）；404 `CONTAINER_NOT_FOUND` |
| GET | `/containers/:id/logs` | viewer+ | query `tail`（行數）、`since`（epoch ms） | 200 demux 後 log；404 |
| GET | `/containers/:id/stats` | viewer+ | — | 200 單次快照；404 |
| GET | `/containers/events` | viewer+ | SSE（無 query） | `container` 事件白名單（start/stop/kill/die/pause/unpause/restart/rename/create/delete/update）；斷線自動 release slot；並行上限 → 503 `SSE_LIMIT`；daemon down → 503 |
| POST | `/containers/:id/start` `<stop>` `<restart>` `<pause>` `<unpause>` | operator+ | `:id` | 冪等狀態機（MD §9.3）：目標態已達 = 200 `idempotent:true`；op 後再 inspect 確認；卡住 = 503 `OPERATION_PENDING`；403 `NOT_MANAGED`（gate = label OR exception）；404；502/504 Docker 錯誤 |
| DELETE | `/containers/:id` | **admin** | body `{confirm（逐字 repeat name/id）, removeVolumes?, force?}` | 204；confirm 唔匹配 = 400；403 `NOT_MANAGED`；404；默认保留 bind mount |
| GET | `/containers/exceptions` | **admin** | — | 200 `{exceptions:[{key, containerId?, name?, note, grantedAt, grantedBy}]}` |
| POST | `/containers/exceptions` | **admin** | body `{containerId?, name?, note?}`（至少一個） | 201；兩者皆無 = 400；name 對唔到 daemon = 純 name grant（audit 註明）；404（containerId 唔存在） |
| DELETE | `/containers/exceptions/:key` | **admin** | `:key` | 204；404（key 唔存在） |
| GET | `/templates` | viewer+ | — | 200 容器 template allowlist（`{templates}`） |
| POST | `/templates` | **admin** | body `{name, image（必 pin tag/digest）, ports?, envWhitelist?, privileged?, privilegedReason?}` | 201；409 `NAME_TAKEN`；privileged 要 reason（10–200 字）；400。P2–P6 無 template 修改/刪除端點（改 = DB 層手動 + audit 紀律，見已知限制） |
| POST | `/containers`（由 template 建） | operator+ | body `{templateId, displayName, idempotencyKey, env}` — env 只准 whitelist key；**唔接收任何 Docker payload** | 201（回放 = 201 + `idempotent-replay: true`）；400（env key 唔喺 whitelist / 未知欄位）；404 template；409 `NAME_TAKEN` |

## AI Tasks / Approvals / Tools / Providers（P3）

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| POST | `/tasks/runs` | operator+ | body `{prompt, provider?, title?, tools?, timeoutMs?, maxAttempts?, idempotencyKey?}` | 202 `{taskRun}`；provider 預設 = env `AI_PROVIDER`（`mock` = 內置可編排 mock）；400 驗證；409 冪等回放（同 key 不同 body） |
| GET | `/tasks/runs` | viewer+ | query `status`、`provider`、`page`/`pageSize` | 200 `{items,total}` |
| GET | `/tasks/runs/:runId` | viewer+ | `:runId` | 200 run + 全事件流 + approvals（**arguments 讀時 scrub** — P6：任何 legacy 行都唔會洩）；404 |
| GET | `/tasks/runs/:runId/events` | viewer+ | SSE；`?after=<eventUuid>` cursor resume；heartbeat 25s；terminal 後 `done` 再 close | 400 非法 cursor（唔係 500）；404 |
| POST | `/tasks/runs/:runId/cancel` | operator+ | — | 200；真停（`cancel_requested` + 移除 waiting job；in-flight 靠 DB poll + AbortSignal；cancel 後零 output/零事件）；冪等；404 |
| POST | `/tasks/runs/:runId/retry` | operator+ | — | 202 新 attempt（**terminal-only**：`failed/timed_out/cancelled/skipped` 之外 409）；舊輸出/事件保留 |
| GET | `/tasks/definitions` | viewer+ | — | 200 task definition 只讀 list（Schedules UI 用） |
| GET | `/approvals` | viewer+ | query `status=pending\|approved\|rejected\|expired\|all`、`runId` | 200 `{items}`（arguments 已 scrub） |
| POST | `/approvals/:id/approve` | **admin 真人** | body `{note?}` | 200；**service identity = 403**（AI 唔可能自批）；404；409（已終態） |
| POST | `/approvals/:id/reject` | **admin 真人** | body `{note?}` | 同上 |
| GET | `/tools` | viewer+ | — | 200 registry 元數據（name/description/safetyClass/args schema） |
| GET | `/providers` | **admin** | — | 200 列表（**零 key 材料** — 只 `hasApiKey:boolean`；P6 實打證據 `docs/evidence/p6-security/`） |
| POST | `/providers` | **admin** | body `{name, providerType, baseUrl, modelId, apiKey?, timeoutMs?, isEnabled?}` | 201（key AES-256-GCM 加密落庫；key 永不傳回）；400 `BLOCKED_URL`（SSRF guard：private/loopback/link-local/169.254.169.254 metadata/CGNAT/保留 host 名/DNS 解出私有地址） |
| PATCH | `/providers/:name` | **admin** | body（部分更新；`apiKey` 再傳 = 重新加密輪替） | 200；400 `BLOCKED_URL`（改 baseUrl 時同 POST 同 guard）；404 |
| POST | `/providers/:name/test` | **admin** | — | 200/502 classified provider error 詞彙（timeout/auth/network/model 分類，message 已 redact） |
| GET | `/audit-events` | **admin** | query `from`/`to`（ISO 日期）、`action`、`actor`（user id）、`page`/`pageSize`（≤100） | 200 `{items（details scrub 過）,page,pageSize,total}` |

## Schedules（P4）

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| POST | `/schedules` | operator+ | body `{name, taskDefinitionId, scheduleType: cron\|interval\|once, cronExpression?, timezone?, intervalMs?, runAt?, overlapPolicy?: skip_if_running\|queue, concurrencyKey?}` | 201 `{schedule}`；**PG 先行**（DB row 先落，BullMQ 後同步；同步失敗 = row 照存 + `syncStatus=sync_error`）；400 壞 cron/tz；404 definition |
| GET | `/schedules` | viewer+ | query `enabled`、`page`/`pageSize` | 200（含 `nextRunAt/lastRunAt/lastStatus/syncStatus/delay`） |
| GET | `/schedules/:id` | viewer+ | — | 200；404 |
| PATCH | `/schedules/:id` | operator+ | body（同 create 部分欄位） | 200（stable key 原地 upsert，零重複；once 改 `runAt` = 換 delayed job）；400/404 |
| POST | `/schedules/:id/pause` | operator+ | — | 200（移除 BullMQ 索引；DB row 保留）；冪等；404 |
| POST | `/schedules/:id/resume` | operator+ | — | 200（重同步 + 重算 next_run_at）；冪等；404 |
| POST | `/schedules/:id/run-now` | operator+ | header `Idempotency-Key?` | 202 新 run / 200 replay（無 key = 每次新 run）；404 |
| POST | `/schedules/:id/sync` | operator+ | — | 200（`sync_error`→`synced`）；503 redis 未復（誠實，唔假成功）；404 |
| DELETE | `/schedules/:id` | operator+ | — | 204（BullMQ 索引 + pending once job 先清；`task_runs` lineage 保留 — `schedule_id` 無 FK 屬設計）；404 |
| POST | `/schedules/preview` | viewer+ | body `{cronExpression, timezone?}` | 200 next 5 次 + 人類描述（cron-parser 純計算，同 BullMQ 同庫）；400 |

**執行拓撲**：PostgreSQL = 唯一 source of truth；BullMQ Job Scheduler = derived index（worker boot + 每 5 分鐘 reconcile）。fire = 重讀 DB → guard（deleted/disabled/stale）→ 冪等建 run（`sched-<uuid>-<slotMs>`）→ overlap policy → 推進 `next_run_at`。

## Schedule Notifications（P6 flag#3）

worker 喺 terminal scheduled run（succeeded/failed/timed_out/skipped，**包括 overlap skip**）寫入一行通知。

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/schedule-notifications/unread-count` | viewer+ | — | 200 `{count}`（topbar bell poll 呢個，30s） |
| GET | `/schedule-notifications` | viewer+ | query `unreadOnly=true\|false`、`limit`（1–100，default 20） | 200 `{items}`（newest first；`scheduleId/runId/title/message/createdAt/isRead`） |
| POST | `/schedule-notifications/read-all` | operator+ | — | 200 `{marked}`（mark-read 係寫 → viewer 唔可以） |
| POST | `/schedule-notifications/:id/read` | operator+ | `:id`（≤64 字） | 200 `{id,isRead:true}`；404 |

## Redroid Devices / Templates / Preflight（P5）

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/redroid/preflight` | viewer+ | query `gpu`（`true`/`false`）／`port`（1–65535）／`image`（pinned ref，R5 架構檢查）— 全部可選 | 200 真主機檢查（kernel modules/device nodes/dmesg/docker/data root）；三態 `supported\|unsupported\|unknown`（讀唔到 = unknown，嚴禁假報）。**api 容器視角**：host `/dev` 狀態 = `unknown`（永唔假報 absent）；**host-level preflight 係權威**（runbook §9.3） |
| GET | `/redroid/templates` | viewer+ | — | 200（image 必 pin；`privileged` 行帶 reason）；無 `:id` 只讀端點（list 已含全欄位） |
| POST | `/redroid/templates` | **admin** | body `{name, image, androidVersion（必）, width?/height?/dpi?/fps?/gpuMode?（schema default），privileged?, privilegedReason?, isEnabled?, cpuLimit?（number\|null，>0–256），memoryLimitBytes?（int\|null，1–256 GiB），proxyUrl?}` | 201；image `latest`/`nightly`/untagged 拒（400）；privileged 要 reason；409 name；`proxyUrl` = fleet 出口（`socks5://[user:pass@]host:port` only，加密落庫，view 永不回傳 URL，只出 `proxy.configured/hasUrl`） |
| PUT | `/redroid/templates/:id` | **admin** | body = **partial update**（≥1 欄；schema **無 `default:`** — absent 就 absent，R5 clobber 修復；repo 級守門 `tests/unit/patch-default-guard.test.js` 防復發） | 200 `{template}`/404/400/409 `IN_USE` |
| DELETE | `/redroid/templates/:id` | **admin** | — | 200 `{deleted, name}`；409 `IN_USE`；404 |
| POST | `/devices/redroid` | operator+ | body `{name, templateName, idempotencyKey, overrides?{width?,height?,dpi?,fps?}, proxyUrl?}` — **body 冇任何 Docker 欄位**（注入 = 400） | 201 `{device, replay, startError?, preflight?}`（回放 = 200）；404 template/disabled；409 name；port 用盡 = 503；缺 image = 404 `IMAGE_NOT_FOUND`；`proxyUrl` = device 級出口 override（省略 = 跟 template；加密落庫，view 只出 `hasUrl/gostPort/proxyState/network`，永不回傳 URL） |
| GET | `/devices/redroid` | viewer+ | query `template`（過濾） | 200 `{devices}` |
| GET | `/devices/redroid/:id` | viewer+ | — | 200 `{device}`（pinned image/`127.0.0.1:<port>`/容器狀態/ADB 狀態/解析度/GPU 健康/`dataDir`（device host data 目錄路徑 — delete `removeData` 嘅 realpath-scoped rm 範圍）/`proxy`（`configured/gostPort/gostBind/state/hasUrl/containerName/binaryState/binaryVersion/network` — URL 永不回傳；`binaryState` = `missing\|ready\|invalid\|error\|null`，R1 pre-provision check 診斷，fail-closed：missing/invalid 時 proxy 絕非 `running`；`network` = **權威網絡健康狀態**，見下「網絡健康狀態契約」；無 proxy 綁定時 `network: null`））；404 |
| POST | `/devices/redroid/:id/start` `<stop>` `<restart>` | operator+ | — | 200 `{device, idempotent, action}`（P2 action protocol；container 消失 = `missing` + 409 誠實）；404 |
| POST | `/devices/redroid/:id/refresh` | operator+ | — | 200 `{device, adbNote, adbError, network}`（重查 daemon + ADB 狀態，唔重跑全套診斷）；`adbError` = engine 級失敗碼（`ADB_UNAVAILABLE`/`ADB_TIMEOUT`）— engine 跑唔到時 `device.adbState='unknown'`（永唔假報 offline） |
| POST | `/devices/redroid/:id/diagnostics` | operator+ | — | 200 **5 個獨立結果區**（kernel / container-logs / adb-connectivity / gpu-verification / network），每區 `executed` + `status`（未執行 = `未驗證`，從無假 pass）；adb 區 `status` ∈ `online\|offline\|error\|unverified` — engine 失敗 = `error` + `error` 碼（`ADB_UNAVAILABLE`/`ADB_TIMEOUT`，**唔係** device offline）；**recreate-stall signature**（container running + 曾確認 online + 而家 adbd 靜音）= `suspectedHostProtocolStall:true` + `hint`（runbook §10.7，product 刻意唔自動 recovery） |
| POST | `/devices/redroid/:id/proxy/retry` | operator+ | — | 200 `{device, network}`（R3 手工介入觸發：FAILED / stuck DEGRADED\|BLOCKED → 重設 episode + 強制 recovery attempt；attempt 仍然落 VERIFYING + canary 才可能返 HEALTHY — **從無盲信 HEALTHY**）；無 proxy 綁定 = 409 `REDROID_NO_PROXY`；404 |
| GET | `/devices/redroid/:id/logcat` | operator+ | query `tail`（正整數字串；server clamp 到 `REDROID_LOGCAT_TAIL_MAX`） | 200（server 永遠加 `-d -t <n>`；`truncated`（byte cap）+ `mayHaveMore`）；404 |
| DELETE | `/devices/redroid/:id` | **admin** | body `{confirm（type name）, removeData?}` | 200 `{deleted, name, containerRemoved, removeData, dataRemoved, dataRemoveErrorCode?, dataRemoveError?, containerError?, proxyTornDown?, gostRemoved?}`；confirm 唔匹配 = 400；`removeData=true` 先 rm data dir（realpath-scoped）；container 先除、data 預設保留；**data 清除失敗 = 部分失敗**（delete 本身已成功）→ 照 200 + `dataRemoved:false` + 穩定碼（`DATA_DIR_PERM_DENIED` = root-owned dir 已知形狀 R5／`DATA_DIR_REMOVAL_FAILED`／`DATA_DIR_REFUSED` = 安全拒決）；404 |

**安全鐵律**：無 `POST /exec` 端點（任意命令 = 404）；冇 `shell: true`；ADB binary 固定路徑；ADB 5555 只綁 `127.0.0.1`（PortBindings host IP 硬編 + server 端 port 範圍驗證）。

### 網絡健康狀態契約（R3 state machine + R4 邊界統一，MD §5/§6）

`proxy.network` = **唯一權威**網絡健康投射（`redroid-health.js` 純 state machine + watchdog 計算，`net_*` DB 持久化，API restart 後還原）。**API / worker / UI 三個邊界全部讀呢個 schema**（`NET_PAYLOAD_KEYS`/`NET_CHECK_KEYS` 喺 `redroid-health.js` 定死，drift = test 爆）；任何邊界唔准自行推算狀態。

```
proxy.network = null（無 proxy 綁定）或：
{
  state: 'STOPPED'|'STARTING'|'VERIFYING'|'HEALTHY'|'DEGRADED'|'BLOCKED'|'FAILED',  // 唯一合法值；非法值 → STOPPED（fail-closed）
  stateSince: ISO8601|null,        // 進入當前 state 嘅時間
  checkedAt: ISO8601|null,         // 上次完整 verify 時間（stale 判定依據）
  lastSuccessAt: ISO8601|null,     // ≙ MD lastSuccessfulCheckAt；上次 canary PASS 時間
  consecutiveFailures: int,        // 連續 verify 失敗計數（PASS → 0）
  recoveries: int,                 // 累計 recovery attempt 數
  manualIntervention: bool,        // terminal FAILED（stall/recovery exhausted）→ 要人手
  canaryConfigured: bool,          // false = data plane 不可驗證 = 永唔可以 HEALTHY（fail-closed）
  stale: bool,                     // HEALTHY 但 checkedAt 過期（> REDROID_HEALTH_STALE_MS，default 60s）→ 按唔健康處理
  networkReady: bool,              // **consumer gate**：HEALTHY && !stale && consecutiveFailures===0 → 先派網絡任務 / UI 綠
  checks: { binary, process, interface, routePolicy, tcpCanary },  // 固定 5 key；每值 ∈ PASS|FAIL|UNKNOWN（fail-closed：讀唔到/SKIPPED = UNKNOWN，永唔假 PASS）
  lastErrorCode: string|null,      // 機器可讀碼（NET_ERRORS 詞彙：TUNNEL_PROCESS_DEAD / TUNNEL_IFACE_MISSING / CANARY_FAIL / CANARY_TIMEOUT / STALL_REPROVISION_USELESS / RECOVERY_EXHAUSTED / CONTAINER_NOT_RUNNING …）
  nextRecoveryAt: ISO8601|null,    // backoff 錨（下次自動 recovery attempt 時間；null = 唔喺 backoff 期）
  recoveryLock: { held: bool, until: ISO8601 } | null,  // single-flight recovery lease 摘要（owner id 係 process-internal，唔暴露）
  lastError: { code, detail, at } | null,   // detail = 診斷摘要（canary reason 等）；**零 proxy URI / credential**
  lastCanary: { result:'PASS', latencyMs, nonce } | { result:'FAIL'|'ERROR', reason } | null,
}
```

**狀態更新規則**：後端（watchdog verify + recovery policy）= 唯一寫入者；HEALTHY 唯一入口 = VERIFYING + 新 canary PASS（transition table 冇直達 HEALTHY 嘅邊；非法轉移 = 拒 + `net_transition_refused` audit）。每次轉移審計：`deviceId`（resourceId）/ 前狀態 / 新狀態 / 原因 / 時間 / 觸發來源（watchdog|manual|provision）/ `relatedTaskId`（device 級網絡事件 = null）。legacy `proxy.state`（`off|provisioning|running|stopped|error`）= R3 state 嘅**保守投影**（`NET_TO_LEGACY_PROXY`：HEALTHY→running；DEGRADED→stopped；BLOCKED/FAILED→error；STOPPED→stopped；STARTING/VERIFYING→provisioning），唔准反向推算。Worker 網絡任務 gate：`networkReady === true` 先派（`redroid.get_device_status` 工具返 deterministic `dispatch: ALLOWED|BLOCKED`）；UI：所有狀態帶**文字**（STALE/RECOVERING 語義，唔跟颜色），過期 = STALE。

### Redroid 錯誤碼契約（MD §8.3：穩定 machine-readable、單一詞彙）

所有啟動／健康檢查／生命週期錯誤用**同一套**穩定 machine-readable 碼（`NET_ERRORS` / preflight item id / `DOCKER_ERROR` 同一詞彙風格），**無第二套系統**。MD 示例碼 → 實際 surface 對照：

| 實際碼 | HTTP / 位置 | 意義（MD 示例碼對照） |
|--------|-------------|----------------------|
| `IMAGE_NOT_FOUND` | 404 create/pull | 缺 image reference（404 係 image 嘅，非 container；R5 live 修正） |
| `BINARY_MISSING` | 500 provision | device 內 tun2socks binary 缺失（fail-closed：proxy 絕非 `running`） |
| `BINARY_INVALID` / `BINARY_CHECK_ERROR` | 500 provision | binary 存在但檢查失敗 / 檢查本身跑唔到（seam） |
| `REDROID_TUNNEL_PROVISION_FAILED` | 500 provision | tunnel script stage/run 失敗（MD `TUNNEL_START_FAILED` 嘅 api-code 面） |
| `TUNNEL_SETUP_FAILED` | 持久 `netLastErrorCode` | in-device tunnel script stage/run 失敗（R6：以前被引用但**無定義** → `netLastErrorCode` 靜默丟失，已修） |
| `REDROID_TUNNEL_BOOT_TIMEOUT` | 504 provision | `boot_completed` 未在時限內出現（default **40min**，R6 由 10min 校準 — 真 cold/recreate boot 實測 ~24min；knob `REDROID_TUNNEL_BOOT_TIMEOUT_MS`） |
| `TUNNEL_START_TIMEOUT` | 持久 `netLastErrorCode` | boot 超時（net state machine 面） |
| `TUNNEL_IFACE_MISSING` / `TUNNEL_IFACE_DOWN` / `TUNNEL_ROUTE_UNCERTAIN` | 持久 `netLastErrorCode` | tun0 缺失 / 唔 UP / 路由策略失守（MD `INTERFACE_MISSING` 族） |
| `CANARY_FAIL` / `CANARY_TIMEOUT` | `checks.tcpCanary` + `netLastErrorCode` | data plane canary 失敗 / 超時（MD `DATA_PLANE_CHECK_FAILED` 嘅機器可讀形） |
| `ADB_UNAVAILABLE` / `ADB_TIMEOUT` | refresh `adbError` / diagnostics adb 區 `error`（HTTP 200 欄位） | adb **engine** 本身跑唔到（binary 缺失/spawn 失敗）/ 超時 — **唔係** device offline（`adbState` 誠實報 `unknown`） |
| `DATA_DIR_PERM_DENIED` / `DATA_DIR_REMOVAL_FAILED` / `DATA_DIR_REFUSED` | DELETE `dataRemoveErrorCode`（HTTP 200 欄位） | data dir 清除：權限失敗（root-owned dir，R5 實測形狀）／其他失敗／安全拒決（path 越界/symlink escape/非目錄） |
| preflight item `id` + `status:'FAIL'` | preflight / diagnostics kernel 區 | host 先決條件缺失（MD `HOST_PREREQUISITE_MISSING` = item id 詞彙：binder module、device nodes、docker、data root…） |
| `network.stale: true` | `proxy.network` 欄位 | 健康檢查過期（MD `HEALTHCHECK_STALE` — 穩定**布林欄位**，非獨立錯誤碼：佢係狀態投影，唔係事件） |

**錯誤回應鐵律（§8.3）**：error message 永遠唔包含內部憑證、完整 proxy URL、宿主機敏感路徑以外嘅秘密；host path（data dir、log path）允許出現。上表碼全部喺 `redroid-service.js`（`fail(...)`）／`redroid-health.js`（`NET_ERRORS`）／`docker-service.js`（`classifyDockerError`）定死，測試用詞彙斷言鎖定（drift = test 爆）。

## Dashboard（P6）

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/dashboard/summary` | viewer+ | — | 200：`containers`（managed fleet 計數 — 同 list/gate 同一條 label-OR-exception 規則；Docker down = `{available:false}` 降級，**唔會 500**）/ `taskRuns`（active 現況、24h failed/succeeded、5 條最近失敗）/ `schedules`（total+enabled）/ `notifications`（unread）。Dashboard 所有數字來自呢個端點（MD §6.1：零硬編碼） |

## Batch Rotation 監控／匯出（BR-B5 — MD Phase 5 lane B）

只讀監控 + 報告匯出面。batch 控制路由（`POST /api/batches`、`/preview`、`/:id/start|pause|resume|cancel`、task-run retry/cancel/logs）屬 **BR-B2**，未落 main 前無效（本檔案只註冊 read/monitor/report；literal-segment 路由與 B2 嘅 `/api/batches/:id` 由 find-my-way static-segment 排序安全共存）。

**零秘密鐵律**：所有 response 係 allow-list 投影（非 DB row 透傳）+ `scrubObject`/`maskCredentialShapedValues` 雙重遮罩；identity `metadata`、task `error`、report 匯出體（JSON/CSV）全部經硬門 — 任何 credential 形狀值漏過 = 500 `REPORT_SECRET_TRIP`（fail-closed，寧可唔出報告都唔出秘密）。

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/api/identities` | viewer+ | `status`（11-state FSM）/ `q`（name/ref/id）/ `page` / `pageSize` | 200 `{items, total, page, pageSize}`；item = allow-list 投影（state、dataDir 路徑、lastTask/lastError 遮罩摘要、health 摘要）— **無 credential 欄** |
| GET | `/api/identities/:id` | viewer+ | — | 200 詳情：stable ID、data dir 狀態、container 對應（Docker label 反查）、最近 runs/memberships、`metadata`（scrub + 截斷）；404 `IDENTITY_NOT_FOUND` |
| GET | `/api/batch-monitor/summary` | viewer+ | — | 200：current batch + cycle 進度、global/cycle 計數（active/queued/completed/failed/skipped）、containers + 容量上限、host（CPU/RAM/磁碟，探測失敗 = `null` 降級，**唔會 500**）、deps（db/redis/docker/network-policy 健康）、alerts（critical 先）、task 表（≤200，error 遮罩） |
| GET | `/api/batches/metrics` | viewer+ | — | 200：MD §13 全部 14 metric（`batch_active_count` … `network_health_failures_total`）+ 計算細節（start durations、heartbeat age）+ alerts；Docker down = `containers: null` 降級 |
| GET | `/api/batch-reports` | viewer+ | `page` / `pageSize` | 200 cycle 列表（UUID、batch 數、計數、時間範圍、`exportable` flag） |
| GET | `/api/batch-reports/:cycleId` | **operator+** | `format=json\|csv`（header 或 query `?format=`） | 200 匯出體（attachment）：各 identity 終態、成功/失敗/跳過統計、嘗試次數、失敗原因（遮罩）、資源峰值、時間範圍 + audit event（`batch_report_export`）；404 `CYCLE_NOT_FOUND`、409 `CYCLE_NOT_COMPLETE`、500 `REPORT_SECRET_TRIP`（secret 硬門觸發） |

**Alert 落地（MD §13）**：無獨立 alert channel（repo 無既有機制）→ 可查詢狀態（`/api/batches/metrics` + summary 嘅 `alerts[]`：severity/code/message/detail/fingerprint/firstSeen）+ pino（critical = `error`、其餘 = `warn`）+ audit event（每 alert 首次 fire 寫 `batch_alert_raised`；恢復寫 `batch_alert_cleared`；同 fingerprint 每小時最多 re-audit 一次）。條件：active 超 `batch.global_max_active_containers`、worker 無心跳（`worker_heartbeat_age_seconds` 超時）、DB/Redis 不可用、磁碟低、連續容器啟動失敗、task 持續 UNKNOWN、無 label 孤兒 managed 容器、network policy 不可用。

## 端點總計

**75 條路由**（逐檔案計；BR-B5 實核 2026-10-21）：health 2 + auth 3 + containers 15（含 5 個 action + exceptions 3 條 + create-from-template）+ container templates 2 + dashboard 1 + tasks 15（runs 6 + approvals 3 + tools 1 + providers 4 + audit 1）+ task definitions 1 + schedules 10（含 POST preview）+ schedule notifications 4 + redroid templates/preflight 5 + redroid devices 11（含 3 個 action + proxy/retry）+ **batch monitor 6（BR-B5：identities 2 + monitor summary + metrics + reports 2）**。所有寫操作（POST/PATCH/PUT/DELETE，`/auth/login` 除外）：RBAC + audit row（actor、request_id、IP、status、details scrub）+ Origin 檢查（browser mutating 請求）。
