# water_army

Docker 容器 + AI 任務自動化平台（7 階段 MVP 之中）。本地單一部署：一個 UI、一個 API、一個 worker、Postgres 17、Redis 7，全部跑喺同一部主機嘅 Docker 入面。

- **api** — Fastify 5：auth（argon2id + session cookie）、RBAC、health、（P2 起：容器/任務/排程 API）
- **worker** — BullMQ worker：執行容器任務（P2 起）
- **web** — React 19 + Vite 8：6 頁 skeleton（P1 已上線，數據頁 P2 起接真 API）
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

**P2–P5 將接**（skeleton 已喺 web 6 頁）：`/containers`、`/tasks`、`/schedules`、`/devices`、`/ai-providers`、`/settings` 等 — 見 `docs/architecture-decisions.md`。

## 安全模型（T1 威脅）

- **Docker socket 隔離**：只有 `api` 掛 `/var/run/docker.sock`（read-only）；worker/web 無。worker 執行容器經 api（P2）。
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

測試全部 hermetic（fake db/redis/docker），`node --test`（Node 內建 runner，零 test 依賴）。

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
| P2 | 容器 + 任務核心（api 掛 socket 嘅 CRUD、worker 執行） | 待開 |
| P3 | AI providers（AES-256-GCM 加密 API key、模型呼叫） | 待開 |
| P4 | 排程（schedules → BullMQ repeatable）+ 通知 | 待開 |
| P5 | Settings 頁面 + 用户管理 + audit 檢視 | 待開 |
| P6 | 收尾：e2e、docs、security review | 待開 |
