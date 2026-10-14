# water_army

Docker 容器 + AI 任務自動化平台（7 階段 MVP 之中）。本地單一部署：一個 UI、一個 API、一個 worker、Postgres 17、Redis 7，全部跑喺同一部主機嘅 Docker 入面。

- **api** — Fastify 5：auth（argon2id + session cookie）、RBAC、health、容器 API（P2）、AI 任務/批准/provider 管理 API（P3）
- **worker** — BullMQ worker：容器任務（P2）＋ AI 任務執行引擎（P3：agentic tool loop、approval gate、timeout/cancel/retry）。**無 Docker socket** — 容器操作全部經 api service token
- **web** — React 19 + Vite 8：Dashboard、Containers（P2）、AI task runs list/detail（P3：狀態機視覺化、SSE 事件流、cancel/retry、approve/deny）
- **postgres / redis** — 只在 compose 內部網絡，**唔 publish host port**

施工依據：`docs/repo-audit.md`、`docs/architecture-decisions.md`（版本鎖定表）、`docs/build-checklist.md`。P0 已交付，本 README 屬 P1（Skeleton + Deployment）。

---

## 架構

```
            host (127.0.0.1:3012)
                     │
              ┌──────▼──────┐
              │     web     │  React + 靜態 server + /api 反代
              └──────┬──────┘
                     │  (compose 內部網絡)
              ┌──────▼──────┐   ┌───────────────┐
              │     api     │──▶│   postgres    │  (volume: pgdata)
              │  Fastify 5  │   └───────────────┘
              └──────┬──────┘   ┌───────────────┐
                     │          │     redis     │  (volume: redisdata, AOF)
              ┌──────▼──────┐   └───────────────┘
              │   worker    │
              └─────────────┘
  只有 api 掛 /var/run/docker.sock（:ro）；worker/web 永遠睇唔到 socket。
```

## 要求

| 項目 | 要求 |
|------|------|
| Docker Engine | ≥ 28（實測 29.1.3） |
| Docker Compose v2 | ≥ 2.24（實測 2.40.3） |
| 主機用戶 | 喺 `docker` group（**唔好** chmod 666 socket） |
| 本地開發 Node | ≥ 22（host 實測 v22.22.2）；容器內統一 `node:24` |

> **`sg docker` wrapper**：如果你嘅 shell session 早喺加入 docker group 前已開，
> 直接 `docker compose ...` 會 EACCES。用 `sg docker -c 'docker compose up -d'`
> 以 docker group 起 process（唔改任何系統設定）。新開嘅 login session 通常已直接可用。

## Quickstart（首次啟動）

```bash
# 0) 進 repo
cd water_army

# 1) 環境檔 + 秘密（3 個 random 64-hex / 32-hex）
cp .env.example .env
openssl rand -hex 32   # → APP_ENCRYPTION_KEY 同 SESSION_SECRET（各用一次）
openssl rand -hex 16   # → POSTGRES_PASSWORD
# 編輯 .env，替換全部 REPLACE_WITH_*（DATABASE_URL 內嘅 password 都要同步）

# 2) 起全套（build 三個 image；api 啟動時自動 prisma migrate deploy）
sg docker -c 'docker compose up -d --build'

# 3) 等 healthy（通常 10–30s；web depends_on api healthy）
sg docker -c 'docker compose ps'

# 4) 建第一個 admin（無公開註冊；只可建第一次；輸入 3 行：username / password / 確認 password）
sg docker -c 'docker compose exec api node apps/api/src/cli/setup-admin.js'
# 按提示輸入（TTY 會掩密）；非 TTY 用 pipe（3 行，`-T` 禁用 TTY）：
# printf 'admin\nMyS3cretPass!\nMyS3cretPass!\n' | sg docker -c 'docker compose exec -T api node apps/api/src/cli/setup-admin.js'

# 5) 登入 UI
# 開 http://127.0.0.1:3012 → 用第 4 步嘅帳密
```

健康檢查：

```bash
curl -s http://127.0.0.1:3012/api/health/live    # process 存活 → {"status":"ok"}
curl -s http://127.0.0.1:3012/api/health/ready   # DB/Redis/Docker 逐項
```

## 日常操作

| 操作 | 命令 |
|------|------|
| 看狀態 | `sg docker -c 'docker compose ps'` |
| 看 log | `sg docker -c 'docker compose logs -f api'`（`web`/`worker`/`postgres`/`redis` 同理） |
| 暫停（保數據） | `sg docker -c 'docker compose stop'` |
| 再開 | `sg docker -c 'docker compose start'` |
| 重啟單項 | `sg docker -c 'docker compose restart api'` |
| 完全重置（**刪 DB + queue volume**） | `sg docker -c 'docker compose down -v'` |
| 重建全部 | `sg docker -c 'docker compose down' && sg docker -c 'docker compose up -d --build'` |

### 資料備份 / 還原

```bash
# 備份（pg + redis 皆在 volume）
sg docker -c 'docker compose exec -T postgres pg_dump -U app water_army' > wa-backup-$(date +%F).sql
sg docker -c 'docker compose cp water-army-postgres-1:/var/lib/postgresql/data -'   # 冷備（先 stop）

# 還原
sg docker -c 'docker compose exec -T postgres psql -U app water_army' < wa-backup.sql
```

### 資料庫 migration

- api 每次啟動 entrypoint 會跑 `prisma migrate deploy`（幂等，只落未 apply 嘅 migration）。
- migration 已 commit 入 repo（`prisma/migrations/`），**唔好手改已 apply 嘅 migration**。
- 新增表：`npm run db:migrate -- create`（本地）→ 检视 → commit。
- 確認同步狀態：`sg docker -c 'docker compose exec api node -e "1"'` 唔需要 — 直接看 api log 有冇 `prisma migrate deploy` 輸出，或用 host 上 `npx prisma migrate status`（配好 DATABASE_URL 指向同個 DB）。

## 第一個 admin

- 入口：`node apps/api/src/cli/setup-admin.js`（api 容器內或 host 本地 dev）。
- **只可執行一次**（users 表非空即拒絕；無 reset 路徑 — 要重置就得 `down -v` 或手動改 DB）。
- 密碼規則：≥ 12 位、混合字母數字（argon2id 儲存；任何 API/log 唔會傳回 hash）。
- 之後無公開註冊；加人 = DB 層手動（P5 先有 Settings 頁面）。

## API（P1 範圍）

Base：`http://127.0.0.1:3012/api`（web 同源性代理；API 本體唔 publish host port）。

| Method | Path | 說明 | Auth |
|--------|------|------|------|
| GET | `/health/live` | process 存活（200；唔查依賴） | 無 |
| GET | `/health/ready` | DB/Redis/Docker 逐項。docker down → **200 degraded**（worker 可稍後重啟 api）；db/redis down → **503** | 無 |
| POST | `/auth/login` | `{username,password}` → 200 + `Set-Cookie: session=…`（HttpOnly, SameSite=Lax）。失敗 401 INVALID_CREDENTIALS（唔洩露用户存在）；限流 429 RATE_LIMITED（5 次失敗/60s/IP，只計失敗） | 無 |
| POST | `/auth/logout` | 204；session 即刻失效 + cookie 清除 | 任何角色 |
| GET | `/auth/me` | 200 `{user:{id,username,role,lastLoginAt}}`；401 無 session | 任何角色 |

RBAC 角色階梯：`viewer < operator < admin`。401 = 未認證；403 = 角色不足。
所有錯誤 = 統一 envelope：`{"error":{"code","message","requestId"}}` + `X-Request-Id` header。

### P2 容器 API（已交付）

| Method | Path | 說明 | Auth |
|--------|------|------|------|
| GET | `/containers` | list（`?withStats=true` 附逐容器 CPU/mem；`?state=`、`?managed=`、`?q=`、分頁 `page/pageSize`）。逐項 stats 失敗只嗰項 `—`，唔拖慢整頁 | viewer+ |
| GET | `/containers/:id` | inspect 摘要（state/ports/mounts/labels/創始者 + env **server-side masked**：敏感 key 只留 `••• (N chars)`） | viewer+ |
| GET | `/containers/:id/logs` | demux 後嘅容器 log（`?tail=` 行數上限、`?search=`） | viewer+ |
| GET | `/containers/:id/stats` | 單次 CPU/mem 快照 | viewer+ |
| GET | `/containers/events` | **SSE**：`container` 事件白名單（start/stop/kill/die/pause/unpause/restart/rename/create/delete/update）+ 斷線自動 release slot；並行上限（超 → 503 SSE_LIMIT） | viewer+ |
| POST | `/containers/:id/{start,stop,restart,pause,unpause}` | 冪等狀態機（§9.3）：目標狀態已達 = 200 `idempotent:true`；op 後再 inspect 確認；卡住 → `OPERATION_PENDING` | operator+，只限 managed（例外表內除外） |
| DELETE | `/containers/:id` | `{confirm, removeVolumes?, force?}` — `confirm` 必須逐字 repeat 容器 name/id（兩步確認）；默认保留 bind mount；`removeVolumes=true` 先删 volume | **admin**，只限 managed |
| GET/POST | `/templates` | 模板 allowlist CRUD（image 必 pin digest/tag；port/env 白名单；`privileged` 要 reason） | 讀 viewer+；寫 admin |
| POST | `/containers` | 由模板建容器：`{templateId, displayName, idempotencyKey, env}` — env 只准模板白名单 key（值任意）、無任意 Docker payload；冪等（同 key 回放 = 201 + `idempotent-replay: true`，唔建第二個）；container 帶 `app.managed/app.template/app.idempotency-key/app.created-by` labels | operator+ |

錯誤分類（四類，見 `packages/shared` `DOCKER_ERROR`）：`CONTAINER_NOT_FOUND`(404)／`DOCKER_DAEMON_UNAVAILABLE`(503)／`DOCKER_PERMISSION_DENIED`(502)／`DOCKER_TIMEOUT`(504)／其餘 `DOCKER_ERROR`(502)。`NOT_MANAGED`(403) = managed gate；`NAME_TAKEN`/`FLOW_TOKEN_REUSED` 等 = 路由層 409/400。

**P3 起已接**：`/tasks`（list + detail）。**P4–P5 將接**：`/schedules`、`/devices`、`/ai-providers` 管理頁、`/settings` 等 — 見 `docs/architecture-decisions.md`。

### P3 任務 API（已交付）

| Method | Path | 說明 | Auth |
|--------|------|------|------|
| POST | `/tasks/runs` | 建立 AI 任務：`{prompt, provider?, title?, tools?, timeoutMs?, maxAttempts?, idempotencyKey?}` → 202 `{taskRun}`；provider 預設 = env `AI_PROVIDER`（`mock` = 內置可編排 mock） | operator+ |
| GET | `/tasks/runs` | list（`?status=`、`?provider=`、分頁） | viewer+ |
| GET | `/tasks/runs/:id` | detail：run + 全事件流 + approvals | viewer+ |
| GET | `/tasks/runs/:id/events` | **SSE** 事件流：DB poll + `?after=<eventUuid>` cursor resume + heartbeat 25s + terminal 後 `done` 再 close；非法 cursor = 400（唔係 500） | viewer+ |
| POST | `/tasks/runs/:id/cancel` | 真停取消：`cancel_requested` + 移除 waiting job；in-flight 靠 worker DB poll + AbortSignal；**cancel 後零 output/零事件**；冪等 | operator+ |
| POST | `/tasks/runs/:id/retry` | manual retry（**terminal-only**）：同 run 新 attempt（`attempt+1`），舊輸出/事件全數保留 | operator+ |
| GET | `/approvals` | 批准請求 list（`?status=pending/approved/rejected/expired/all`、`?runId=`） | viewer+ |
| POST | `/approvals/:id/approve` / `.../reject` | 人工批准流：**只 admin 真人 session**（service token = 403 — AI 唔可能自批）；`{note?}` | **admin** |
| GET | `/tools` | tool registry 元數據（name/description/safetyClass/args schema） | viewer+ |
| GET/POST | `/providers` | AI provider 配置 CRUD（name + OpenAI-compatible baseUrl + **AES-256-GCM 加密** API key；key 永不傳回 API） | **admin** |
| PATCH | `/providers/:name` | 更新 baseUrl/key（key 變更 = 重新加密） | **admin** |
| POST | `/providers/:name/test` | 用該配置試打模型 endpoint（classified error 詞彙） | **admin** |

**執行拓撲**：API 只寫 DB + 入 BullMQ 隊列；worker 消費 job 跑 agentic tool loop（readonly tool 自動執行、`approval_required` tool 落 `needs_approval` 等 admin）。worker 容器**無 Docker socket** — 所有容器 tool 經 API readonly 端點 + service token（`x-wa-service-token`，operator 身份、audit 可辨）。狀態：`queued → running → (needs_approval →) succeeded/failed/cancelled/timed_out`（`cancel_requested` 為過渡態）。

**Mock 演示（零外部依賴）**：

```bash
# .env：AI_PROVIDER=mock、AI_MOCK_SCRIPT=tool-restart-approve（mock 會 list 容器 + 請求 restart 批准）
sg docker -c 'docker compose up -d --build worker'
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:3012/api/tasks/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"檢查 managed 容器","provider":"mock"}'
# → 202；SSE 跟事件：curl -sN -b /tmp/c.txt 'http://127.0.0.1:3012/api/tasks/runs/<id>/events'
# 到 needs_approval 後，admin 喺 UI Tasks 頁或 API approve → run 繼續 → succeeded
```

### P4 排程 API（已交付 — live 實測 2026-10-15）

| Method | Path | 說明 | Auth |
|--------|------|------|------|
| POST | `/schedules` | 建立排程：`{name, taskDefinitionId, scheduleType: cron|interval|once, cronExpression?, timezone?, intervalMs?, runAt?, overlapPolicy?}` → 201 `{schedule}`。**PG 先行**：DB row 先落，BullMQ 後同步；同步失敗 = row 照存 + `syncStatus=sync_error`（可重試） | operator+ |
| GET | `/schedules` | list（`?enabled=`、分頁）；含 `nextRunAt/lastRunAt/lastStatus/syncStatus/delay` | viewer+ |
| GET | `/schedules/:id` | detail（同上 + lineage 用 `taskDefinition`） | viewer+ |
| PATCH | `/schedules/:id` | 改參數：重新同步（stable key 原地 upsert，**零重複**）；once 改 `runAt` = 換 delayed job | operator+ |
| POST | `/schedules/:id/pause` | 停用（移除 BullMQ 索引，DB row 保留）；冪等 | operator+ |
| POST | `/schedules/:id/resume` | 啟用（重同步 + 重算 next_run_at）；冪等 | operator+ |
| POST | `/schedules/:id/run-now` | 手動 fire（**繞過** overlap/scheduler）；client `Idempotency-Key` 冪等（無 key = `runnow-<uuid>` 每次新 run）→ 202 新 / 200 replay | operator+ |
| POST | `/schedules/:id/sync` | 重試同步（`sync_error` → `synced`）；redis 未復 = 503（誠實，唔假成功） | operator+ |
| DELETE | `/schedules/:id` | 删除（BullMQ 索引 + pending once job 先清；`task_runs` lineage 保留 — `schedule_id` 無 FK 屬設計） | operator+ |
| GET | `/schedules/preview?cronExpression=&timezone=` | cron 預覽（next 5 次 run + 人類可讀描述，纯計算） | viewer+ |
| GET | `/tasks/definitions` | task definition 只讀 list（Schedules UI 用；definition 的寫入唔喺 P4 範圍） | viewer+ |

**排程執行拓撲**：PostgreSQL 係唯一 source of truth；BullMQ Job Scheduler 係 derived index（隨時可由 worker reconcile 重建）。worker boot 時 + 每 5 分鐘跑 **scheduler reconciler**（PG desired-state → 原地 upsert 漂移、清 orphan、自愈 `sync_status`）；fire job 由 **schedule fire handler** 處理：重讀 DB row → guard（已删/停用/stale generation/stale slot）→ 冪等建 run（`idempotencyKey = sched-<uuid>-<slotMs>`，重送 = replay 零重複）→ overlap policy → 推進 `next_run_at`。once 排程 = 确定性 id 嘅 delayed job（`schedonce-<uuid>-<slotMs>`），fire 後自動停用。

**每排程獨立 timezone**：`next_run_at` 用排程自己嘅 IANA tz 計算（預設 `Asia/Taipei`）— cron 表達式按該 tz 解讀，`task_runs.input_json.scheduledSlotAt` 存實際 slot。

**overlap policy**：`skip_if_running`（預設）= slot 撞 active run → 建 terminal `skipped` run（帶 `activeRunId` lineage，slot 照消費、唔重試）；`queue` = 照建新 run（執行並行 — `concurrency_key` 係 schema 欄但 P0–P3 未強制執行，見 ADR §13.6）。

**web UI**：Schedules 頁（list + create/edit dialog + pause/resume/run-now/sync-retry/delete + next/last run 顯示 + `sync_error` 旗標），RBAC 按 role 啟停 action。

**live 實測（2026-10-15，compose stack）**：cron 1 分鐘 2 次 fire ✓ / interval 30s + pause 後靜音 ✓ / once 自動停用 ✓ / 重啟 reconcile 2 輪 `getJobSchedulers` 數量 = DB enabled 且零重複 ✓ / skip_if_running 建 skipped run（activeRunId 實指）+ queue 建 run 唔 skip ✓ / redis down → `sync_error` → 503 → 復原後 `/sync` 200 ✓ / run-now 冪等（同 key 同 run）✓ — 詳情 ADR §13。

## 安全模型（T1 威脅）

- **Docker socket 隔離**：只有 `api` 掛 `/var/run/docker.sock`（read-only）；worker/web 無。worker 執行容器經 api（P2）；P3 嘅 AI tool 同樣只經 api（service token，worker 零 socket）。
- **Service token**：`WORKER_API_TOKEN`（api + worker 同值 env）— worker→API 嘅機器身份，operator 權限、固定 UUID、audit 可辨（`actor: service:worker`）。**批准流永遠排除 service token**（`requireHuman` guard）— AI 唔可能自批自己嘅 tool call。
- **網絡**：postgres/redis 零 host port；web 只綁 `127.0.0.1:3012`；api 零 host port（只經 web 反代）。
- **容器硬化**：所有服務 `read_only: true`（必要目錄 tmpfs）+ `no-new-privileges` + `cap_drop: ALL` + log rotation（10m × 3）。
- **Auth**：argon2id；session token 唔落 log、DB 只存 SHA-256；HttpOnly + SameSite=Lax cookie；未知 username 用 dummy hash 對齊 timing（防用户枚舉）；login 限流（失敗計數）。
- **CSRF 基線**：mutating 請求帶 `Origin` 時必須喺 allowlist（`APP_PUBLIC_URL` + api loopback）；無 Origin = 非 browser client（curl/測試）放行；SameSite=Lax 兜底。
- **Log 脫敏**：pino `redact`（`PINO_REDACT_PATHS`：authorization/cookie/x-api-key/password/passwd/apiKey/token/session…，含 `*.field` 嵌套）。
- **Secrets**：全部經 env（`.env`，gitignored）；`.env.example` 入 repo；任何程式碼/commit 唔得有秘密。

## 本地開發（唔經 Docker）

```bash
npm install                 # workspaces 一次起齊
cp .env.example .env        # 改 DATABASE_URL 指向你自己嘅 postgres、REDIS_URL
# 本地無 Docker 時：.env 設 DOCKER_SOCKET_PATH=  → health/ready 會報 docker: disabled

npm run dev                 # 三端並行（api + worker + web；web 用 Vite 同樣綁 127.0.0.1:3012，同 compose 嘅 web 衝突 — 二揀一）
# 或單端：npm run dev:api / dev:worker / dev:web
```

- 本地 dev 時 api 綁 `127.0.0.1:3000`，web dev server（Vite 3012）proxy `/api` → `:3000`（同生產同 origin 模型）。
- Prisma：`npm run db:generate`（schema 改動後）、`npm run db:migrate`（deploy）。
- 本地 dev DB 快捷法（唔想用 compose 嗰個未 publish 嘅 postgres）：
  `sg docker -c 'docker run -d --rm -p 127.0.0.1:15533:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=wa_dev postgres:17.6'`

## 測試

```bash
npm test                    # 全部（unit + integration；hermetic，唔需要 DB/Redis/Docker）
npm run test:unit
npm run test:integration
```

P1 覆蓋（32 tests）：

| 檔案 | 範圍 |
|------|------|
| `tests/unit/rbac.test.js` | 401/403 矩陣、角色階梯、envelope+requestId、未知角色 wiring 時即報錯 |
| `tests/unit/login-flow.test.js` | argon2id（錯密/未知用户/inactive）、audit reason、cookie 屬性、hash-only 落庫、logout 撤銷、expired session、限流 429（連正確密碼都會 429）、body validation |
| `tests/unit/redaction.test.js` | pino redact 路徑覆蓋 + 實測 top-level/嵌套/header 脫敏 |
| `tests/integration/health-ready.test.js` | ready 全組合（docker down=200 degraded、redis/db down=503、disabled、bounded、live 恆 200、無洩密） |

P2 覆蓋（152 tests）：

| 檔案 | 範圍 |
|------|------|
| `tests/unit/docker-error-classification.test.js` | 四類錯誤 + 優先級（404 先、再 permission/daemon-down/timeout）、message 唔帶 status code 唔當 404 |
| `tests/unit/docker-service-core.test.js` | env masking（live finding：`*_URL`/`*_KEY` 過保守 mask）、log demux（8-byte header、撕裂 frame）、managed 規則、§9.3 冪等 op 協議（再 inspect 確認、OPERATION_PENDING）、dead 容器 guard、delete confirm 流 |
| `tests/integration/docker-api.test.js` | 全 app + fakes：RBAC 矩陣、NOT_MANAGED gate、action 冪等、audit-on-daemon-down、list 分頁/過濾/withStats、錯誤 envelope 透傳 |
| `tests/integration/docker-templates-create.test.js` | 模板 allowlist CRUD、image pin 驗證、privileged reason、create 冪等（同 key 回放）、env 白名单、任意 payload 拒絶、例外表 grant/revoke |
| `tests/integration/docker-sse.test.js` | **真 HTTP**（`app.listen` + fetch，唔係 inject）：preamble/headers、事件白名單過濾、torn-frame 稳健、abort→release、並行上限 503、daemon-down 503 — 13 tests |

P3 覆蓋（101 tests）：

| 檔案 | 範圍 |
|------|------|
| `tests/unit/task-run-state-machine.test.js` | 狀態機 transition 表、terminal-only retry、cancel 冪等、approval 生命周期、backoff |
| `tests/unit/tool-registry.test.js` | fail-closed 查找、safety class gate、args schema 驗證（零依賴 subset）、scrub |
| `tests/unit/provider-crypto.test.js` | AES-256-GCM round-trip、壞 key/tamper reject、格式 |
| `tests/unit/scrub.test.js` | boundary-aware 敏感 key 脫敏、depth/node/string cap |
| `tests/integration/task-engine.test.js` | worker engine（fake provider/queue）：agentic loop、tool 執行、approval wait + expire、**cancel 真停（零後續事件）**、timeout `timed_out`、retry 新 attempt 舊輸出保留 |
| `tests/integration/tasks-api.test.js` | 全 app + fakes：create/list/detail/cancel/retry/approvals/tools/providers、**RBAC 矩陣**（401/403/200 逐 cell）、service token 自批 403、**SSE 真 HTTP**（snapshot/cursor resume/done/非法 cursor 400） |

P4 覆蓋（57 tests）：

| 檔案 | 範圍 |
|------|------|
| `tests/unit/schedule-cron.test.js` | IANA tz 驗證（拒壞 tz）、5-field cron 驗證、`nextCronRun` 各 tz 實值、cron 描述 |
| `tests/unit/schedule-service.test.js` | PG-first + `sync_error`（queue down **同 hung** 兩形狀）、stable key upsert 零重複、timezone next_run、pause/resume/modify/delete、run-now 冪等、RBAC、preview、sync retry 503 語義 |
| `tests/unit/scheduler-reconciler.test.js` | boot 建缺索引、漂移原地修（零重複）、orphan 清、**live next-fire job 唔會誤刪**（BullMQ 6 形狀）、past-slot leftover 清、`sync_status` 自愈、converge 冪等 |
| `tests/unit/schedule-fire-handler.test.js` | slot 解析（**真 BullMQ 6 jobId 形狀** `repeat:<key>:<ms>`）、deleted/disabled/stale-generation/stale-slot guard、冪等重送 replay（零重複）、skip_if_running vs queue、once 自動停用、provider disabled = 唔消費 slot |
| `tests/unit/worker-queue-state.test.js` | /health 狀態在 redis 復原後自愈（BullMQ 6 `ready` 只發一次嘅 live bug）、healthy 零 probe、stop 清 probe |
| `tests/integration/schedules-api.test.js` | 真 HTTP 全路徑：RBAC 矩陣、create/list/get、run-now 冪等（HTTP 層 `Idempotency-Key`）、pause/resume、delete、**PG-first `sync_error` → `/sync` → `synced`**、provider disabled 409 |
| `tests/integration/schedules-real-redis.test.js` | **gated**（`TEST_REAL_REDIS=1`）：真 BullMQ 6 Job Scheduler — upsert 原地零重複、tz round-trip、once deterministic job、remove converge |

總計 **343 tests**（P1 32 + P2 152 + P3 102 + P4 57；另 1 gated-skip 需 `TEST_REAL_REDIS=1`）。測試全部 hermetic（fake db/redis/docker），`node --test`（Node 內建 runner，零 test 依賴）。

## 疑難排解

| 症狀 | 診斷 / 處理 |
|------|-----------|
| `docker compose` 要密碼 / EACCES socket | 用 `sg docker -c '…'`，或重開 terminal（group 生效）；**唔好** `chmod 666 /var/run/docker.sock` |
| `WEB_PORT` 佔用 | 改 `.env` 嘅 `WEB_PORT`（compose 會喺 up 時讀）；`ss -ltnp \| grep 3012` 搵誰佔住 |
| api 一直 unhealthy | `sg docker -c 'docker compose logs api'`：多数係 DB/Redis 未 ready（等 `depends_on` 過）或 `.env` 秘密錯（api 會即刻 env 驗證失敗退出） |
| `ready` 503 但 `live` 200 | 看 `ready` body 嘅 `dependencies.*.error`：db/redis 問題查 compose；docker down 唔係 503（degraded） |
| `prisma migrate` 失敗 | 看 api log；migration 衝突 → 唔好手改已 apply 嘅 migration，新建 migration；`migrate status` 查漂離 |
| 忘記 admin 密碼 | 無 reset 路徑（設計如此）：`down -v` 重置，或直接 DB 改 `users.password_hash`（先用 `node -e` 生成 argon2id hash） |
| web 開到但登入 404/502 | api 未 healthy（`compose ps`）；web 反代上游 `http://api:3000` 唔通 |
| 重建後行为異常 | `down -v` 係唯一徹底法；`down`（唔帶 -v）會保留舊 volume |
| 改咗 schema 但容器內未生效 | `prisma generate` 喺 **build 時** 跑（api.Dockerfile production stage），`migrate deploy` 喺 **每次啟動** 跑（entrypoint）。schema 改動要 `docker compose up -d --build api` 重建，唔係重啟 |

## 版本鎖定

全部關鍵依賴版本鎖定表：`docs/architecture-decisions.md` §版本鎖定（P0 交付）。
改版本 = 先過 ADR 流程，唔好直接 bump。

## Roadmap（P0 已完成）

| 階段 | 範圍 | 狀態 |
|------|------|------|
| P0 | Repo + docs + 版本鎖定 | ✅ |
| **P1** | **Skeleton + Deployment（本 commit 系列）** | ✅ |
| P2 | 容器核心（DockerService 全套、API、模板 allowlist、Web UI 兩頁、SSE） | ✅（live daemon 實測過，2026-10-14） |
| P3 | AI 任務引擎：providers（AES-256-GCM 加密 key）+ task queue + tool registry + approval gate + Web UI | ✅（live 實測 2026-10-15，全循環 DB+SSE 實證） |
| P4 | 排程（schedules → BullMQ 6 Job Scheduler，PG-first）+ Web UI | ✅（live 實測 2026-10-15，7 項硬驗收全過；通知留 P5+） |
| P5 | Settings 頁面 + 用户管理 + audit 檢視 | 待開 |
| P6 | 收尾：e2e、docs、security review | 待開 |
