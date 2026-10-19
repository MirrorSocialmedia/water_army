# water_army Runbook（P6 最終版 — 日常運維 + 事件應變）

適用：compose 部署（5 services：web / api / worker / postgres / redis，127.0.0.1:3012）。
所有 docker 命令用 `sg docker -c '…'`（或已在 docker group 嘅新 shell session）。

---

## 1. 重啟

### 1.1 全平台重啟（保數據）
```bash
sg docker -c 'docker compose restart'          # 全部 5 個
# 或停再起（entrypoint 重跑 migrate deploy，冪等）：
sg docker -c 'docker compose stop' && sg docker -c 'docker compose up -d'
```
- postgres/redis 用 volume（`pgdata`/`redisdata`）— stop/restart 唔會失數據。
- api 啟動時 `prisma migrate deploy` 自動落未 apply 嘅 migration（冪等）。
- worker 啟動時 **scheduler reconciler** 跑一轮（PG → BullMQ 原地 upsert、清 orphan、自愈 sync_status）— 重啟唔會造成重複或遺失排程（P4 驗收項，實測過）。
- 排程 best-effort：重啟期間嘅 slot 會喺 `skipped`/遲到執行入面誠實記錄（`task_runs` 可查），唔會靜默吞。

### 1.2 單項重啟
```bash
sg docker -c 'docker compose restart api'       # 常用：改咗 env 之後
sg docker -c 'docker compose restart worker'    # queue 卡死 / reconcile 要重跑
sg docker -c 'docker compose restart web'       # 前端 asset 問題
```
改 env（`.env`）後要 **`up -d` 而唔係 `restart`**（restart 唔重讀 env）：
```bash
sg docker -c 'docker compose up -d --force-recreate api worker'
```

### 1.3 重新部署新 code
```bash
git pull
sg docker -c 'docker compose up -d --build'     # 三個 image 重 build（npm ci 自 lockfile）
sg docker -c 'docker compose ps'                # 等 5/5 healthy
```
- schema 改動：image build 時 `prisma generate`，啟動時 `migrate deploy` — 要 `--build`，唔係淨係 restart。
- 部署後核對：`curl -s 127.0.0.1:3012/api/health/ready` + E2E 截圖（`e2e/p6-e2e.mjs`）。

---

## 2. Queue（BullMQ）管理

Redis 7 + BullMQ 6.3.15。queue 名 = `water-army:tasks`（`@water-army/shared` `createTaskQueue`）。

### 2.1 看 queue 狀態
```bash
# 最簡：API health/ready（redis 項）+ worker log
sg docker -c 'docker compose logs --tail=50 worker'     # 每行 job pickup/finish 都喺 log

# ioredis 層（經 worker 容器內 node）：
sg docker -c 'docker compose exec worker node -e "
const { createTaskQueue } = await import(\"@water-army/shared\");
const q = createTaskQueue({ redisUrl: process.env.REDIS_URL }, { info(){} });
await q.waitUntilReady();
console.log(await q.getJobCounts());        // { waiting, active, completed, failed, delayed }
console.log(await q.getJobSchedulersCount()); // BullMQ Job Scheduler 數量（= DB enabled 排程數）
await q.close();
"'
```

### 2.2 Stalled / hung job
- worker 重啟後，之前 active 嘅 job 由 BullMQ 自動標 stalled → 按 `stalledIntervalTime` 重新入 waiting（預設 30s）— **正常情況唔用手動**。
- 真卡死（同一 run 永遠 `running` 超過 timeout 上限 900s 都唔終態）：
  1. `sg docker -c 'docker compose restart worker'`（job 會 stalled→retry；retry 上限 3 次後 `failed` — 誠實終態）。
  2. 個別 run：UI/API `POST /api/tasks/runs/:id/cancel`（operator+；真停 — cancel 後零後續輸出）。
- **唔好**手動改 `task_runs.status`（繞過狀態機 = 事件流/審計漂移）。要強制終態就經 cancel/retry API 或重啟讓 BullMQ 自己了斷。

### 2.3 清 queue（高危操作 — admin 判斷）
```bash
# 清特定狀態（例：清晒 failed，保留 running/waiting）：
sg docker -c 'docker compose exec worker node -e "
const { createTaskQueue } = await import(\"@water-army/shared\");
const q = createTaskQueue({ redisUrl: process.env.REDIS_URL }, { info(){} });
await q.waitUntilReady();
const failed = await q.getJobs([\"failed\"]);
for (const j of failed) await j.remove();
console.log(\"removed\", failed.length);
await q.close();
"'
# 全清（連 delayed/once 排程 job 都清 — 之後 worker reconcile 會由 PG 重建 enabled 排程）：
sg docker -c 'docker compose exec worker node -e "
const { createTaskQueue } = await import(\"@water-army/shared\");
const q = createTaskQueue({ redisUrl: process.env.REDIS_URL }, { info(){} });
await q.waitUntilReady();
await q.clean(0, 100000, \"completed\");
console.log(await q.getJobCounts());
await q.close();
"'
```
- **清 queue 唔會清 DB**：`task_runs` 歷史保留（lineage）；清完 worker reconcile 會重建排程索引。
- 徹底重置（DB + queue 全清）= `docker compose down -v`（見 §4 還原 — 之前先 backup）。

---

## 3. DB Backup / Restore（2026-10-15 實測流程）

Postgres 17.6，DB `water_army`，user `app`。14 張表（users/sessions/provider_configs/task_definitions/task_runs/task_run_events/schedules/approval_requests/audit_events/redroid_templates/devices/schedule_notifications/app_settings + `_prisma_migrations`）。

### 3.1 備份（logical dump，運行中可做）
```bash
sg docker -c 'docker compose exec -T postgres pg_dump -U app water_army' > wa-backup-$(date +%F-%H%M).sql
ls -la wa-backup-*.sql        # 本機 dev 約 0.7 MB
```
- `pg_dump` 係 single-transaction snapshot（MVCC）— 唔需要停寫。
- **備份檔含 provider key 密文（AES-256-GCM）+ user 密碼 hash** — 備份檔要同 `APP_ENCRYPTION_KEY` 一樣保密（存加密磁碟 / 限制權限 `chmod 600`）。
- 建議節奏：每日一次 + 每次部署前一次。

### 3.2 還原（實測驗證：dump → 全新 DB → 14 表 row count 全對 + provider 密文前綴 `v1:` 完整）
```bash
# 還原到全新 DB（例：clean install 之後還原回舊數據）：
sg docker -c 'docker compose exec -T postgres psql -U app -d water_army -v ON_ERROR_STOP=1' < wa-backup-YYYY-MM-DD.sql
```
實測記錄（2026-10-15 gen2）：
- dump 732,131 bytes → 還原入 scratch DB `wa_restore_check` → 逐表核對：**users 3 / task_runs 260 / task_run_events 1600 / schedules 11 / audit_events 284 / provider_configs 1 / sessions 128 / redroid_templates 2 / task_definitions 4 / approval_requests 12 / schedule_notifications 11 / app_settings 2 / devices 0 / migrations 3 — 全部 = 源 DB**；provider 密文 `v1:` 前綴 intact；scratch DB 已 drop。
- 還原入 **唔係空嘅** DB：先 drop 表或改用 `--clean`（`pg_dump --clean`）— 否則 PK 衝突。生产還原 = 目標 DB 應該係空（新 volume）。
- 還原後：`sg docker -c 'docker compose restart api worker'`（entrypoint 重跑 migrate deploy 核對 schema；reconciler 重建 queue 索引）。

### 3.3 冷備份（額外加碼 — 要停 postgres）
```bash
sg docker -c 'docker compose stop postgres'
sg docker -c 'docker run --rm -v water-army_pgdata:/data -v $(pwd)/coldback:/out alpine tar czf /out/pgdata-$(date +%F).tar.gz -C /data .'
sg docker -c 'docker compose start postgres'
# 還原 = 相反：stop → 解 tar 入 volume → start
```
（logical dump 通常已夠；冷備份係防「dump 文件格式/版本問題」嘅最後保險。）

### 3.4 加密 key 輪替（`APP_ENCRYPTION_KEY`）— 誠實流程（無自動 re-encrypt 工具，見 README 已知限制 K3）

**先知道代價**：`APP_ENCRYPTION_KEY` 換咗之後，DB 入面既有嘅 provider 密文會解唔開（GCM auth fail → classified crypto error，**唔係靜默失敗**）。所以輪替前必須有原明文 key 嘅來源（你自己录入嗰個）。

```
1) 備份（§3.1）
2) 所有 provider 嘅原明文 key 先備份喺安全位置（你當初录入嗰個）
3) 新 key 入 .env 嘅 APP_ENCRYPTION_KEY
4) sg docker -c 'docker compose up -d --force-recreate api worker'
5) 逐個 provider 用 PATCH /api/providers/:name 重傳原明文 key
   （新 key 會用新 APP_ENCRYPTION_KEY 重新加密落庫）
6) 逐個 POST /api/providers/:name/test 確認解得開 + 打得通
```
- 無第 2 步（明文 key 唔喺手）= 輪替 = 所有 provider 要換新 key（喺 provider 平台側 revoke + 重發）。
- **唔好**喺舊 key 都冇嘅情況下直接換 `APP_ENCRYPTION_KEY`（所有 provider 即死）。

---

## 4. 徹底重置（down -v）

```bash
sg docker -c 'docker compose down -v'    # ⚠️ 刪 pgdata + redisdata volume（DB + queue 全清）
```
- **之前必做**：§3.1 backup（保留還原路徑）。
- 重置後 = clean install 狀態：`up -d --build` → api 自動 migrate（全新 schema）→ 建 admin（`setup-admin.js`，users 表空先可以）→ 還原（§3.2，如需要）。
- P6 clean-install 實跑記錄：`docs/evidence/p6-cleaninstall/`（down -v → README 步驟 → 5/5 healthy → 建 admin → 登入 200）。

---

## 5. 故障排檢（症狀 → 診斷 → 處理）

| 症狀 | 第一步 | 常見因 | 處理 |
|------|--------|--------|------|
| 3012 打唔到 | `sg docker -c 'docker compose ps'` | web 唔 healthy / 無起 | `logs web`；`up -d`；port 佔用 → 改 `.env WEB_PORT` + `up -d --force-recreate web` |
| `ready` 503 | 睇 `ready` body `dependencies.*.error` | db/redis 問題 | postgres/redis log；OOM？`free -h`；disk 滿？`df -h` |
| `ready` 200 但 `docker.available:false` | daemon 狀態 | docker daemon down / socket 權限 | `sg docker -c 'docker info'`；daemon 重啟；**唔好** chmod 666 socket |
| api unhealthy（loop 重啟） | `logs api` | env 驗證失敗（秘密錯）/ migration 衝突 / OOM | env 對返 `.env.example`；migration 漂移 → `migrate status`；加資源 |
| 任務永遠 queued | `logs worker` + queue counts（§2.1） | worker 無起 / redis 斷 / provider disabled | worker 起返；redis ping；provider `isEnabled` |
| 任務 failed `PROVIDER_*` | run detail 事件流（UI） | key 錯 / baseUrl 錯 / timeout / model 唔存在 | `POST /api/providers/:name/test`（classified error）；改配置 → retry |
| 排程 `sync_error` 旗標 | schedule detail | redis 斷咗（DB row 照存 — PG-first） | redis 復原 → `POST /schedules/:id/sync`（503 = 還未復，誠實）；或重啟 worker（boot reconcile 自愈） |
| 排程「冇走」 | `task_runs` 入面有無 skipped 行 | overlap `skip_if_running` 觸發（**有痕** — skipped run 帶 `activeRunId`） | 正常行為；睇 `inputJson.skipped` 原因；改 `queue` policy 或等 active 完 |
| 登入 429 | 等 60s | 限流（5 失敗/60s/IP） | 設計如此；限流中連正確密碼都 429（唔旁路） |
| 忘記 admin 密碼 | — | 無 reset 路徑（設計） | 見 §6 應變 |
| 容器操作 403 `NOT_MANAGED` | 睇容器 label | 未標 managed / exception 被撤 | admin `POST /api/containers/exceptions`（審計記錄）或改 compose label |
| 刪除容器 400 confirm | UI 重打一次 | confirm 要逐字 repeat name/id | 兩步確認設計（MD §0-7） |
| E2E/UI 500 冇 request log 行 | 500 body 堆棧 | Next/Vite dev manifest race（**已知 flake**，非 code bug）— `loadManifest`/`getNextFontManifest` 樣式 | 重跑即好；生产 static build 無呢問題 |

---

## 6. 事件應變（escalation）

1. **平台全死**：`compose ps` → 起唔到嘅 service 逐个 `logs` → docker daemon（`docker info`）→ host 資源（`free -h`/`df -h`/`dmesg | tail`）。
2. **數據一致性质疑**（排程重複/run 狀態奇怪）：**唔好即刻手改 DB**。先睇 `audit_events`（admin API）+ `task_run_events`（run detail）重建時間線；queue counts 對 DB；reconciler log（worker，每 5 分鐘一轮）。
3. **疑似 secret 洩露**：
   - 立刻輪替：provider key（UI/API 重傳）→ `WORKER_API_TOKEN`（.env + recreate api/worker）→ admin 密碼（無 reset → 見下）→ `APP_ENCRYPTION_KEY`（§3.4）。
   - 排查：`audit_events` 時間線（邊個 actor、幾時、咩 action）；pino log grep（已 redact — 洩露面 = 能讀 log 檔案嘅人）。
   - 事後：補 threat-model 殘留風險欄 + progress。
4. **忘記 admin 密碼（無 reset 路徑，設計如此）**：
   ```bash
   # 方法 A（保住數據）：DB 層直接換 hash
   NEW_HASH=$(sg docker -c 'docker compose exec -T api node -e "import(\"@node-rs/argon2\").then(async m=>{const{hash,argon2id}=m;console.log(await hash(\"<new-strong-pw>\",{type:argon2id}))})"')
   sg docker -c "docker compose exec -T postgres psql -U app -d water_army -c \"update users set password_hash='$NEW_HASH' where username='admin'\""
   # 然後 API 登出所有舊 session（sessions 表），審計記一手動改動
   # 方法 B（忍唔到）：§4 down -v（先 backup！）
   ```
5. **Redis AOF 損壞**：redis log 有 AOF 錯誤 → `redis data` volume 备份 → 起 redis 讓其 AOF 重寫/修復 → queue 重建靠 reconciler + BullMQ 自身（排程索引由 PG 重建；進行中 run 會 stalled→retry）。

---

## 7. SSE / 事件流斷線（含 gateway 1006 應對）

SSE（`/api/tasks/runs/:id/events`、`/api/containers/events`）係長連接；WS-style close code **1006 = abnormal closure**（無 close frame 就斷 — 典型：proxy 超時、daemon 重啟、網絡抖動、`Ctrl+C`）。

**系統已有嘅應對（唔要驚）：**
- **client 自動重連**：EventSource 原生重連；web UI 加咗 **3s bounded backoff** + `reconnecting` pill 顯示（P6 — downed server 唔會緊密循環打爆 API）。
- **cursor resume**：task events 支持 `?after=<eventUuid>` — 重連後補返斷線期間嘅事件（DB poll snapshot），唔會漏事件。
- **server 端 slot release**：SSE 斷線（任咩方式，包括 1006）→ abort → slot 自動 release（P2 實測：active 計數回 0）— 唔會洩 slot。
- **並行上限**：SSE 並行有 cap（超 → 503 `SSE_LIMIT`）— 大量斷線重連唔會打爆。
- **terminal run**：run 到 terminal 狀態後 server 發 `done` 再主動 close（client 唔會再重連）。

**運行時見到 1006/斷線要處理嘅情況：**
1. 大量 client 同時斷（api 重啟/OOM/restart）→ 正常：client 會自己 backoff 重連；核 `logs api` 有冇 crash/OOM trace 先。
2. 重連後**冇**事件補返（cursor 失效）→ 查 `task_run_events` 有冇咗事件行（DB 係真相）；如 run 已 terminal 而 UI 卡住 → 硬刷新（UI 開 run detail 會拉 DB snapshot，唔係淨靠 SSE）。
3. 持續 503 `SSE_LIMIT` → 有 client 唔放连接（瀏覽器 tab 卡死）→ 等 GC/timeout 自然放，或 `restart api`（所有 SSE 會斷，client 自動重連）。
4. **長連接被中間 proxy 殺**（如果将来加反代）：proxy 要 set `proxy_read_timeout` ≥ SSE heartbeat 間隔嘅 2 倍（heartbeat 25s）+ 唔 buffer response。

---

## 8. 監控建議（MVP 範圍內）

- `curl 127.0.0.1:3012/api/health/ready` 放外部 uptime monitor（3012 要同機 / VPN 可達）。
- worker log grep：`skipped`（overlap/concurrency）、`sync_error`、`PROVIDER_`（分類錯誤）、`stalled`。
- DB 簡單儀表：`select status, count(*) from task_runs group by 1`；`select * from schedules where "syncStatus"='sync_error'`；audit_events 每日量。
- disk：pgdata 增長（task_run_events 係最大表 — P6 實測 1600 行 = 0.7 MB dump；長線要 prune 策略，見已知限制 K4）。

---

## 9. Redroid 宿主機一次性設定（Stage A 實測 — 2026-10-19）

**只係第一次部署 Redroid 功能先要跑**（換機/換 kernel/重裝系统都要重跑）。跑一次，boot 之後都有效（module + mount + 目錄全部持久化）。

### 9.1 背景（點解要呢幾樣）

- **kernel 6.8 無 ashmem_linux**（6.x 已移除，memfd_create 取代）— redroid 14 唔需要佢（真 boot 實測過）。
- **binderfs 每個 mount 有獨立 device set**（實測：容器內建嘅 binder 節點唔會 propagate 返 host）。所以：
  - host 只係需要 `/dev/binder` **存在**（host-level preflight check + 日後 debug 用）；
  - **binder/hwbinder/vndbinder chardev 節點由 redroid wrapper image 喺容器內自建**（`docker/redroid-matrix/redroid-binder-init`，靜態 C entrypoint：private binderfs mount → `BINDER_CTL_ADD` ioctl 建節點 → `chmod 0666`（kernel 6.8 control 建嘅節點預設 0600，Android uid 1000/1002 service 打唔到 → 必改）→ bind mount 上 `/dev/{binder,hwbinder,vndbinder}`）。host 完全唔郁，完全可逆。
- **api 容器 read-only rootfs** → per-device `/data` 目錄必須喺 host（`/var/lib/water-army`）+ compose volume 入去 api 容器，API 先 mkdir 得到（api 行 uid 1000）。**唔做呢步 → device create 永遠 500 `REDROID_DATA_DIR_ERROR`**（Stage A 實測）。

### 9.2 跑 script（老細一次性，root）

```bash
cd /home/kenneth/.openclaw/workspace/water_army
sudo bash scripts/redroid-host-setup.sh
```

Script 做三樣（全部冪等、可重跑、script header 有完整 undo 命令）：
1. `modprobe binder_linux` + 入 `/etc/modules`（每次 boot 自動載入）
2. binderfs mount 上 `/dev/binder` + 入 `/etc/fstab`（`x-systemd.requires=binder_linux.module` 保證 module 先 mount）
3. `mkdir /var/lib/water-army` + `chown 1000:1000`（api 容器用戶）

**次序重要**：先跑 script 先 `compose up` — 否則 docker 會 root:root 自動建 `/var/lib/water-army`，api（uid 1000）寫唔到。

### 9.3 驗證

```bash
lsmod | grep binder_linux                      # binder_linux ... (O)
mount | grep '^binder on /dev/binder '         # binder on /dev/binder type binder (rw,...)
ls -la /dev/binder                             # binder-control + features（host 唔使有 binder 節點！）
stat -c '%U:%G %a' /var/lib/water-army         # node:node 750
```

### 9.4 重啟宿主機之後

乜都唔使做（module/fstab 已持久化）。`systemctl daemon-reload` 唔需要（fstab mount 每次 boot 自動）。

### 9.5 已知行為（Stage A 實測記錄 — 唔好當新 bug）

- **首個 boot cycle 可能軟重啟一次**：multi-stage wrapper image 首次 boot 記錄到 gralloc GBM SIGFPE（host GPU mode / RTX 3090 consumer card，MD §2.4 預期風險）+ redroid 已知 bluetooth sim 无效 MAC aborts → 系統 09:13:19 軟重啟 → 第二個 cycle 穩定（7+ 分鐘零 crash，VSYNC/allocator/SF 正常）。如复現：等一個 boot cycle（<2 分鐘）再驗證；持續 crash-loop 先係 blocker。
- **GPU 永遠係「未驗證」**：P5 冇 in-device render check（MD §2.4）— nvidia-smi OK ≠ Android EGL OK。4 區診斷 GPU zone 固定 `unverified`（host mode）/`software`（swiftshader），誠實核心。
- **api 容器冇 adb binary** → 4 區診斷 ADB zone 由 api 視角係 `offline`（engine 無 binary，空證據）。ADB 真驗證用 host-level adb（`/home/kenneth/.openclaw/workspace/tools/platform-tools/adb`）：`adb connect 127.0.0.1:<port>` → `adb -s <port> shell getprop ro.build.version.sdk`。
- **redroid container stdout 係靜音**（init 行 logcat 唔行 stdout）→ 診斷 container-logs zone 正常係 0 行。log 證據一律行 logcat（host adb）或 docker inspect。
