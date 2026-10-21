# water_army

Docker 容器 + AI 任務自動化平台（**7 階段 MVP 全部完成** — P0–P6 ＋ security patch ＋ Redroid 實機矩陣 Stage A/B ＋ **網絡修復鏈 R0–R7** ＋ **Batch Rotation BR-B1–B6**；本 README = P6 最終版 + 2026-10-19 更新 + 2026-10-21 R7 文檔同步 + **2026-10-22 BR-B6 收口**）。
本地單一部署：一個 UI、一個 API、一個 worker、Postgres 17、Redis 7，全部跑喺同一部主機嘅 Docker 入面。

- **api** — Fastify 5：auth（argon2id + session cookie）、RBAC、health、容器 API（P2）、AI 任務/批准/provider 管理 API（P3）、排程 API（P4）、Redroid device API（P5）、dashboard + 排程通知（P6）
- **worker** — BullMQ worker：容器任務（P2）＋ AI 任務執行引擎（P3：agentic tool loop、approval gate、timeout/cancel/retry、concurrency gate P6）＋ scheduler reconciler + 排程通知 writer（P4/P6）。**無 Docker socket** — 容器操作全部經 api service token
- **web** — React 19 + Vite 8：Dashboard（實數據 counters，P6）、Containers（P2）、AI task runs list/detail（P3）、Schedules（P4）、Redroid devices（P5）、Settings（P5+）、notification bell（P6）、SSE reconnect backoff（P6）
- **postgres / redis** — 只在 compose 內部網絡，**唔 publish host port**

施工依據：`docs/repo-audit.md`、`docs/architecture-decisions.md`（P0–P6 全 ADR）、`docs/build-checklist.md`、`docs/threat-model.md`（P6 最終版）、`docs/api-reference.md`（全 endpoint 總表）、`docs/runbook.md`（運維；§9.5 = Redroid Stage A 已知行為、§10 = Stage B 出口代理運維）。

**P6 交付摘要**（證據：`docs/evidence/p6-e2e/`、`docs/evidence/p6-security/`、`docs/evidence/p6-cleaninstall/`）：
- 5 個 P3–P5 留底 flag 全部收結（managed exception 表 / compose label / 排程通知 / flaky 根因 / concurrency gate）
- Playwright E2E 14/14（真 headless Chrome + 真 worker，捉到 5 個真 UI bug 全修）
- 安全：npm audit ×3 = **0 高危**（override 修復 + 驗證鏈）、secret redaction 17/17 實打、審計抽驗、threat-model 最終版（T1–T7）
- 測試：465（464 pass + 1 env-gated real-redis，已對真 redis 實跑綠）+ vite build clean
- clean install 實跑（`down -v` → README 由零起 → 5/5 healthy → 首 admin → 登入 200）

**P6 之後更新（2026-10-19）**（本 README 已反映以下三批合併）：
- **Security patch**（`27cc558`）：SSRF guard（provider baseUrl → 400 `BLOCKED_URL`）＋ per-account 登入限流（rate key = 客戶端 IP × 帳號）＋ proxy anti-spoof ＋ `trustProxy` — 見 §安全模型
- **Stage A Redroid 實機矩陣**（`f8e2986`/`cf6b2d9`）：本機真 host boot（kernel 6.8 + RTX 3090，redroid 14.0.0-240527 → `boot_completed=1`／ADB `device`／SDK 34／boot 後 18+ 分鐘零 crash）、preflight memfd 語義 + containerized vantage、容器內 binderfs wrapper image（`docker/redroid-matrix/`）、root host setup script（`scripts/redroid-host-setup.sh`）— 見 §Redroid 實機矩陣
- **Stage B per-device egress proxy**（`18f8139`/`ffe800f`/`bd88571`/`351983a`）：per-device gost container（digest pin）＋ tun2socks v2.7.0 bake 入 wrapper image、port 段 20080–20179、`proxyUrl` 加密 data model — 見 §Per-device egress proxy
- 測試套：465 → **492**（491 pass + 1 env-gated skip，0 fail）→ BR-B1–B6 收口後 **1054**（1053 pass + 1 env-gated skip，0 fail）

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

### 資料備份 / 還原（2026-10-15 實測流程；詳細版 + 冷備份 + key 輪替見 `docs/runbook.md` §3）

```bash
# 備份（logical dump，運行中可做；含 provider 密文 + 密碼 hash — 備份檔要 chmod 600）
sg docker -c 'docker compose exec -T postgres pg_dump -U app water_army' > wa-backup-$(date +%F-%H%M).sql

# 還原（目標 DB 應係空；實測：dump 732KB → 全新 DB → 14 表 row count 全對 + 密文 v1: 前綴 intact）
sg docker -c 'docker compose exec -T postgres psql -U app -d water_army -v ON_ERROR_STOP=1' < wa-backup.sql
sg docker -c 'docker compose restart api worker'   # entrypoint migrate 核對 + reconciler 重建 queue 索引
```
- 還原入唔係空嘅 DB 會 PK 衝突（要 `pg_dump --clean` 或先清目標）。
- 實測證據：2026-10-15 gen2 — 14 表逐表核對全對（users 3 / task_runs 260 / task_run_events 1600 / sessions 128 / audit 284 / …），scratch DB 還原後已 drop。

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

## API

Base：`http://127.0.0.1:3012/api`（web 同源性代理；API 本體唔 publish host port）。
**全 endpoint 總表（method/path/role/參數/錯誤碼，68 條路由）：`docs/api-reference.md`** — 以下係分 phase 導讀。

| Method | Path | 說明 | Auth |
|--------|------|------|------|
| GET | `/health/live` | process 存活（200；唔查依賴） | 無 |
| GET | `/health/ready` | DB/Redis/Docker 逐項。docker down → **200 degraded**（worker 可稍後重啟 api）；db/redis down → **503** | 無 |
| POST | `/auth/login` | `{username,password}` → 200 + `Set-Cookie: session=…`（HttpOnly, SameSite=Lax）。失敗 401 INVALID_CREDENTIALS（唔洩露用户存在）；限流 429 RATE_LIMITED（5 次失敗/60s/**客戶端 IP × 帳號**，只計失敗 — per-account，2026-10-19 security patch） | 無 |
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
| GET | `/templates` | 容器 template allowlist（image 必 pin；P2–P6 無 template 修改/刪除端點 — 見已知限制 K5） | 讀 viewer+；寫 admin |
| POST | `/containers` | 由模板建容器：`{templateId, displayName, idempotencyKey, env}` — env 只准模板白名单 key（值任意）、無任意 Docker payload；冪等（同 key 回放 = 201 + `idempotent-replay: true`，唔建第二個）；container 帶 `app.managed/app.template/app.idempotency-key/app.created-by` labels | operator+ |

錯誤分類（四類，見 `packages/shared` `DOCKER_ERROR`）：`CONTAINER_NOT_FOUND`(404)／`DOCKER_DAEMON_UNAVAILABLE`(503)／`DOCKER_PERMISSION_DENIED`(502)／`DOCKER_TIMEOUT`(504)／其餘 `DOCKER_ERROR`(502)。`NOT_MANAGED`(403) = managed gate；`NAME_TAKEN`/`FLOW_TOKEN_REUSED` 等 = 路由層 409/400。

**P3 起已接**：`/tasks`（list + detail）。**P4 已接**：`/schedules`。**P5 已接**：`/devices`（Redroid devices list + detail 診斷頁）— 見 `docs/architecture-decisions.md`。

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
| GET | `/schedules/preview` — **實為 POST**（body `{cronExpression, timezone?}`） | cron 預覽（next 5 次 run + 人類可讀描述，纯計算） | viewer+ |
| GET | `/tasks/definitions` | task definition 只讀 list（Schedules UI 用；definition 的寫入唔喺 P4 範圍） | viewer+ |

**排程執行拓撲**：PostgreSQL 係唯一 source of truth；BullMQ Job Scheduler 係 derived index（隨時可由 worker reconcile 重建）。worker boot 時 + 每 5 分鐘跑 **scheduler reconciler**（PG desired-state → 原地 upsert 漂移、清 orphan、自愈 `sync_status`）；fire job 由 **schedule fire handler** 處理：重讀 DB row → guard（已删/停用/stale generation/stale slot）→ 冪等建 run（`idempotencyKey = sched-<uuid>-<slotMs>`，重送 = replay 零重複）→ overlap policy → 推進 `next_run_at`。once 排程 = 确定性 id 嘅 delayed job（`schedonce-<uuid>-<slotMs>`），fire 後自動停用。

**每排程獨立 timezone**：`next_run_at` 用排程自己嘅 IANA tz 計算（預設 `Asia/Taipei`）— cron 表達式按該 tz 解讀，`task_runs.input_json.scheduledSlotAt` 存實際 slot。

**overlap policy**：`skip_if_running`（預設）= slot 撞 active run → 建 terminal `skipped` run（帶 `activeRunId` lineage，slot 照消費、唔重試）；`queue` = 照建新 run（執行並行 — `concurrency_key` 喺 P6 已有執行邏輯，見下面 P6 節）。

**web UI**：Schedules 頁（list + create/edit dialog + pause/resume/run-now/sync-retry/delete + next/last run 顯示 + `sync_error` 旗標），RBAC 按 role 啟停 action。

**live 實測（2026-10-15，compose stack）**：cron 1 分鐘 2 次 fire ✓ / interval 30s + pause 後靜音 ✓ / once 自動停用 ✓ / 重啟 reconcile 2 輪 `getJobSchedulers` 數量 = DB enabled 且零重複 ✓ / skip_if_running 建 skipped run（activeRunId 實指）+ queue 建 run 唔 skip ✓ / redis down → `sync_error` → 503 → 復原後 `/sync` 200 ✓ / run-now 冪等（同 key 同 run）✓ — 詳情 ADR §13。

## 安全模型（T1 威脅）

- **Docker socket 隔離**：只有 `api` 掛 `/var/run/docker.sock`（read-only）；worker/web 無。worker 執行容器經 api（P2）；P3 嘅 AI tool 同樣只經 api（service token，worker 零 socket）。
- **Service token**：`WORKER_API_TOKEN`（api + worker 同值 env）— worker→API 嘅機器身份，operator 權限、固定 UUID、audit 可辨（`actor: service:worker`）。**批准流永遠排除 service token**（`requireHuman` guard）— AI 唔可能自批自己嘅 tool call。
- **網絡**：postgres/redis 零 host port；web 只綁 `127.0.0.1:3012`；api 零 host port（只經 web 反代）。
- **容器硬化**：所有服務 `read_only: true`（必要目錄 tmpfs）+ `no-new-privileges` + `cap_drop: ALL` + log rotation（10m × 3）。
- **Auth**：argon2id；session token 唔落 log、DB 只存 SHA-256；HttpOnly + SameSite=Lax cookie；未知 username 用 dummy hash 對齊 timing（防用户枚舉）；login 限流（失敗計數，**per-account** = 客戶端 IP × username — 單一帳號被 flood 唔會 lock out 其他帳號，2026-10-19 security patch）。
- **Proxy anti-spoof + trustProxy**（2026-10-19 security patch）：web 反代**覆寫** `X-Forwarded-For`/`X-Real-IP`/`Forwarded` 為真 socket peer（client 送嘅全數 discard）→ api `trustProxy`（預設開；api 直接暴露無 proxy 先設 `TRUST_PROXY=false`）→ `req.ip` = 真客戶端 IP → per-client 限流先有效（否則所有請求都似由 proxy IP 嚟，一個 flooder 可以 lock out 成個 deployment）。
- **SSRF guard — provider baseUrl**（2026-10-19 security patch）：`POST/PATCH /providers` 寫入時 ＋ `/providers/:name/test` fetch 時雙重檢查（defense in depth）— 拒非 http(s) protocol；block loopback／private（10/8、172.16/12、192.168/16、fc00::/7）／link-local（169.254/16，含 169.254.169.254 雲 metadata）／CGNAT（100.64/10）／benchmarking 等保留段；拒保留 host 名（`localhost`/`*.localhost`/`*.internal`/`*.local`）；DNS 名會 resolve 並對每個解出地址做 range check（無 outbound DNS 嘅環境可以 `PROVIDER_URL_DNS_CHECK=false` opt-out — literal + host-suffix 檢查照樣生效）→ 400 `BLOCKED_URL`。效果：admin session 即使被攞走，都唔可以再 API/worker 打向內部服務或雲 metadata endpoint。
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
# env-gated real-redis 測試（真 BullMQ Job Scheduler）— disposable redis 即起：
sg docker -c 'docker run -d --rm --name wa-test-redis -p 127.0.0.1:16379:6379 redis:7.4.5'
SCHEDULES_REDIS_URL=redis://127.0.0.1:16379 node --test tests/integration/schedules-real-redis.test.js
```

**CI（GitHub Actions，R7 新建 — `.github/workflows/ci.yml`）**：每次 push 跑 5 個 job，全綠先算綠：
`npm ci`（lockfile 一致安裝）＋ 全 hermetic suite（Node 24，`engines >=24`）＋
**real-redis gated test 真跑**（redis:7.4.5 service — skip 唔好當覆蓋，ADR §15.8 rule 3）＋
compose config validation＋ vite prod build＋ docker image build（api/web/worker）＋
redroid-matrix image build（**R1 pin + sha256 fail-fast 每次 push 真驗**）＋ gitleaks 全 history
secret scan ＋ tracked-.env check。近期全綠 run 範例：
`actions/runs/39499318028`。

**CI 唔跑嘅（誠實邊界，唔可以偽裝）**：真 Redroid/GPU 測試（要 binderfs + binder + GPU host =
本機 3090；`scripts/redroid-host-setup.sh`）同 Playwright E2E（要 live compose stack + system
Chrome）— 全部 **manual / self-hosted**，實錚證據喺 `docs/live-evidence/`（r3/r4/r5）+
`docs/p5-evidence/`；執行方式 + 隔離紀律（`redroid-matrix-<ticket>-*` 命名、16xxx 口、用完全拆）
見 `docs/audits/redroid-host-validation.md` + runbook §10。lint/typecheck = N/A（plain ESM JS，
無 eslint/biome/TS）；常規 static guard 喺 suite 內（`patch-default-guard`、`redroid-t2s-pin`）。

> dev flake 口徑：vite/next 系 dev server 嘅 manifest race（500 冇 request log 行、堆棧見
> `loadManifest`/`getNextFontManifest` 樣式）= **已知 flake，非 code bug — 重跑即好**；本 repo web =
> Vite，prod 係 static build（CI 每次 push 真 build 綠）— 生產路徑無此 flake（runbook §5）。

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
| `tests/integration/schedules-real-redis.test.js` | **gated**（`SCHEDULES_REDIS_URL`/`REDIS_URL` 指住 live redis）：真 BullMQ 6 Job Scheduler — upsert 原地零重複、tz round-trip、once deterministic job、remove converge |

總計 **343 tests**（P1 32 + P2 152 + P3 102 + P4 57；另 1 env-gated real-redis 測試，`SCHEDULES_REDIS_URL` 設定先跑）。測試全部 hermetic（fake db/redis/docker），`node --test`（Node 內建 runner，零 test 依賴）。

### P5 Redroid Devices API（已交付 — live 實測 2026-10-15，證據 `docs/p5-evidence/`）

受控 Redroid Android 設備層：device 只可經 **Redroid template** 建立（client 傳唔到任何
Docker HostConfig）；`androidboot.*` 做**容器啟動參數**（唔係 Env）；ADB 5555 只綁
**127.0.0.1**；診斷 = 白名單 3+2 op（getprop/dumpsys/logcat + connect/get-state）固定命令、
參數陣列、逾時、輸出 cap；GPU 狀態誠實（DeviceRequests ≠ verified — P5 無 in-device
render check，host 模式 = `unverified`，swiftshader = `software`）。

| Method | Path | 說明 | Auth |
|--------|------|------|------|
| GET | `/redroid/preflight` | 真主機檢查（kernel modules / device nodes / dmesg / docker / data root）；三態 `supported\|unsupported\|unknown` — 讀唔到 = unknown，嚴禁假報。**api 容器視角**：host `/dev` 狀態報 `unknown`（永唔假報 absent）— **host-level preflight 係權威**（見 §Redroid 實機矩陣） | viewer+ |
| GET/POST/PUT/DELETE | `/redroid/templates[/:id]` | Redroid template CRUD：image **pin 死**（latest/nightly 拒）、`privileged` 只可 admin 建 + reason 標籤 10–200 字、Stage B：`proxyUrl`（fleet 出口，socks5 only，加密落庫、view 永不回傳） | 讀 viewer+；寫 admin |
| POST | `/devices/redroid` | 由 template 建 device：`{name, templateName, idempotencyKey, overrides?{width?,height?,dpi?,fps?}, proxyUrl?}` — body 冇任何 Docker 欄位（注入 = 400）；`proxyUrl` = device 級出口 override（省略 = 跟 template）；缺 image = 404 `IMAGE_NOT_FOUND`；response 帶 preflight（warning，唔係 fail-closed） | operator+ |
| GET | `/devices/redroid[/:id]` | list / detail（name/pinned image/Android 版本/`127.0.0.1:<port>`/容器狀態/ADB 狀態/解析度/DPI/FPS/GPU 健康/`dataDir`/`proxy`（configured/gostPort/state/hasUrl/binaryState/binaryVersion/network — URL 永不回傳）/最後診斷時間） | viewer+ |
| POST | `/devices/redroid/:id/start\|stop\|restart` | 生命週期（P2 action protocol：inspect→op→confirm；container 消失 = `missing` + 409，誠實唔假報） | operator+ |
| POST | `/devices/redroid/:id/refresh` | 輕量重查 daemon + ADB 狀態（唔重跑全套診斷）；`adbError` = engine 級失敗碼（`ADB_UNAVAILABLE`/`ADB_TIMEOUT`）— engine 跑唔到時 `adbState='unknown'`（永唔假報 offline） | operator+ |
| POST | `/devices/redroid/:id/diagnostics` | **5 個獨立結果區**（kernel / container-logs / adb-connectivity / gpu-verification / network），每區 `executed` + `status` — 未執行 = `未驗證`，從無假 pass；adb 區 engine 失敗 = `error` + 碼（唔係 offline）；recreate-stall signature = `suspectedHostProtocolStall:true`（runbook §10.7） | operator+ |
| GET | `/devices/redroid/:id/logcat?tail=` | 白名單 logcat（server 永遠加 `-d -t <n>`）；tail clamp 到 `REDROID_LOGCAT_TAIL_MAX`（5000）；`truncated`（byte cap）+ `mayHaveMore`（window 披露） | operator+ |
| DELETE | `/devices/redroid/:id` | 兩步 confirm（type name）；`removeData=true` 先 rm device data dir（realpath-scoped）；container 先除、data 預設保留；data 清除失敗 = 部分失敗（照 200 + `dataRemoved:false` + 穩定碼 `DATA_DIR_PERM_DENIED` 等） | admin |

**無 `POST /exec` 端點**（任意命令 = 404）；冇 `shell:true`；ADB binary 固定路徑。

P5 覆蓋（80 tests：unit 33 + integration 47）：

| 檔案 | 範圍 |
|------|------|
| `tests/unit/preflight.test.js` | 真三態邏輯（absent/present/unknown）、dmesg cap、hung subprocess timeout、GPU informational-only、port probe |
| `tests/unit/adb-whitelist.test.js` | 精確 argv 構造、allowlist 拒絕、注入（`;`/`$(`/反引号/非 loopback target）、logcat 嚴格整數 + cap、固定 binary + 無 shell、非零 exit 透傳、byte 截斷 + truncated、timeout |
| `tests/unit/redroid-seed.test.js` | seed 冪等 + template 形狀（pin、privileged reason） |
| `tests/integration/redroid-lifecycle.test.js` | RBAC 401/403 矩陣、image pinning 拒、privileged reason、create 形狀斷言（錄到嘅 docker call：HostIP 127.0.0.1 / Cmd androidboot.* / Env 空 / `/data` bind / DeviceRequests 只 host）、0.0.0.0/privileged/hostConfig 注入 400、冪等、name 409、**真 127.0.0.1 碰撞 → next port + 用盡 503**、全生命週期 + audit、delete confirm + data dir 保留/清除、`/exec` 404、template in-use 409、disabled template 409、mock honesty 標籤 |
| `tests/integration/redroid-diagnostics.test.js` | 5 區獨立性 + executed/status 矩陣（kernel/container-logs/adb/gpu/network）、host→unverified、swiftshader→software、stopped→adb 未執行=未驗證、offline + 单次 connect、logcap default/explicit/**server-side clamp** + byte-cap 截斷、RBAC、boot-crash device 誠實 `created` |
| R6 新增（§8 施工） | `tests/unit/patch-default-guard.test.js`（repo 級 PUT/PATCH body 無 `default:` 守門 + scanner 自測）／`tests/unit/docker-error-classification.test.js`（`IMAGE_NOT_FOUND` 分級 + R5 live 訊息形狀 pin）／`tests/integration/redroid-error-contract.test.js`（缺 image 404 + rollback 誠實、refresh `ADB_UNAVAILABLE`、diagnostics engine 失敗 `error`、`TUNNEL_SETUP_FAILED` 持久化）／`tests/unit/redroid-data-dir-remove.test.js`（path/symlink guard + `DATA_DIR_PERM_DENIED` 等穩定碼）／`tests/unit/redroid-boot-timeout-config.test.js`（40min 校準 pin） |

全套 **627 tests**（CI-equivalent clean checkout：Node 24.22.0 + redis:7.4.5 = 627 pass / 0 fail / 0 skip；本地 quick run 無 redis = 1 env-gated skip）— 截至 R7（2026-10-21）。歷史：P5 收 423 → P6 加 42 = 465 → 2026-10-19 +27 = 492 → 修復鏈 R0–R6 +71（net state machine / net health watchdog / R4 consistency+payload contract / R5 resource limits / R1 t2s-pin / R6 error contract + patch-default-guard + boot-timeout）→ R7 +2（poll knob）+ config test 隔離修復 = **627**。

**修復鏈 R0–R6 新增覆蓋**（MD §10 驗收面）：

| 檔案 | 範圍 |
|------|------|
| `tests/unit/redroid-net-state-machine.test.js` | 7 狀態合法轉移矩陣、HEALTHY 唯一入口證據校驗（no blind HEALTHY）、legacy 投影保守性 |
| `tests/unit/redroid-net-checks.test.js` | netcheck read-only builder/parser、definite-loss 分類、canary builder/nonce/parser、recovery backoff 指數+cap、lock contention = WAIT、max retry → FAILED、stall 小預算、payload 契約（stale = 唔健康） |
| `tests/integration/redroid-net-health.test.js` | MD §5.6 十項故障注入（hermetic）：operator stop / kill t2s 立即 BLOCKED / proxy leg 死 / gVisor stall 預算 / recovery lock / soft 路徑 3 次 → FAILED+manual / stale HEALTHY / 無 canary target = 永唔 HEALTHY / operator stop 後 restart 重走 provision |
| `tests/integration/r4-state-consistency.test.js` | §6.4 四項：process+canary / dns+tcp / stale expiry / live-view 契約（worker+UI 一致、零 secret）+ 重啟 process 唔可以假推 BLOCKED→HEALTHY |
| `tests/unit/r4-payload-contract.test.js` | `NET_PAYLOAD_KEYS`/`NET_CHECK_KEYS` 三邊界契約 lock（drift = test 爆） |
| `tests/integration/redroid-resource-limits.test.js` | cpuLimit/memoryLimitBytes（R5）+ PATCH absent-stays-absent（clobber regression） |
| `tests/unit/redroid-t2s-pin.test.js` | tun2socks pin 兩邊（env 檔 ↔ service PIN）靜態同步 guard（R1） |

### Redroid 實機矩陣（Stage A — live 實測 2026-10-19，`f8e2986`/`cf6b2d9`）

P5「mock 驗證主路徑」升級為**真機 boot**：本機（kernel 6.8.0-117-generic + RTX 3090）`redroid/redroid:14.0.0-240527`（dated pin）boot 到 `sys.boot_completed=1`、ADB `device`、SDK 34、3 條 shell 實測、**boot 後 18+ 分鐘零 crash**（boot 頭 13 秒有 5 個一次性 service crash，自癒 — runbook §9.5，唔好當新 bug）。

- **容器內 binderfs wrapper**（`docker/redroid-matrix/`，image `water-army/redroid:14.0.0-240527-matrixa`）：靜態 C entrypoint（`redroid-binder-init`）— 容器內 mount **private** binderfs → `BINDER_CTL_ADD` 建 binder/hwbinder/vndbinder → `chmod 0666`（6.8 control 建嘅節點預設 0600，Android uid 1000/1002 service 打唔到 → 必改）→ bind mount → 照原 exec `/init`。**host 完全唔郁、完全可逆**（binderfs 每個 mount 有獨立 device set — 容器內建嘅節點唔會 propagate 返 host）。冇 wrapper 嘅原版映像喺呢部機 ~1 秒 abort（host `/dev/binder` 係 binderfs 目錄，Android libbinder 當 character device 開）。
- **host 前置**（root、一次性、**冪等**、undo 命令喺 script header）：`sudo bash scripts/redroid-host-setup.sh` — ① `modprobe binder_linux` + `/etc/modules`（每次 boot 自動載入）② binderfs mount 上 `/dev/binder` + `/etc/fstab`（`x-systemd.requires=binder_linux.module` 保證 module 先 mount）③ `mkdir /var/lib/water-army` + `chown 1000:1000`（api 容器用戶）。**次序重要：先跑 script 先 `compose up`** — 否則 docker root:root 自動建 → device create 永遠 500 `REDROID_DATA_DIR_ERROR`（Stage A 實測）。重啟 host 後乜都唔使做（module/fstab 已持久化，runbook §9.4）。
- **kernel 6.x 唔使 ashmem**：`ashmem_linux` 上游已移除、`memfd_create` 取代；preflight 改做「binder present +（kernel <3.17 → 要 ashmem present｜≥3.17 → memfd 可用）」= supported（redroid 14 無 ashmem boot — 真 boot 驗證）。
- **GPU host mode**：本機實 boot 行 `gpuMode: 'host'`（DeviceRequests / RTX 3090；consumer card 風險係 MD §2.4 預期，記錄喺 runbook §9.5）。template `gpuMode` = `host` | `swiftshader_indirect`（預設）；GPU 狀態誠實唔變：host = `unverified`（無 in-device render check）、swiftshader = `software`。
- **preflight 視角**：`GET /api/redroid/preflight`（viewer+）係 **api 容器視角** — 容器睇唔到 host `/dev`，嗰啲節點狀態報 `unknown`（**永唔假報 absent**）；**host-level preflight（host 上直接 call preflight module）係權威**（Stage A 實測 `overall: supported`）。
- **ADB port 段**：`15000–15999`（`REDROID_ADB_RANGE_START/END` 可覆寫）；DB unique + 真 127.0.0.1 bind probe + 碰撞重試 + 用盡 503（P5 機制；Stage A 實機分配喺段內）。
- **已知缺口 — removeData 後 root-owned 殘留**：per-device `/data` 內容由 redroid 容器**以 root** 寫入（容器內 root，bind mount 無 uid remap）→ api service（uid 1000，非 root）`removeData=true` 清唔到 root-owned 檔案 → `dataRemoved: false` + `dataRemoveError`，data 目錄 skeleton 留喺 host（要 root 層清理，backlog 項 — 見已知限制 K13）。

### Per-device egress proxy（Stage B — live 實測 2026-10-19，`18f8139`/`ffe800f`/`bd88571`/`351983a`）

**架構（per-device 隔離）**：
- 每部有 proxy 嘅 device 配一個 **per-device gost container** `redroid-matrix-b-gost-<devName>`：image = `gogost/gost@sha256:f7a958c451928fbe1b99046d25bd0c9bf42019d4c60a82200f50dc8e617b7580`（digest pin），bind **`172.17.0.1:<gostPort>`**（唔係 127.0.0.1、都唔係公網），`Cmd: [start, -L, socks5://:1080, -F, <proxyUrl>]` + `Env: []`（credentials 只喺 Cmd — docker host 係 trust boundary）。
- port 段 **20080–20179**（DB unique；碰撞 = 重試重分配）。
- device 內 **tun2socks v2.7.0**（linux-amd64 static ELF，sha256 `98d545a6…c031`，bake 入 wrapper image `/data/local/tmp/tun2socks`）起 `tun0`（10.8.0.1 ↔ 10.8.0.2）→ 全部出域流量（DNS UDP + TCP + UDP）經 tun0 → SOCKS5 → gost → 上游 proxy；DNS 明指向 tun peer（10.8.0.2）。
- 路由：table 100 = `default via 10.8.0.2 onlink` + **gateway exception** `172.17.0.1 dev eth0 scope link`（**唔可以省** — 缺咗佢 gVisor→gost handshake hairpin 返 tun0 → RST，**proxy 零流量但 routing 睇落「正常」** — runbook §10.5 #2）+ rule 5000（netd 唔認 ioctl 建嘅 TUN，script 有 EEXIST-safe 兜底）。
- provisioning：gost **同步**（create 時起；失敗 = 連 device 一齊 rollback）；tunnel **背景**（等 `sys.boot_completed`，poll = `REDROID_TUNNEL_POLL_MS`（default 5s，R7 新 wire）；timeout = `REDROID_TUNNEL_BOOT_TIMEOUT_MS` default **40min** — R5 live 校準：真 fresh cold boot ~24min、RECREATE ≈ cold boot，舊 600s default 會 hard-fail 健康但慢嘅 boot）；netd-safe 序列（netd 間中 block RTM_NEWLINK → tun0 由 tun2socks 自己經 ioctl 建 — 兩路都實錚過）。

**API / data model**：
- template `proxyUrl`（fleet 出口，可選，只收 `socks5://[user:pass@]host:port`）＋ device 級 `proxyUrl` override（create body；省略 = 跟 template）。
- 加密落庫（`proxyUrlEncrypted`，AES-256-GCM `v1:` 前綴 — 同 provider key 同一模式）；**明文永不入 DB / API response / audit** — view 只出 `proxy: {configured, hasUrl, gostPort, gostBind, state}`（`state` = `off|provisioning|running|stopped|error`）。

**實錚狀態 + 誠實披露（2026-10-19，2 device 2 路）**：
- ✅ **DNS 100% 經 proxy**：dev1→mock1（20082）/ dev2→mock2（20084）獨立路 — canary `canary.example` NOERROR + A 記錄、`other.example` NXDOMAIN 負例、每個 mock 只見到自己嗰部 device 嘅源 IP（路由隔離成立）。
- ✅ **產品鏈 TCP data-plane 成立（live 實錚 + 常規 gate）**（R3/R4，2026-10-20）：雙向 TCP payload canary（**nonce + sha256 回顯**，latency ~1s）行完整真鏈 device kernel → tun0 → tun2socks → gost 容器 → upstream → canary echo（`docs/live-evidence/r3-20261020/` + `r4-20261020/`）；watchdog 每 30s（`REDROID_HEALTH_POLL_MS`）重跑同一條 canary，HEALTHY 唯一入口 = fresh canary PASS（no blind HEALTHY）— 任何 data-plane 回歸 = DEGRADED→BLOCKED（實錚 3s 內）。**誠實邊界**：R2 spike 拓撲（t2s 第一跳 = 裸 mock relay，**無 gost**）曾實錚 forward-stall（SYN 過 payload 唔過）— 機制根因未完全裁定（restapi instrument 未做）；產品**唔存在**裸第一跳配置（gost 永遠係第一跳）→ 現行 fleet 無影響；若日後引入非 gost 第一跳拓撲，**必須重跑 R2 八層矩陣**（`docs/audits/tcp-transport-investigation.md` R7 addendum）。
- ✅ **fail-closed（平台層）已實錚；kernel 層殘留風險已 decide-and-document**（R3/R4 實錚 + R7 決定）：tunnel 死/canary 死 → watchdog **立即**將 `netState` 置 BLOCKED（kill -9 實錚 +2s；definite loss 唔候 threshold）或 DEGRADED→BLOCKED（soft，threshold 2）；max retry（3）→ FAILED + manual door；worker 網絡任務 gate = `networkReady` → BLOCKED/FAILED 期間**唔派發**依賴網絡嘅任務；UI 文字 badge + 審計全透明（`docs/audits/fail-closed-validation.md`）。**殘留（誠實項）**：tunnel 死後 Android app **kernel 層** egress（app 自己開 socket）會隨 routing shadow 消失而可經 eth0 直連 — 平台層 BLOCKED 唔阻斷佢。R7 決定：唔實裝 netns iptables 兜底（Android netd 擁有容器 netns 規則、互踩風險 + 容器 iptables 係阉割版 — 需獨立 spike + ADR，backlog P0 單）；operator 守則 = BLOCKED/FAILED 期間視設備 egress 為 untrusted（runbook §10.7）；見 K12。

**運維指針**：正常狀態驗證 / 故障排檢 / teardown / 已知環境行為 → `docs/runbook.md` §10。

### P6 覆蓋（42 tests：unit 19 + integration 23 — git diff 8eaa81d..HEAD 實計）

| 檔案 | 範圍 |
|------|------|
| `tests/unit/docker-service-core.test.js`（+4） | flag#1：list/inspect 帶 granted exception → managed=true、filter totals flip（2/1→3/0）、label-only 保持 |
| `tests/integration/docker-api.test.js`（+4） | flag#1 e2e：grant → list/inspect managed → revoke → 還原 |
| `tests/unit/schedule-notifier.test.js`（+11，新檔） | flag#3：terminal run → 通知行（succeeded/failed/timed_out/skipped）、P2002 no-op、failure non-fatal、lastStatus 回填 |
| `tests/integration/schedule-notifications-api.test.js`（+8，新檔） | flag#3 API：RBAC（401 全四路 / viewer 讀 ✓ / viewer mark-read 403 / operator read-one/read-all ✓）、flow、404、limit clamp |
| `tests/integration/task-concurrency-gate.test.js`（+7，新檔） | flag#5：7 個 gate scenario（defer 15s / 超 cap 10 → 可視化 skip / holder 完續跑 / queued 唔 block / cancel_requested 唔 block / 非 queued no-op / 迟到 gate 唔復活 terminal） |
| `tests/integration/dashboard-summary.test.js`（+4，新檔） | P6 dashboard：401、real shape 斷言、Docker down 降級唔 500 |
| `tests/unit/task-utils.test.js`（+3） | flag#5 UI model：skipped = terminal、warn tone、唔可 cancel/retry |
| `tests/unit/redaction.test.js`（+1） | service token header redact（P6 T7 defense-in-depth） |
| `tests/unit/schedule-service.test.js`（修正） | flag#4：delay 斷言 deterministic（slot anchor 喺 createdAt）— flake 根因修復（ADR §15.3） |

**P6 測試總數：465 tests**（464 pass + 1 env-gated real-redis skip，0 fail；gated 測試已對真 redis 實跑 1/1 綠 — 見上面 §測試 gate 命令）+ vite build clean。另：**Playwright E2E 14/14**（`e2e/p6-e2e.mjs`，見 P6 節）+ **secret redaction 17/17**（`e2e/secret-redaction-e2e.mjs`，證據 `docs/evidence/p6-security/`）。

### 2026-10-19 更新覆蓋（27 tests：security patch 11 ＋ Stage A 4 ＋ Stage B 12）

| 檔案 | 範圍 |
|------|------|
| `tests/unit/url-guard.test.js`（8，新檔） | SSRF guard：protocol 白名單（http/https only）、block ranges（loopback/private/link-local/CGNAT/169.254.169.254 metadata/benchmarking/IPv6）、保留 host 名（`localhost`/`*.localhost`/`*.internal`/`*.local`）、DNS resolve + 逐地址 range check、IPv4-mapped IPv6 正規化、`skipDns` opt-out |
| `tests/unit/login-flow.test.js`（+2） | per-account rate key：同 IP 唔同帳號互唔 lock out；單帳號 flood 只限自己（其他帳號照登入） |
| `tests/integration/tasks-api.test.js`（+1） | provider create/patch 400 `BLOCKED_URL`（SSRF guard 路由層整合） |
| `tests/unit/preflight.test.js`（+4） | memfd 取代 ashmem（kernel ≥3.17 無 ashmem = supported）、kernel <3.17 仍要 ashmem、containerized vantage 嘅 /dev 狀態 = unknown（永唔假 absent）、unparseable kernel = unknown |
| `tests/integration/redroid-proxy.test.js`（12，新檔） | pure builders（socks5-only URL parse / gost body：digest pin + 172.17.0.1 bind + 空 Env + port range 強制 / tunnel script exact match + state machine frozen）＋ template CRUD（`v1:` ciphertext 落庫 / view masked / patch 換與清 / malformed 400）＋ device（繼承 template proxy / device override 贏過 template / no-proxy = 零 gost 零 exec / **兩 device 兩個唔同 gostPort** / delete = gost 真 remove / stop→stopped（teardown）/ start→running（gost 重用唔 recreate））＋ **LEAK GUARD**（每個 response body 斷言零 credentials / proxy host 洩露） |

**現行全套總數：492 tests**（491 pass + 1 env-gated real-redis skip，0 fail；= P6 基線 465 + security patch 11 + Stage A 4 + Stage B 12；gated 測試已對真 redis 實跑 1/1 綠 — 見上面 §測試 gate 命令）。實跑核對：2026-10-19 `npm test`。

> **本機現實（誠實聲明，2026-10-19 更新）**：本機（kernel 6.8.0-117-generic + RTX 3090）喺跑完
> `scripts/redroid-host-setup.sh` 之後係**已實機驗證嘅 Redroid host**（Stage A：真 boot／真 ADB／
> 4 區診斷真對接，詳見上面 §Redroid 實機矩陣）。未跑 script 前本機 preflight = `overall: unsupported`
> （binder 未載入，如實顯示、永唔假報）。`REDROID_ADAPTER=mock` 只可喺非 production
> 啟用（config 層強制 production = real）。ADR §14.7「真機 Redroid 未完成清單」（2026-10-15 寫）
> 已隨 Stage A 實證逐項收結；唯一例外 = GPU `verified` 狀態仍 by design 未啟用（無 in-device render check）。

### P6 收尾（已交付 — 2026-10-15，證據 `docs/evidence/p6-e2e/` + `p6-security/` + `p6-cleaninstall/`）

**5 個 P3–P5 留底 flag 全部收結**（詳細決定：ADR §15）：

| # | flag | 收結 |
|---|------|------|
| 1 | `?managed=true` 漏 exception 表 | **修**：`isManaged()`（label OR exception）成為 service 層單一事實源，list/inspect/dashboard/gate 同規則（9383498） |
| 2 | managed 持久目標用 compose label | **做**：compose web/api/worker 加 `app.managed: "true"`（persistent 目標，rebuild 存活）（d0d2d33） |
| 3 | 排程通知 | **做**：worker 喺 terminal scheduled run（含 overlap skip）寫通知行 → topbar bell（30s poll）+ 深鏈 + mark-read（98657de） |
| 4 | P4 flaky test | **根因修復**：wall-clock drift 入斷言 → slot anchor 喺 createdAt，deterministic 恰 4200；修後連跑 3×450 全綠 |
| 5 | `concurrency_key` 無執行邏輯 | **實裝**（唔 defer）：engine gate — 同 key active holder → 15s bounded defer（×10 ≈2.5min）→ 可視化 `skipped` run（帶 holder id）（51302ef） |

**UX 收尾**：Dashboard 全部真 API counters（單一 `/api/dashboard/summary` 端點，零硬編碼，Docker down 降級唔 500）；notification bell（badge + panel + 深鏈）；SSE reconnect 3s bounded backoff + 狀態 pill；sidebar active 高亮修復（P0 遗留 bug）；防連點審計。

**安全**（證據 `docs/evidence/p6-security/`）：
- npm audit ×3（api/worker/web）= **0 vulnerabilities**（prisma 7.10.0 transitive 4 high 經 root overrides 修復 + 驗證鏈，ADR §15.7）
- Secret redaction **17/17 實打**（`e2e/secret-redaction-e2e.mjs`）：provider key 全路徑零洩（GET 只 `hasApiKey`、DB `v1:` AES-256-GCM、audit details 零 key）+ approval 讀路徑 scrub gate（raw-insert legacy 行也 `***redacted***`）+ 審計 spot-check
- threat-model.md 最終版（T1–T7，P3–P6 新面：service token / approval / redroid ADB / provider key 全部獨立覆蓋）

**E2E**（`e2e/p6-e2e.mjs`，system Chrome headless + 真 worker）：**14/14 pass，0 意外 console error** — login → dashboard 實計數器 → containers → detail + SSE live → UI 建 run → live worker 行到 succeeded → interval schedule → run-now → 該 run 自己嘅 notification → bell 深鏈 + mark-read → viewer RBAC → logout。截圖 ×13 + summary.json。E2E 實捉到 5 個真 UI bug（全修，ADR §15.5/§15.6）。

**clean install 實跑**（`docs/evidence/p6-cleaninstall/`）：`down -v` → 嚴格照本 README 由零起 → 5/5 healthy → 首 admin 建立 → 登入 200 → 還原 dev 狀態。

## Batch Rotation（BR-B1–B6 — 2026-10-21/22）

Identity 批次輪換：一組 identity（例如 200 個）排入 cycle，每批（batch）並行跑固定數量嘅容器（global cap 控制 fleet 總量），一個 identity 一次一個 run，跑完釋放。

**核心保證（MD §14，全部有測試/E2E 證據）**：
- **PG-first**：PostgreSQL = source of truth；BullMQ 係 derived index（worker boot + 每 5 分鐘 reconcile 對齊）— Redis 斷 = 派工停（唔 blind 派），復原自動收斂
- **唔雙跑唔漏單**：(batch, identity) 一列 `task_run`；重試 = 新 attempt（事件流 lineage，`attempt_started` unique）；worker 重啟後 adopt 舊容器而唔係建第二個；port/slot 用 `resource_lease` CAS 認領
- **容量**：`effective = min(batch.maxActiveContainers, globalCap ?? ∞)`；global cap = admin-only 寫（`/api/batches/capacity`）
- **fail-closed**：Docker 任何 error 唔會當成功；image 404 = 第一次即 FAILED_FINAL（唔燒重試）；port 池用盡 = bounded retry；429（rate limit）對 scheduler = retryable
- **data 保留**：stop/remove/cancel 全部保留 identity data；唯一抹 data = `POST /api/identities/:id/purge`（admin+human only、dryRun、confirm token）
- **零秘密**：所有 read surface = allow-list 投影 + scrub；report 匯出有 secret 硬門（漏 = 500 `REPORT_SECRET_TRIP`）

**運行**（operator+）：`POST /api/batches/preview`（純讀、unknown id 報告）→ `POST /api/batches`（strict、unknown id = 400、DISABLED = SKIPPED 帶原因、idempotencyKey 冪等）→ `POST /api/batches/:id/start`（冪等；scheduler 會 auto-start）。停止：pause/resume/cancel。事故：`POST /api/batch-containers/reconcile`（`fix=true` 清 orphan）。詳見 `docs/api-reference.md`（Batch Rotation 控制節）+ `docs/runbook.md` §11（監控/告警/故障應變）+ ADR §18。

**測試 harness（BR-B6）**：
- `scripts/br-b6-e2e/` — MD §14.3 sandbox E2E：fresh scratch（16341–16344 + ADB 16360–16400、`br-b6-*` 前綴、ADB-mock image）→ 200 identities / 4 batches 全 cycle + 重複 API 請求 + worker SIGKILL + API 重啟 + transient/permanent 故障 → P5 200 終態 audit。`bash scripts/br-b6-e2e/run.sh`（自帶 teardown；port pre-flight + listener identity 驗證防 orphan 撞口）
- `scripts/br-b6-e2e/fault-driver.mjs` — 跨組件故障注入：Redis 斷 15s / PG 斷 15s / worker kill + Redis 斷（組合）；斷言 = 每 identity 一個終態 + `attempt_started` 全局 unique + 零殘留容器（`bash scripts/br-b6-e2e/fault-run.sh`）
- `scripts/br-b6lt/` — 真機階梯壓測（165xx scratch、`br-b6lt-*` 前綴、pinned digest `matrixa-r3`、`gpu_mode=host`）：1→5→10→25→50，每階段 5s VRAM+host sampler + SGLang 共卡 halt monitor（衝突先縮 batch/等）— `logs/br-b6-loadtest/`（plan + 每階段 report）

## 功能清單（MD §18 三類分列 — 交付誠實項）

### A. 實際可用（真環境實測過，非 mock）

- Docker 容器運維全套：list/inspect/logs/stats、start/stop/restart/pause/unpause、template allowlist 建容器、delete 兩步確認 — **真 docker daemon**（P2 收貨 live 實測；P6 E2E 重驗）
- Auth/RBAC/CSRF-Origin：argon2id、session、三角色 401/403 矩陣、Origin guard、login 限流（**per-account**）— 真 HTTP（P1 收貨 + P6 E2E viewer RBAC 403 實打；per-account 鍵 2026-10-19 patch）
- AI 任務全循環：create → queue → agentic tool loop → approval gate → 結果/事件持久化 → SSE 實時 UI → cancel/retry — **mock provider 走完真 queue/worker/DB/SSE**（P3 收貨 live；P6 E2E 第 5–6 步重驗）
- 排程全套：CRUD/cron+interval+once/每排程 tz/overlap policy/sync 自愈/重啟 reconcile 零重複 — **真 BullMQ Job Scheduler + 真 PG**（P4 收貨 7 項硬驗收 live；P6 E2E run-now + notification 重驗）
- 排程通知（P6）：terminal run → 通知行 → bell badge → 深鏈 → mark-read（P6 E2E 第 7–9 步實打）
- concurrency gate（P6）：同 key 互斥 bounded defer → 可視化 skip（hermetic 7 scenario + 狀態機測試；真 redis 環境下同 overlap 同路徑）
- Dashboard 實數據（P6）：全部數字來自 `/api/dashboard/summary`（零硬編碼）— E2E 第 2 步斷言 fleet ≥3 running
- 安全控制：provider key AES-256-GCM + 零回傳 + log redaction + service token 時序安全比較 + AI 唔自批 + 審計全寫入 — P6 17/17 實打證據；＋ SSRF guard（provider baseUrl → 400 `BLOCKED_URL`，寫入 + fetch 雙重）＋ proxy anti-spoof / trustProxy（per-client 限流先有效）— 2026-10-19 security patch（hermetic 11 tests）
- **Redroid 實機矩陣 Stage A（2026-10-19）**：真 redroid 容器 boot（redroid 14.0.0-240527 + binderfs wrapper image，本機 kernel 6.8 + RTX 3090，GPU host mode）→ `boot_completed=1`／ADB `device`／SDK 34／3 條 shell 實測／boot 後 18+ 分鐘零 crash；真 ADB 連通 + 真 logcat/getprop 對接；4 區診斷對真 device 實跑（host 視角 / offline 誠實披露）
- **Per-device egress proxy DNS 隔離（Stage B，2026-10-19）**：2 device 走 2 條獨立 proxy 路，**DNS 100% 經 proxy**（canary NOERROR + NXDOMAIN 負例實錚），每個 proxy 只見到自己嗰部 device 嘅源 IP（路由隔離成立）— TCP 路徑係明列限制（見 C 類第 1 項）
- 部署/運維：clean install（P6 實跑）、backup/restore（P6 實跑 14 表全對）、health/ready 依賴分級、Redroid host 一次性 setup（Stage A，冪等 script + undo）
- **Batch Rotation 全 cycle（BR-B6 sandbox E2E，2026-10-22）**：200 identities / 4 batches × 50 全 cycle（163xx scratch、ADB-mock image）— 重複 create/start 冪等（同 idempotencyKey = 同 cycle；已 RUNNING start = `started:false` no-op）、DISABLED identity = SKIPPED 帶原因（preview/create 一致）、worker SIGKILL / API 重啟 / transient+permanent 故障注入後零雙跑零漏單（`attempt_started` 全局 unique）、active container 任何時刻 ≤ 全局 cap、容器移除後 data 保留 — evidence `logs/br-b6-e2e/`（BR-B6 收口）

### B. Mock 驗證（API/邏輯層全過，外部真體未接）

- **AI provider 真模型對接**：OpenAI-compatible adapter 邏輯全測（classified error、redact、timeout），但 MVP 收貨只用 **mock provider** — 真 SGLang/OpenAI key 喺你嘅環境 5 分鐘可接（Settings → 建 provider → test 按鈕），**未喺本 MVP 收貨範圍內實打**
- **Redroid device 層（mock adapter 路徑）**：preflight 三態 / port 分配真 probe / docker create 形狀錄到斷言 / DB/audit/RBAC 全路徑 — mock 生命週期全驗證（`REDROID_ADAPTER=mock`，production 強制 real）。真機行為已升級去 A 類（Stage A 實 boot ＋ Stage B DNS 隔離）— 兩向都有實證
- **E2E 截圖**：system Chrome（`channel:'chrome'`）— 無 Playwright 專屬 build 嘅 host 上可重現

### C. 明列未完成（MD 要求，唔假裝驗證 — 2026-10-19 按 Stage A/B 實證重分）

原 ADR §14.7「Redroid 真機 6 項」中嘅真 boot／真 ADB 連通／真 logcat+getprop／privileged 真機 boot／真 preflight `supported` 已喺 Stage A 實錚收結（轉 A 類）；餘下明列限制：

1. **TCP 全經 proxy** — **產品鏈已成立（R3/R4 live 實錚雙向 canary）**；R2 spike 拓撲（裸第一跳）stall 根因 open — 見 §Per-device egress proxy 誠實邊界 + K1
2. **fail-closed 出口 monitor** — **平台層已建已實錚**（R3/R4：BLOCKED/FAILED + worker gate + UI/audit；見 K12）；kernel 層 iptables 兜底 = backlog P0 單（R7 decide-and-defer，netd 互踩風險）
3. **GPU `verified` 狀態** — by design 未啟用：無 in-device render check（MD §2.4）；nvidia-smi OK ≠ Android EGL OK，GPU 狀態最多 `software`/`unverified`
4. **redroid 映像 pull 策略**（自動 pull/registry auth）— 未建（版本 pin 已有）
5. **removeData 清唔到 root-owned 殘留**（2026-10-19 新）：實 boot 後 per-device `/data` 內容 root-owned（容器 root 寫入、bind mount 無 uid remap）；api（uid 1000 非 root）刪除報 `dataRemoved:false` + error，目錄 skeleton 留喺 host — 要 root 層定期清理（見已知限制 K13）

## 已知限制 + 修復建議（MD §18：唔得「基本完成」掩蓋）

| # | 限制 | 影響 | 修復建議 |
|---|------|------|----------|
| K1 | **R2 spike 拓撲（t2s 裸第一跳）TCP forward-stall 根因 open**（R2 實錚；R7 定位修正） | 產品鏈（gost 第一跳）**不受影響**（R3/R4 live 雙向 canary PASS + 常規 watchdog gate）；若引入非 gost 第一跳拓撲，stall 會復現且未被平台 canary 以外嘅機制理解 | 機構層 restapi instrument（`tcp-transport-investigation.md` §8 清單）；任何非 gost 第一跳拓提案 = 先重跑 R2 八層矩陣 |
| K2 | **AI provider 只收貨到 mock**（B 類） | 真模型行為（長輸出/多輪 tool call/真實 token 耗費）未實打 | 接真 provider 後跑 `e2e/secret-redaction-e2e.mjs` 同長任務 timeout/cancel 實測 |
| K3 | **無自動 encryption key 輪替工具** | `APP_ENCRYPTION_KEY` 輪替 = 所有 provider 要重傳 key（runbook §3.4 手動流程） | 加 `rotate-encryption.js` CLI（支持 legacy key fallback 重加密，一次性） |
| K4 | **無 data retention/prune 策略** | `task_run_events` 長期增長（P6 實測 1600 行 = 0.7 MB dump；長線要留意） | 加 prune job（按 age/size）+ DB 大小儀表（runbook §8） |
| K5 | **無 container template 修改/刪除 API** | template 改動要 DB 層手動（admin 判斷） | 加 `PUT/DELETE /api/templates/:id`（DELETE 要 IN_USE 檢查） |
| K6 | **無 user 管理 API/UI** | 加人 = DB 層手動（argon2id hash）；無 deactivate 路徑（只有 session 登出） | P7：users CRUD + deactivate + 密碼重置流程（設 admin-only） |
| K7 | **SSE 無 server-push 重連事件去重保證以外嘅多 tab 同步** | 多 tab 同一 run = 各開一條 SSE（有並行 cap 503） | 長線考慮 single-tab 設計或 Redis pub/sub fan-out |
| K8 | **單機部署假設** | 無多 api 實例/水平擴展設計（SSE slot、rate limit 皆 per-process；DB advisory 未用） | 如要擴展：先移 rate limit + SSE slot 入 Redis（ADR 流程） |
| K9 | **E2E 要 system Chrome** | 無 `channel:'chrome'` 嘅 CI 要 `npx playwright install chromium` | CI 配瀏覽器 cache（或 Docker 內 e2e） |
| K10 | **dev 環境 `.env` 手動管理** | 秘密喺 `.env`（gitignored）— 無 secret manager 整合 | 生產化時接 env-secrets（docker secrets 或 vault），改 env 注入點唔變 |
| K11 | **web 無 error boundary** | P6 修了根因（`useApi` pending 派生），但未加全局 error boundary — 未來任何新 render bug 仍可能白屏 | P7：加 React error boundary + fallback UI |
| K12 | **tunnel 死 = kernel 層 fail-open 殘留**（平台層已實錚 fail-closed；R7 decide-and-document） | 平台層：BLOCKED/FAILED + worker 唔派網絡任務 + UI/audit（已實錚，R3/R4）。殘留：tunnel 死後 Android app kernel 層 egress 可經 eth0 直連（platform BLOCKED 唔阻斷佢） | 過渡 = operator 守則（runbook §10.7：BLOCKED/FAILED 視 egress untrusted；硬隔離 = host 層 firewall 限 redroid 容器 egress 只過 proxy leg）；永久 = netns DROP spike + ADR（netd 互踩實測）→ 另開 P0 單 |
| K13 | **removeData 清唔到 root-owned data 目錄殘留**（Stage A） | 實 boot 後 per-device `/data` 內容 root-owned（容器 root 寫入、無 uid remap）；api（uid 1000 非 root）刪除失敗報 `dataRemoved:false`，目錄 skeleton 留喺 host | root 層定期清理 job 或 privileged cleanup sidecar（backlog 項） |
| K14 | **adbd recreate-stall**（R5 live 發現；image/內核層 root cause open） | delete+recreate 後 framework 完全 boot 但 adbd 停答 host protocol（recreate 特有；stop/start 唔中招）；產品診斷 honest（`running + adbState=offline`，無假陽性）但該 device 嘅 ADB 路徑不可用，要等容器生命周期重來 | 追索方向：redroid image adbd auth relay on recreate / binder transport 重掛時序（`redroid-host-validation.md` §5）；R7 決定 = 記錄為已知限制（R6 口徑），backlog 另開單 |

**未完成項目總計**：C 類剩 **3 項**（GPU `verified`／映像自動 pull／removeData root 殘留 — TCP 經 proxy 同 fail-closed monitor 兩項已由 R3–R7 收結，見 K1/K12 新口徑）+ K3/K5/K6/K9（小工單，P7 候選）+ K4/K7/K8/K10/K11/K14 + K1（open 根因，產品鏈無影響）— 其餘 P0–P6 + 2026-10-19 security patch + Stage A/B + 修復鏈 R0–R7 + **BR-B1–B6（Batch Rotation，見 §Batch Rotation）** scope 全部收貨（證據鏈：每 phase ADR §13–§18 + `docs/audits/` 4 審計檔 + `docs/live-evidence/` + runbook §9.5/§10/§11 + CI run + `logs/br-b6-e2e/` + `logs/br-b6-loadtest/`）。

## 疑難排解

| 症狀 | 診斷 / 處理 |
|------|-----------|
| `docker compose` 要密碼 / EACCES socket | 用 `sg docker -c '…'`，或重開 terminal（group 生效）；**唔好** `chmod 666 /var/run/docker.sock` |
| `WEB_PORT` 佔用 | 改 `.env` 嘅 `WEB_PORT`（compose 會喺 up 時讀）；`ss -ltnp \| grep 3012` 搵誰佔住 |
| api 一直 unhealthy | `sg docker -c 'docker compose logs api'`：多数係 DB/Redis 未 ready（等 `depends_on` 過）或 `.env` 秘密錯（api 會即刻 env 驗證失敗退出） |
| `ready` 503 但 `live` 200 | 看 `ready` body 嘅 `dependencies.*.error`：db/redis 問題查 compose；docker down 唔係 503（degraded） |
| `prisma migrate` 失敗 | 看 api log；migration 衝突 → 唔好手改已 apply 嘅 migration，新建 migration；`migrate status` 查漂離 |
| 忘記 admin 密碼 | 無 reset 路徑（設計如此）：`down -v` 重置，或直接 DB 改 `users.password_hash`（完整安全流程見 `docs/runbook.md` §6.4） |
| web 開到但登入 404/502 | api 未 healthy（`compose ps`）；web 反代上游 `http://api:3000` 唔通 |
| 重建後行为異常 | `down -v` 係唯一徹底法；`down`（唔帶 -v）會保留舊 volume |
| 改咗 schema 但容器內未生效 | `prisma generate` 喺 **build 時** 跑（api.Dockerfile production stage），`migrate deploy` 喺 **每次啟動** 跑（entrypoint）。schema 改動要 `docker compose up -d --build api` 重建，唔係重啟 |

## 版本鎖定

全部關鍵依賴版本鎖定表：`docs/architecture-decisions.md` §版本鎖定（P0 交付）。
改版本 = 先過 ADR 流程，唔好直接 bump。

## Roadmap（P0–P6 全部完成）

| 階段 | 範圍 | 狀態 |
|------|------|------|
| P0 | Repo + docs + 版本鎖定 | ✅ |
| P1 | Skeleton + Deployment | ✅ |
| P2 | 容器核心（DockerService 全套、API、模板 allowlist、Web UI 兩頁、SSE） | ✅（live daemon 實測過，2026-10-14） |
| P3 | AI 任務引擎：providers（AES-256-GCM 加密 key）+ task queue + tool registry + approval gate + Web UI | ✅（live 實測 2026-10-15，全循環 DB+SSE 實證） |
| P4 | 排程（schedules → BullMQ 6 Job Scheduler，PG-first）+ Web UI | ✅（live 實測 2026-10-15，7 項硬驗收全過） |
| P5 | Redroid Devices（template 受控建立 + localhost-only ADB + 白名單診斷 + GPU 誠實 + mock 驗證主路徑）| ✅（live 實測 2026-10-15，7 項硬驗收全過；真機部分由 2026-10-19 Stage A 收結，ADR §14.7） |
| P6 | UX 收尾 + 安全（audit 清零/redaction 實打/threat-model 最終）+ E2E 14/14 + docs（README/runbook/API 總表/ADR §15）+ 5 flag 收結 + clean install 實跑 | ✅（2026-10-15；證據 `docs/evidence/p6-*/`） |
| 2026-10-19 | Security patch（SSRF guard / per-account 登入限流 / proxy anti-spoof + trustProxy）+ Redroid 實機矩陣：Stage A（real-host boot + binderfs wrapper + host setup script）+ Stage B（per-device egress proxy：gost + tun2socks，runbook §10） | ✅（27cc558；f8e2986/cf6b2d9；18f8139/ffe800f/bd88571/351983a；實機證據 2026-10-19） |
| 修復鏈 R0–R7（2026-10-19/21） | 網絡模組 P0–P7 修復：基線盤點（R0）→ binary 可重現性 pin+sha256 fail-fast（R1）→ TCP data-plane 根因矩陣（R2）→ netState 7 狀態機 + watchdog + fail-closed（R3）→ 狀態一致性單一權威（R4）→ 實機 host 驗收 + 資源限制 + patch-clobber 修復（R5）→ 錯誤契約 + 40min boot-timeout 校準 + patch-default guard（R6）→ 文檔/ADR/CI/release gate（R7） | ✅（6fdcf27 → e3b9c75…；實錚證據 `docs/live-evidence/r3|r4|r5-20261020/` + `docs/audits/` 4 審計檔 + CI run 39499318028 全綠） |
