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

- **Rate limit 總表**：login 5 失敗/60s/（客戶端 IP × 帳號）；**P5（MD §11.9）**：stream create + reconnect **10/min/user**、intervention create **30/min/user**（per-user sliding window，preHandler 喺 RBAC 之後 — 401/403 唔燒 budget；system signal 路徑唔經 route、唔會被限）→ `429 RATE_LIMITED` + `Retry-After`；sidecar 輸入 **30/s/session**（token bucket，超額 = `STREAM_INPUT_RATE_LIMITED` frame，唔斷流）。

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

## Manual Interventions（P4-MC 人工介入事件，MD Phase 4）

狀態機 `open → acknowledged → in_progress → resolved | dismissed`（reopen: terminal → open，必帶 note）；去重 key = `device::category::source`（open episode 部分 unique index）；重複 signal = `signalCount++` + `signal` history，**唔新建**（MD §6.3）。evidence 全部**寫入前**經 scrub（key-based + URL-userinfo value-based，MD §6.2/§13 零 secrets）。RBAC：viewer 唯讀，operator/admin 可 action；`external_verification` 事件**禁 dismiss**（409 `DISMISS_NOT_ALLOWED`，MD §0.6）。所有 transition 寫 `audit_events` + `ManualInterventionHistory`。

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/manual-interventions/needs-attention-count` | viewer+ | — | 200 `{count, bySeverity}`（topbar badge，30s poll） |
| GET | `/manual-interventions` | viewer+ | query `status/category/severity/deviceId/source/disposition`、`page/pageSize` | 200 `{items,total,page,pageSize}`（newest first；evidence 已 scrub；`disposition=blocked_pending_review` 可過篩） |
| POST | `/manual-interventions` | operator+ | body `{source: operator_report, category, title, deviceId?, severity?, disposition?, evidence?}` | 201 `{intervention, created:true}`；重複 = 200 `{created:false, signalCount}`；400 `NOTE_REQUIRED`（note 空）/ `VALIDATION_ERROR`；404 裝置 |
| GET | `/manual-interventions/:id` | viewer+ | — | 200（含 `history[]` timeline + signalCount）；404 |
| POST | `/manual-interventions/:id/acknowledge` | operator+ | — | 200（open→acknowledged）；409 `INVALID_TRANSITION` |
| POST | `/manual-interventions/:id/assign` | operator+ | body `{assigneeUserId? (UUID), note?}` | 200（→in_progress + assignee；預設 = 請求者）；409 |
| POST | `/manual-interventions/:id/resolve` | operator+ | body `{note}`（必填） | 200（→resolved + resolvedAt）；400 `NOTE_REQUIRED`；409 |
| POST | `/manual-interventions/:id/dismiss` | operator+ | body `{reason}`（必填） | 200（→dismissed）；**`external_verification` = 409 `DISMISS_NOT_ALLOWED`**（須人工 review 後 resolve）；409 |
| POST | `/manual-interventions/:id/reopen` | operator+ | body `{note}`（必填） | 200（terminal→open）；400/409 |

**生產 signal 路徑**（無 HTTP 入口，由 redroid service 內調用，均經 `recordSignal` 冪等 + scrub + audit）：`network` R3 狀態機 BLOCKED/FAILED（`persistNet`）、`adb_offline`（`refreshDevice` online→offline 轉換，只觸一次）、`boot_timeout`（tunnel boot 超時）、`container_offline`。

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
| `RAM_GATE_DENIED` | **409** device create/start；**503** batch start（retryable → worker RETRY_WAIT，pending 保留） | RAM-G1 准入 gate 拒絕 boot（fail-closed）：message 帶穩定 reason（`MAX_PARALLEL`／`BELOW_HARD_FLOOR`／`PROJECTED_BELOW_TARGET`／`METRICS_UNAVAILABLE`／`METRICS_STALE`／`STORE_UNAVAILABLE`／`CONFIG_INVALID`／`INVALID_INPUT`）+ current/projected MiB；`details` 帶 `{reason, currentMiB, projectedMiB, liveCount}`；拒絕 = **零副作用**（未建 container/未燒 port/未碰數據）；設計 `docs/ram-gate.md`，證據 `docs/audits/ramgate-scenarios.md` + `ramgate-g2-report.md` |
| `RAM_GATE_UNAVAILABLE` | 503 create/start/batch start | gate 無法構造（hermetic fake 無 Redis `eval`；生產不會出現 — 除非真 ioredis）；見「System — RAM 准入 Gate」節 |
| preflight item `id` + `status:'FAIL'` | preflight / diagnostics kernel 區 | host 先決條件缺失（MD `HOST_PREREQUISITE_MISSING` = item id 詞彙：binder module、device nodes、docker、data root…） |
| `network.stale: true` | `proxy.network` 欄位 | 健康檢查過期（MD `HEALTHCHECK_STALE` — 穩定**布林欄位**，非獨立錯誤碼：佢係狀態投影，唔係事件） |

**錯誤回應鐵律（§8.3）**：error message 永遠唔包含內部憑證、完整 proxy URL、宿主機敏感路徑以外嘅秘密；host path（data dir、log path）允許出現。上表碼全部喺 `redroid-service.js`（`fail(...)`）／`redroid-health.js`（`NET_ERRORS`）／`docker-service.js`（`classifyDockerError`）定死，測試用詞彙斷言鎖定（drift = test 爆）。

## System — RAM 准入 Gate（RAM-G1 — admin only）

Host-RAM 准入 gate：所有 boot 路徑（device create/start、batch start）經同一個原子、fail-closed 決策（數學/lease/恢復語義 = `docs/ram-gate.md` 單一事实源）。拒絕海面 = `409`（device）／`503`（batch，retryable）`RAM_GATE_DENIED`，見上錯誤碼契約。

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/system/ram-gate` | **admin** | — | 200：`enabled`／有效 `config`／`metrics`（fresh sample + age + `stale` flag）／`counts`（`liveLeases`/`running`/`inProgress`/`reservedMiB`）／`wouldAdmitNext`（`{admitted, reason, projectedMiB}`，dry-run 零副作用）／`store.redis` |
| GET | `/system/ram-gate/decisions` | **admin** | query `limit`（≤30 建議） | 200 決策軌跡（admit/deny/release/recover，帶 reason、current/projected MiB、source；ring buffer 300） |
| PUT | `/system/ram-gate/config` | **admin** | body = partial（`maxParallel`/`hardFloorMiB`/`postBootTargetMiB`/`perBootBudgetMiB`/`metricsMaxAgeMs`/`leaseTtlMs`/`enabled`） | 200（驗證 + partial merge 入 AppSetting `ram_gate.config`，audited）；非法值 400（fail-closed：生效 config 非法 = 全 DENY `CONFIG_INVALID`，唔會默默用默認值）；env `RAM_GATE_*` 優先於 AppSetting |
| POST | `/system/ram-gate/reconcile` | **admin** | — | 200 `{released, renewed, recovered, errors}`（強制對帳：殭屍 lease 釋放 / live 續期 / redis 清空後補回 — 自動每 5 分鐘都會跑） |

**配置優先級**（每決策 live 重讀）：env `RAM_GATE_*` > AppSetting `ram_gate.config` > 默認 constants（maxParallel 10 / hardFloor 16384 MiB / target 18432 MiB / budget 1200 MiB / metrics maxAge 30s / lease TTL 24h）。`RAM_GATE_ENABLED=false` = 明示 bypass（決策標 `GATE_DISABLED`，只作 dev/test 逃生口）。**底線**：拒絕只 stop 新 boot；永不刪 dataDir／永不殺其他容器／永不碰 SGLang。

## Dashboard（P6）

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/dashboard/summary` | viewer+ | — | 200：`containers`（managed fleet 計數 — 同 list/gate 同一條 label-OR-exception 規則；Docker down = `{available:false}` 降級，**唔會 500**）/ `taskRuns`（active 現況、24h failed/succeeded、5 條最近失敗）/ `schedules`（total+enabled）/ `notifications`（unread）。Dashboard 所有數字來自呢個端點（MD §6.1：零硬編碼） |

## Batch Rotation 監控／匯出（BR-B5 — MD Phase 5 lane B）

只讀監控 + 報告匯出面。batch 控制路由（`POST /api/batches`、`/preview`、`/:id/start|pause|resume|cancel`、task-run retry/cancel/logs、container 生命週期）見下面嘅 **Batch Rotation 控制（BR-B2）** 節。literal-segment 路由（`/api/batches/capacity`）與 dynamic `/api/batches/:id` 由 find-my-way static-segment 排序安全共存。

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

## Batch Rotation 控制（BR-B2 — MD Phase 2–4 lane A/C）

**Cycle 契約（preview parity，2026-10-22 B6 修復）**：`POST /api/batches/preview` 係唯一容忍 unknown identity id 嘅 surface（報告而唔拒絕）；`POST /api/batches`（strict write path）對 unknown id 一律 400 `VALIDATION_ERROR`。兩者都用 identity **實際 status** 做計劃：DISABLED / terminal 嘅 identity 喺 plan 時就係 `SKIPPED` membership **帶 `skipReason`**（例如 `identity disabled`），唔會排入 doomed run — preview 話跳幾多、create 就跳幾多（E2E 200-id 實測：4 DISABLED → 4 SKIPPED 帶原因）。

**冪等**：同 `idempotencyKey` 重複 create → 200 + 同一 `cycleId`（replay flag，無第二個 cycle）。`POST /api/batches/:id/start` 冪等：batch 已 RUNNING → 200 `{started:false, reason:'already-running'}`（唔會雙派工）。

**Rate budget（MD §13.2）**：人工 operator 嘅 batch 寫操作（create/start/stop/remove 等）限 20/60s/actor，超 = 429 `RATE_LIMITED`；**service lane**（`x-wa-service-token`，worker→API 內部調用）豁免呢個人 budget — 佢受 global container cap 支配（B6 修復：單一 service actor 唔再同 4 個 batch 搶同一個 20-req budget 導致派工被 429 誤判為永久失敗；429 亦已改為 retryable，park RETRY_WAIT 等下個 scheduler tick）。purge 另有獨立 admin+human 門（service token 一律拒）。

**RAM-G1 准入**：batch container start 前過 RAM gate（port lease 之前）— 不足 = **`503 RAM_GATE_DENIED`**（retryable：worker RETRY_WAIT，pending 保留、零創建；reason 詞彙同 device 路徑統一，見 Redroid 錯誤碼契約 + `docs/ram-gate.md`）。

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/api/identities` | viewer+ | `status`（11-state FSM）/ `q` / `page` / `pageSize` | 200 `{items,total,...}`；allow-list 投影、無 credential 欄 |
| POST | `/api/batches/preview` | operator+ | 同 create body | 200 計劃：逐 batch 逐 identity 嘅預測結果（READY 入 batch / SKIPPED+原因 / unknown 報告）— 純讀、無副作用 |
| POST | `/api/batches` | operator+ | `{name, idempotencyKey(8–64 `[A-Za-z0-9_-]`), identities[](UUID, 1–1000, 去重), batchSize, maxActiveContainers(1–100), failurePolicy: stop_batch\|continue_and_report, config?}` | 201 `{cycleId, batches[]}`；重 key replay = 200 同 cycleId；unknown id = 400 `VALIDATION_ERROR`；DISABLED/terminal → SKIPPED 帶 `skipReason` |
| GET | `/api/batches/capacity` | **admin** | — | 200 `{globalCap, key, formula}`：`effective = min(batch.maxActiveContainers, globalCap ?? ∞)` |
| POST | `/api/batches/capacity` | **admin** | `{maxActiveContainers: int≥1 \| null}` | 200；null = 清除全局上限（各 batch 只受自己嘅 cap 約束） |
| GET | `/api/batches/:id` | viewer+ | — | 200 batch 詳情（status、計數、membership 摘要）；404 `BATCH_NOT_FOUND` |
| POST | `/api/batches/:id/start` | operator+ | — | 200 `{started, batch}`；已 RUNNING = `{started:false, reason:'already-running'}`；terminal = 409 |
| POST | `/api/batches/:id/pause` `\|resume` `\|cancel` | operator+ | — | 狀態過渡 + audit；cancel：未開跑 membership → SKIPPED（`batch cancelled`），已入 run → CANCELLED，容器 best-effort stop（volume 保留） |
| POST | `/api/task-runs/:id/retry` | operator+ | — | terminal failed/timed_out → 開新 attempt（attempt 計數 +1，重用同一 run row 語義見 MD §11）；succeeded/cancelled = 409 |
| POST | `/api/task-runs/:id/cancel` | operator+ | — | running/queued → CANCELLED（容器 stop、lease release、volume 保留） |
| GET | `/api/task-runs/:id/logs` | viewer+ | — | 200 `{events[]}`（`attempt_started`/`container_started`/… 時間線） |
| GET | `/api/batch-containers` | operator+ | — | 200 active managed container 列表（label 反查 + DB lease 對賬；allow-list 投影） |
| POST | `/api/batch-containers/reconcile` | operator+ | `{fix?: bool}` | orphan 掃描（無 label managed 容器、stale lease、DB 有 run 無容器）。`fix=true`：stop+remove orphan 容器、release 死 lease、孤立 run → FAILED_FINAL（`ORPHAN_RECLAIMED`）；全部動作有 audit row |
| POST | `/api/task-runs/:runId/containers/start` | operator+（service 可用） | — | 為 run 啟容器（adopt 已存在同名容器；port lease CAS）；失敗 = 結構化 error code（`IMAGE_NOT_FOUND`/`PORT_POOL_EXHAUSTED`/…） |
| POST | `/api/task-runs/:runId/containers/health` | operator+（service 可用） | — | 200 即時探測（ADB TCP handshake）；容器唔喺 = 明確 404/409（唔會假 OK） |
| POST | `/api/task-runs/:runId/containers/stop` | operator+（service 可用） | — | **可逆 stop**（MD Phase 3 item 4）：容器退出、**volume + data 原封**、port lease 釋放；可再 start |
| POST | `/api/task-runs/:runId/containers/remove` | operator+（service 可用） | — | **volume-retention remove**：容器走、identity data 留（冪等，已冇 = no-op）。**唯一**可以抹 data 嘅路徑係 purge |
| POST | `/api/identities/:id/purge` | **admin + human only**（service 拒） | `{dryRun?: bool, confirm?: string}` | dryRun=true → 預覽（size/files/containers）零改動；dryRun=false → `confirm` 必須 = identity id（防錯字 token）→ ownership-gated stop/remove 容器 → 抹 data dir → 全動作 audit |

## Stream Console（MC P1–P3 + P5 hardening — 真人即時操作 Redroid 設備）

架構：browser WS ↔ **API gateway**（認證 + 盲管）↔ **stream-sidecar**（per-lease screencap/scrcpy 會話 + 輸入管道；ADR-019/020）。**Ticket 消耗語義 = 「成功 handshake 先消耗」**（ADR-024，NV5b(c)：HMAC、60s TTL、綁 user/device/mode；驗證通過唔燒票 — 升級失敗可重用同一張，成功 handshake 後先消耗、重放 401），經 `stream_ticket` HttpOnly cookie（Path=/api/device-streams）傳送；raw client 可用 `?ticket=` query（P1 probe 路徑）。Lease = server-side 資源（`stream_leases` 表 + Redis resource slot，max 5），TTL 30s（`STREAM_LEASE_TTL_MS`）+ heartbeat 延長；WS 連接本身 = liveness（API 自動 heartbeat）。

**WS upgrade 認證鏈（每步 server-side 重驗，MD §8.1）**：Origin（fail-closed：missing/唔喺 allowlist → 403 `ORIGIN_NOT_ALLOWED`）→ session（401）→ lease 存在（404）→ owner/admin（403 `STREAM_LEASE_OWNER_MISMATCH`）→ lease ACTIVE + 未過期（409 `STREAM_LEASE_CLOSED`/`STREAM_LEASE_EXPIRED`）→ device running（409 `STREAM_DEVICE_NOT_RUNNING`）→ ADB port 喺 host allowlist（403 `STREAM_DEVICE_ADB_NOT_ALLOWED`）→ ticket 驗證（未消耗檢查；401 `STREAM_TICKET_INVALID`/`STREAM_TICKET_REPLAYED`）→ **成功 sidecar handshake 後先消耗 ticket**（ADR-024；並行重複只有 consume 贏家存活，輸家 401 拆管）。全部 reject = 結構化 error envelope + audit row。

**P5 inbound DoS guard（sidecar）**：WS `maxPayload` 64KiB（超額 frame → close 1009，API tunnel 隨拆）；輸入 token bucket 30/s（MD §11.9）。

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| POST | `/devices/redroid/:id/streams` | viewer+（controller 需 operator+） | body `{mode: 'viewer'\|'controller'}`；`:id` = device UUID | 201 `{lease, ticket, streamWsPath}` + `Set-Cookie stream_ticket`；403 `STREAM_PERMISSION_DENIED`（controller 角色不足）/`STREAM_DEVICE_ADB_NOT_ALLOWED`；404 `STREAM_DEVICE_NOT_FOUND`；409 `STREAM_DEVICE_HELD`（device 已有 lease）/`STREAM_DEVICE_NOT_RUNNING`/`STREAM_CAPACITY_REACHED`（5/5）；**429 `RATE_LIMITED`（10/min/user，P5）** |
| GET | `/device-streams` | viewer+ | — | 200 `{leases[], usage:{active,max}}`（allow-list 投影：零 secrets，MD §8.1/§13） |
| POST | `/device-streams/:leaseId/heartbeat` | viewer+（owner/admin） | — | 200（TTL 延長）；403 `STREAM_LEASE_OWNER_MISMATCH`；404 `STREAM_LEASE_NOT_FOUND`；409 expired/closed |
| POST | `/device-streams/:leaseId/reconnect` | viewer+（owner/admin） | — | 200 `{lease, ticket, streamWsPath}`（新 ticket，成功 handshake 先消耗 — ADR-024；MD §2.1.8）；409 `STREAM_LEASE_EXPIRED`/`STREAM_LEASE_CLOSED`；**429（10/min/user，P5；前端遵從 Retry-After）** |
| DELETE | `/device-streams/:leaseId` | viewer+（owner/admin） | — | 200（冪等；`idempotent:true` = 已 closed）；403/404 同上 |
| WS | `/device-streams/:leaseId/ws` | owner/admin | cookie session + stream_ticket（或 `?ticket=`）+ Origin（allowlist） | 101 成功；reject 見上認證鏈（401/403/404/409 + 結構化 body） |

**WS frame 協議**（client→server 只可發 input frame；server→client = 畫面 binary frame + 狀態 frame）：
- client：`{t:'input', kind:'tap'|'swipe'|'text'|'scroll'|'key', ...}`（座標 = 0–1 比例；text 內容**永不入 log**，只記 kind + byte 數，MD §11.4/§13）；`{t:'close'}` = 正常收流。
- server：`{t:'state', state:'LIVE'|'DEGRADED'|...}`、`{t:'degraded', source:'screencap', reason}`（scrcpy 失败降級，ADR-020）、`{t:'input-rejected', code}`（`STREAM_READ_ONLY` viewer 寫 / `STREAM_NOT_LIVE` / `STREAM_INPUT_RATE_LIMITED` P5）、`{t:'dead', reason}`、binary = 畫面 frame。
- viewer lease = **read-only by construction**（sidecar session mode）：LIVE 畫面照常，任何 input → `STREAM_READ_ONLY`（協議層，非 UI 隱藏）。

## Identity 登入狀態機 + Provisioning + dataDir 歸屬（T2 — ADR-029）

**語義定位（外部讀者必讀）**：`loginState` = 「呢個 identity 嘅 App 登入咗未」嘅**唯一系统事实源**，四態、fail-closed、**人工專用寫入路徑** — probe/worker/AI 永遠唔准斷言登入真相（route = session-cookie operator+，service 無第二個寫入 caller，grep 可證）。同 device 軸／batch runtime `Identity.status` 刻意正交：device 移除/重建/換名完全唔碰 loginState。

**轉換矩陣（`login-state-service.js` 唯一權威；矩陣以外全 409，包括 self-transition — 重複 click = bug 唔係 no-op）**：
- `PENDING_LOGIN`（新身份初始態）→ `CONFIRMED_LOGGED_IN` | `LOGGED_OUT`
- `CONFIRMED_LOGGED_IN` → `RELOGIN_REQUIRED`（人類睇到 credential challenge/2FA/session 過期 — 自動化必須停喺呢度）| `LOGGED_OUT`
- `RELOGIN_REQUIRED` → `CONFIRMED_LOGGED_IN` | `PENDING_LOGIN` | `LOGGED_OUT`
- `LOGGED_OUT` → `PENDING_LOGIN`（唯一出路）

每次成功轉移 = 同一請求內一條 append-only 審計行（`fromState`/`toState`/`actorUserId`/`evidence`/`createdAt`）。`evidence` = ≤500 字 operator 備註；含 credential 形狀字樣（password/token/cookie/secret/otp/session_id）= 400（零 secrets 紀律）。

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/identities/:id/login` | viewer+ | `:id` = identity UUID | 200 `{login:{identityId, externalRef, displayName, loginState, loginStateSince}}`（零 secrets）；404 `IDENTITY_NOT_FOUND`；T2 表未 migrate = 503 `LOGIN_STATE_DISABLED` |
| GET | `/identities/:id/login/audit` | viewer+ | query `limit`（1–200，默認 50） | 200 `{items:[{id,identityId,fromState,toState,actorUserId,evidence,createdAt}]}`（newest first）；404/503 同上 |
| POST | `/identities/:id/login/transition` | **operator+**（人工 session，無 system caller） | body `{to: PENDING_LOGIN\|CONFIRMED_LOGGED_IN\|RELOGIN_REQUIRED\|LOGGED_OUT, evidence?}` | 200 新狀態；400 `VALIDATION_ERROR`（未知態/evidence 非字串/credential 形狀）；409 `INVALID_LOGIN_TRANSITION`（矩陣以外含 self）；404/503 同上 |
| POST | `/identities/provision` | **admin** | body `{names[1–100]（必匹配 `^redroid-[a-z0-9][a-z0-9_-]{0,39}$` — pool entry = device name = dataRoot 目錄名，全程 1:1 可推導）, identityType? qa_device\|staging_user, egressIps?（平行陣列，寫入前全批 pre-check：批內重複 + fleet 全局唯一）, dryRun?}` | 200 `{items:[{name,identityId,action:created\|replayed\|would_create,dataPath,suggestedDeviceName,fingerprint?,egressIp?}], created, replayed, dryRun}`；冪等 = 既有 externalRef → `replayed` 永不重複建行；fingerprint 自動 `ensureProfile()`（per-identity 決定性，ADR-028）；400 `VALIDATION_ERROR`（name 非法/批內重複）；409 `EGRESS_IP_PRECHECK_FAILED`（成批 fail-closed 零部分寫入；真正 binding 仍用 `PUT /identities/:id/egress`） |

**identity↔dataDir 歸屬契約（explicit claim，取代隱式繼承；`identity_data_dir_claims` 表，DB 層「一身份一家、一家一身份」UNIQUE×2）**：
- 綁咗身份的 device create：他身份 claim 同名 dir → **409 `DATA_DIR_CLAIM_CONFLICT`**（跨身份 /data 繼承 = 污染，fail-closed；出路 = delete 時 removeData=true 或換名）；同身份 re-claim 同 dir → 放行 + refresh（stop→remove→rebuild 保留 /data 正正係契約用途）；同身份想開第二個 dir → 409（one identity, one data home；rename 唔搬數據）。
- 未綁身份的 device：完全唔碰 claim（行為同 pre-T2 byte-identical）。
- delete：預設（唔除數據）→ dir + claim **保留**（回應 `claimReleased:false` 如實上報）；`removeData=true` 且實際刪除成功 → `claimReleased:true`。create 回滾且 dir 係本次新建 → claim 連 dir 一齊撤（無孤兒）。
- TOCTOU：競態落 DB unique guard → P2002 → 409（永遠唔會靜默認領）。
- 契約收緊提示：pre-T2 允許一身份多 live device（各自 dir）；T2 後一身份一家 — 存量「一身份多機」部署上線前先清 claim 衝突（ADR-029 §4）。

三處同步紀律（ADR-029 §3）：shared 矩陣（權威）+ `batch-ui.js LOGIN_TRANSITIONS_UI`（UI 鏡像，只驅動按鈕可見性）+ 矩陣 unit（drift 即紅）。深度設計 = `docs/architecture-decisions.md` §29。

## Account 生命週期 + Gmail 開號驅動器（T5 — ADR-030）

**語義定位**：`account_lifecycle` 係 login_state 的**兄弟機**（獨立表掛 identity 旁），記「開號流水線進度」（機器驅動）而唔係「App 登入真相」— 寫入者 = 驅動器（system）+ operator 人工覆蓋。**橋接規則（兩軸正交，外部讀者必讀）**：(a) 開號成功（READY）**唔自動**改 loginState — 新帳號首次登入仍係人工確認；(b) login 軸 RELOGIN_REQUIRED/LOGGED_OUT 唔觸碰 lifecycle；(c) lifecycle DEAD（被封/死亡）→ login 軸點 mark 由人決定，系統唔越權；(d) ban/死亡以 DEAD+failureCode 承載，login 四態零變動。（使用面分工 — 老細 14:36 定調：Gmail App = 長期登入錨點（login 軸事實）；瀏覽器 = 日常操作面（lifecycle 軸管線）。）

**狀態機（7 態；矩陣權威 = `packages/shared/src/gmail-provision.js`，三處同步照 T2）**：
`PREPARING → PROVISIONING → AWAITING_HUMAN（CAPTCHA 人肉口）→ CREATED → RECOVERY_SETUP → READY`；任何非終態可 `→ DEAD`（終態）。非法轉換（含 self）= 409 `INVALID_ACCOUNT_TRANSITION`；未知態 = 400。全部轉換落 append-only 審計（`fromState`/`toState`/`actorKind` system∣human/`actorUserId`/`reasonCode`/`createdAt`；details 零 PII）。

**驅動器步驟機**：`open-signup → fill-profile → captcha-gate → [人工口] → detect-created → vault-credentials → recovery-setup`。CAPTCHA **唔准自動解**（拍板）：行到 gate → 開 P4 干預工單（`EXTERNAL_VERIFICATION`，dedupe 照 ADR-021）+ 停 `AWAITING_HUMAN`；resume 只認工單 RESOLVED/DISMISSED（resume 免費，唔食節流配額）；死線（默認 2h，`WA_GMAIL_CAPTCHA_TIMEOUT_MS`）過而工單未清 → DEAD `CAPTCHA_TIMEOUT`；adapter 硬失敗 → DEAD `ADAPTER_FAILURE`（半成品重試 = 關聯風險，唔重試）。

**節流（fresh start 前檢查，順序：identity 日配額 → IP 日配額 → 全局隨機間隔窗；counter 表 UTC day key；429 零配額消耗，deny 帶 `retryAfterMs`）**：429 `THROTTLE_IDENTITY_DAILY_LIMIT` / `THROTTLE_IP_DAILY_LIMIT` / `THROTTLE_INTERVAL`。IP 來源 = W3 egress binding（未綁 = IP scope 跳過，identity scope 照守）。

| Method | Path | Role | 參數 | 錯誤碼 / 備註 |
|--------|------|------|------|--------------|
| GET | `/identities/:id/account` | viewer+ | — | 200 `{account, vault}` — vault = `{emailMasked（`ab***@domain` 形）, hasPassword, recoveryEmailMasked, profile（決定性派生假料，明文存）, createdAt}`；**email/password/恢復郵箱明文同密文從唔出海面**（AES-256-GCM 保管庫，canary 測試釘死零洩漏）；404 `IDENTITY_NOT_FOUND`；503 `ACCOUNT_LIFECYCLE_DISABLED`（T5 表未 migrate） |
| GET | `/identities/:id/account/audit` | viewer+ | query `limit`（1–200） | 200 `{items:[{id,identityId,fromState,toState,actorUserId,…}]}`（newest first）；404/503 同上 |
| POST | `/identities/:id/account/transition` | **operator+**（人工覆蓋） | body `{to: PREPARING\|PROVISIONING\|AWAITING_HUMAN\|CREATED\|RECOVERY_SETUP\|READY\|DEAD, reasonCode?（`^[A-Z0-9_]{2,60}$`，默認 `OPERATOR_OVERRIDE`）}` | 200；409 `INVALID_ACCOUNT_TRANSITION`（矩陣以外含 self/終態 DEAD）；審計 `actorKind:human` |
| POST | `/identities/:id/account/provision` | **operator+**（驅動器推一啖） | — | fresh start（過節流 → 跑到 CAPTCHA 口停 `AWAITING_HUMAN` + 開工單）或 gate resume（工單 RESOLVED 放行 → …→ READY）；429 `THROTTLE_*`（帶 `retryAfterMs`）；503 `ACCOUNT_INPUT_MISSING`（恢復郵箱池空 — **先於**配額/狀態變更，零燒配額；拍板：冇恢復郵箱 = 唔准入「就緒」）；503 `GMAIL_PROVISION_DISABLED`（`WA_GMAIL_PROVISION_ENABLED` 默認 OFF — 三項輸入未拍板前唔准默默 ON）；503 `INTERVENTION_UNAVAILABLE`（CAPTCHA 工單 surface 冇碌）；409 `ACCOUNT_NOT_DETECTED`（半成品偵測，retry — 真機段校準） |

**環境參數契約**（`apps/api`；保守默認值，语義 = ADR-030 §5，全表見 README「T5」節）：`WA_GMAIL_PROVISION_ENABLED`（默認 false）／`WA_GMAIL_RECOVERY_POOL`（逗號分隔；空池 fail-closed 見上；例 `pool-a@example.com,pool-b@example.com` — dev-only 假值）／`WA_GMAIL_PER_IP_DAILY`（2 — 抗關聯主槓桿，改 env 即生效代碼零改）／`WA_GMAIL_PER_IDENTITY_DAILY`（1）／`WA_GMAIL_MIN_INTERVAL_MS`/`WA_GMAIL_MAX_INTERVAL_MS`（300000/900000 = 5–15 分鐘均勻隨機窗）／`WA_GMAIL_CAPTCHA_TIMEOUT_MS`（7200000）。**損耗率紀律**：每個 DEAD 必帶 failureCode + 完整審計鏈；缺碼 = 記錄缺損 = 驗收未夠。

## Account Generator — 帳號資產註冊表（GAcct — ADR-034）

**語義定位**：帳號 = 資產。`account-registry-service`（`apps/api/src/services/account-registry-service.js`）係 gitignored JSON 賬本（默認 `.dev/accounts/registry.json`，mode 0600、atomic tmp+rename），記 persona（決定性生成、地區連貫）+ `role ∈ {anchor, ops, farm, recovery}`（語義權威 = ADR-034 §1）+ lifecycleState（T5 七態機引用，軟退休 = 遷 DEAD，硬刪唔存在）+ 三位一體綁定（`bindings.fingerprintProfileId`/`egressProfileId`，兩者齊或明確 deferred，半綁定 fail-closed）。密碼 AES-256-GCM 密封（同一 `APP_ENCRYPTION_KEY` 治理面）——明文只准喺進程內瞬時 / CLI `--show` / 操作者終端；庫檔、日誌、repo 零字面。本節零新增 HTTP 端點（註冊表暫只行 CLI/service 面；API 面等下一單連同註冊 driver 併入）。

**記錄欄位**：`{id, role, lifecycleState, email, bindings{fingerprintProfileId, egressProfileId, deferred}, persona（personaForStorage 投影：零密碼 + hasPassword + passwordMeta 熵審計）, passwordCiphertext（`v1:iv:tag:cipher`）, passwordPolicyId, passwordEntropyBits, createdAt, updatedAt, retiredAt, history[]（append-only 狀態軌跡）}`。規則：gmail 地址全艦隊唯一（create 撞名 → 換新 accountId 重生，max 25 attempt）；export/import = 密文可攜（重複 import 冪等、分歧硬衝突 `IMPORT_CONFLICT`）。

**CLI**（`node apps/api/src/cli/account-gen.js`；env：`APP_ENCRYPTION_KEY` 必需、`ACCOUNT_REGISTRY_PATH` 可換庫路徑）：

| 命令 | 語義 | 秘鑰紀律 |
|------|------|-----------|
| `create --role <anchor\|ops\|farm\|recovery> [--style softname\|wordnum\|nature\|any] [--region hk\|cn\|tw\|us\|gb\|jp\|kr\|de] [--fp <id> --eg <id>] [--show]` | 生成 + 入庫；印 persona 摘要（maskEmail 掩碼）+ vault 指針 | 密碼只在 `--show`；綁定唔齊即明確 deferred |
| `list [--role <r>]` / `show <id> [--show]` | 賬本視圖（掩碼） | 同上 |
| `retire <id> [--note <t>]` | 軟退休（T5 → DEAD，冪等，history append） | — |
| `export [--out <f>]` / `import <f>` | 密文備份/合併（老細側資產） | 匯出檔零明文 |

**註冊自動化契約預留**（`packages/shared/src/account-provision-contract.js`）：driver 輸入 = persona + credentials（validator fail-closed），輸出 = 封閉事件集（`STATE_TRANSITION`/`STEP_PROGRESS`/`HUMAN_GATE`/`CREDENTIALS_SEALED`/`TERMINAL_FAILURE`）；狀態事件逐條過 T5 矩陣；SMS 牆/CAPTCHA 閘一律 `HUMAN_GATE` → 現有介入 console（category `EXTERNAL_VERIFICATION`），**AUTO-SOLVE = 契約違規**（禁自動解，同 ADR-030 CAPTCHA 同口徑）；憑證形狀欄位禁入事件。stub 驅動器已交付（行合法序列、泊人肉閘）；Chrome 自動化實裝 = 下一單。

## Egress Group 調度（WA-IPGROUP — 鐵律 2：同出口 IP 零併發 + 隨機錯峰）

完整語義（group 模型三層 derivation、兩層 DB-backed 防重疊、錯峰分布 = UNIFORM over 閉區間整數 [minMs,maxMs]、per-account limiter 正交關係）= `docs/egress-groups.md`。這裡只列 API 契約：

| 方法 | 路徑 | RBAC | 契約 |
|------|------|------|------|
| GET | `/egress-groups` | viewer | `{groups:[{groupKey, memberIds[], activeRunId, activeRunStatus, waitingRunIds[], pendingMemberCount（組待行數）, lastFinishedAt, nextEligibleAt（下次放行估計 = 最後 terminal + 決定性抽樣）, jitterWindowMs}]}`；singleton 組唔入 payload；secret-free（labels/IPs/uuids）；W3 switch OFF → 503 `EGRESS_BINDING_DISABLED`（同 binding 面同一閘） |
| PUT | `/egress-groups/jitter` | **admin** | body `{minMs, maxMs（整數 0–3_600_000，必填）}` → 200 `{jitterWindowMs（swap 正規化後嘅實際窗口）, key, defaults}`；寫 AppSetting `egress.group_jitter_ms` = `{value:{minMs,maxMs}}`；min>max 存前 swap（同 scheduler 讀取語義一致）；審計 `egress.group_jitter_set`；**唔受 W3 switch 管**（組調度靠 label 已-work，W3 只係 binding 面）；400 schema 越界 |

## 端點總計

**122 條路由**（逐檔案計；P5 2026-10-24 實核 = P4-MC 105 條 + **stream console 5**；2026-10-27 補 **system ram-gate 4 + identity login/provision 4（T2）+ account lifecycle 4（T5）**）：health 2 + auth 3 + containers 15（含 5 個 action + exceptions 3 條 + create-from-template）+ container templates 2 + dashboard 1 + tasks 15（runs 6 + approvals 3 + tools 1 + providers 4 + audit 1）+ task definitions 1 + schedules 10（含 POST preview）+ schedule notifications 4 + manual interventions 9（P4-MC）+ **stream console 5（MC P1–P3：create/list/heartbeat/reconnect/close；另有 1 條 WS upgrade path 唔計入 REST 路由）** + redroid templates/preflight 5 + redroid devices 11（含 3 個 action + proxy/retry）+ batch control 21（BR-B2）+ system ram-gate 4（RAM-G1）+ identity login/provision 4（T2）+ account lifecycle 4（T5）。註：identity egress binding（W3，4 條）／fingerprint（W1，2 條，另 1 條 list）路由契約照 ADR-027/025 + README P5 表，未併入本總計（待併，老實標注 2026-10-27）；**WA-IPGROUP 另加 `/egress-groups`（GET）+ `/egress-groups/jitter`（PUT）2 條（同上待併標注，2026-10-29）**。所有寫操作（POST/PATCH/PUT/DELETE，`/auth/login` 除外）：RBAC + audit row（actor、request_id、IP、status、details scrub）+ Origin 檢查（browser mutating 請求）。
