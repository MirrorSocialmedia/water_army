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

- **Boot 頭 13 秒有一輪一次性 service crash（自愈，唔使理）**：Stage A 實測（09:12:02 boot）— graphics.allocator@2.0 gralloc GBM SIGFPE ×1（host GPU mode / RTX 3090 consumer card，MD §2.4 預期風險）+ redroid 已知 bluetooth sim 无效 MAC aborts（sim ×2 + framework app ×2）。全部集中喺 boot 頭 13 秒，init 自動重啟（allocator 09:12:08 穩定、bluetooth sim 09:12:18 穩定），之後 **18+ 分鐘零 crash**（VSYNC/SF/allocator 正常）。判斷口徑：`adb logcat -d | grep 'Fatal signal'` 時間戳全部集中喺 boot 頭幾十秒 = 正常；同一 service 每幾秒一次嘅持續 crash-loop 先係 blocker。
- **GPU 永遠係「未驗證」**：P5 冇 in-device render check（MD §2.4）— nvidia-smi OK ≠ Android EGL OK。4 區診斷 GPU zone 固定 `unverified`（host mode）/`software`（swiftshader），誠實核心。
- **api 容器冇 adb binary** → 4 區診斷 ADB zone 由 api 視角係 `offline`（engine 無 binary，空證據）。ADB 真驗證用 host-level adb（`/home/kenneth/.openclaw/workspace/tools/platform-tools/adb`）：`adb connect 127.0.0.1:<port>` → `adb -s <port> shell getprop ro.build.version.sdk`。
- **redroid container stdout 係靜音**（init 行 logcat 唔行 stdout）→ 診斷 container-logs zone 正常係 0 行。log 證據一律行 logcat（host adb）或 docker inspect。

## 10. Redroid Stage B — 出口代理矩陣（gost + tun2socks — 2026-10-19 實測）

### 10.1 架構（per-device 隔離）

- 每部有 proxy 嘅 device 配一個 **gost container**：`redroid-matrix-b-gost-<devName>`，image = `gogost/gost@sha256:f7a958c4...b7580`（digest pin，`GOST_IMAGE` 常量），bind **172.17.0.1:<20080–20179>**（DB unique，唔係 127.0.0.1 都唔係公网），`Cmd: [start, -L, socks5://:1080, -F, <proxyUrl>]`、`Env: []`。
- device 內 **tun2socks v2.7.0** 喺 `/data/local/tmp/tun2socks`（0755）起 `tun0`（10.8.0.1 peer 10.8.0.2），全部出域流量（DNS UDP + TCP + UDP）經 tun0 → SOCKS5 → gost → 上游 proxy。
  - **binary 部署契約（R1, 2026-10-20）**：binary 唔係手動 adb push、唔係 host 檔 — wrapper image 嘅 **builder stage** 由 pin（`docker/redroid-matrix/tun2socks.env`：v2.7.0 + inner sha256 `98d545a6...c031`，**唔浮動 latest**）經 `fetch-tun2socks.sh` 下載 + 驗證（retry ≤3、sha256、ELF 64-bit x86-64）+ stage 0755，再 COPY 入 final stage。checksum 錯 / 格式錯 / 下載失敗 = **build 失敗**（壞 binary 出唔到 fleet）。build context 零本機未提交檔 → **clean clone 可重現**（R1 實測：fresh build → image 內 binary mode 0755、sha256 一致、device 內 `--version` rc=0）。
  - **pre-provision binary check（fail-closed）**：每次 tunnel provision 前，service 喺 device 內跑 read-only check（存在 → 可執行 → ELF magic → `--version` canary），machine-readable：`BINARY_STATE=missing|ready|invalid|error` + `BINARY_VERSION` / `BINARY_DETAIL`（rc 0/3/4）。missing/invalid → apiCode `BINARY_MISSING` / `BINARY_INVALID`（seam 失敗 = `BINARY_CHECK_ERROR`）+ `proxyState=error`，**device 絕唔會入 proxy `running`**；診斷持久化 + view 暴露 `proxy.binaryState` / `proxy.binaryVersion`（**零憑證**）。
  - **F-B（R1 P0 修復）**：tunnel script 先 **stage 做 file**（base64 → `/data/local/tmp/.t2s-setup.sh` 0700 → `sh <file>`）先執行 — exec seam 嘅 runner cmdline 唔含 script text，in-file `pkill -f "[t]un2socks"` 只會匹配真 daemon。舊 code 嘅 inline script + `pkill -f tun2socks` = **自殺式**（runner 自身被殺 rc=143，隧道永遠 provision 唔到；重現記錄 `docs/audits/repair-baseline.md` §5.4）。
- 代理 URL 加密存 DB（`proxyUrlEncrypted`，`v1:` 前綴）；API view 只暴露 `hasProxyUrl` / `gostPort` / `proxyState`（`off|provisioning|running|stopped|error`），**永遠唔輸出明文**。
- tunnel 係 **背景 provision**（等 `sys.boot_completed`，5s poll，**40min timeout** — knob `REDROID_TUNNEL_BOOT_TIMEOUT_MS`，R6 由 600s 校準到 2400s，因為真實 cold/recreate boot 實測 ~24min，舊 10min default 會把健康但慢嘅 boot 硬 fail 成 `REDROID_TUNNEL_BOOT_TIMEOUT`）；gost 係 **同步**（create 時起，失敗 = rollback 連 device 一齊）。

### 10.2 正常狀態驗證（host，`sg docker -c`）

```bash
# 1) 狀態（api view 或 DB）：proxyState=running、gostPort ∈ 20080-20179
sg docker -c "docker ps --filter name=redroid-matrix-b-gost- --format '{{.Names}} {{.Status}}'"
# 2) tun0 + 路由（device 內）— 三個條件缺一不可：
sg docker -c "docker exec <dev> sh -c 'ip addr show tun0; ip route show table 100; ip rule show | grep 5000'"
#    table 100 必有兩條：default via 10.8.0.2 onlink + 172.17.0.1 dev eth0 scope link（gateway exception）
#    必有 rule 5000: from all lookup 100
# 3) canary（tests/mocks/mock-socks5.js 或真 proxy）：device 內 dnsping canary.example → NOERROR
#    ⚠️ R8 實錚（2026-10-21）：`REDROID_CANARY_HOST` 唔可以係 device 直連 segment 內嘅位址（尤其 172.17.0.1 gateway）— table 100 嘅 gateway exception 會令 canary 永遠 direct via eth0，結構性 bypass tunnel（canary 綠 ≠ tunnel 綠）。mock 測試 stack 用 host 嘅非 bridge IP（例 LAN IP，mock-echo bind 0.0.0.0）做 target 先係真 tunnel-forcing；另 canary probe 已改用 FIFO seam（toybox nc stdin-EOF 會 half-close，見 audits/tcp-transport-investigation.md R8 addendum）
```

### 10.3 故障排檢（症狀 → 診斷 → 處理）

| 症狀 | 診斷 | 處理 |
|------|------|------|
| `proxyState=error`，create 失敗 | `docker inspect redroid-matrix-b-gost-<dev>` / api log | 端口撞（DB unique 已防）→ 重試（會重分配）；image pull 失敗 → 檢查 host 網絡 |
| `proxyState=error` + view `proxy.binaryState=missing|invalid` | view 已有 `binaryState` + `binaryVersion`；device 內核 `/data/local/tmp/tun2socks`（存在？0755？`--version` 得唔得？） | image 唔係 R1 契約 build 或 binary 被改壞 → 用 `docker/redroid-matrix/Dockerfile` 重新 build wrapper image（pin 唔變）再重建 device。臨時手動補 binary 唔鼓勵 — 部署契約 = image 內 binary（§10.1） |
| `proxyState=running` 但 device 冇出域 | device 內 `docker exec <dev> sh -c 'tail -20 /data/local/tmp/tun2socks.log'` | t2s 死咗 → 重跑 start action（會重 provision）；log 見 `connection reset by peer`（dial 172.17.0.1:<gostPort>）→ **table 100 缺 gateway exception**（見 10.5 #2）— 重跑 provision script 會重建 |
| `proxyState=error` + netState `FAILED` + `netLastErrorCode=TUNNEL_START_TIMEOUT` / api 曾回 `REDROID_TUNNEL_BOOT_TIMEOUT`(504) | view `proxy.network.lastErrorDetail`（「boot_completed not seen within N s」）＋ host adb 親驗 `getprop sys.boot_completed` | boot 慢（cold/recreate 常 14–24min）：先確認 device 仲喺 boot（container running、`sys.boot_completed` 尚未 =1）→ 唔使做嘢，重跑 start action 再 provision（boot 完即好）；真係 boot 唔到（卡 init / GPU 掛）→ 睇 `docker logs <dev>` 頭 13 秒 crash 口徑（§10.2）；快嘅 host 可以調低 `REDROID_TUNNEL_BOOT_TIMEOUT_MS`（poll 節奏 = `REDROID_TUNNEL_POLL_MS`，default 5s，R7 起可調） |
| t2s log 見 `TUNSETIFF` 錯 | `ip link show` 睇 tun0 有冇殘留 | provision script 本身冪等（pkill + del 先）→ 直接重跑 start |
| tunnel 死咗之後流量「似乎 OK」 | `ip route get 8.8.8.8` + `GET /api/redroid/devices/:id`（`proxy.network.netState`） | **平台層已 fail-closed（R3/R4 實錚）**：watchdog 即刻將 `netState` 置 BLOCKED（definite loss 唔候 threshold）→ worker 唔再派網絡任務、UI 顯示 BLOCKED、audit 有記錄。**kernel 層殘留**（Android app 自己開嘅 socket 可經 eth0 直連）= 已 decide-and-document（§10.9 + README K12）— 見 §10.9 operator 守則 |

### 10.4 Teardown（單 device）

```bash
# 经 api：DELETE device（teardownTunnel + teardownGost + container remove 順序已實現）
# 手動（api 死咗先使）：
# F-B（R1）：pkill 要 bracket pattern — 直書 `sh -c 'pkill -f tun2socks'` 會連 runner 自己一齊殺（rc=143）
sg docker -c "docker exec <dev> sh -c 'pkill -f \"[t]un2socks\"'"   # tun0 隨 process 死
sg docker -c "docker rm -f redroid-matrix-b-gost-<devName>"
```

### 10.5 已知環境行為（2026-10-19 實測 — 唔好當新 bug）

1. **Android netd 間中 block RTM_NEWLINK**（container netns 內 `ip link add` → EOPNOTSUPP；ioctl TUNSETIFF 一直 OK）。provision script 已用 netd-safe 序列：`ip link add` 係 best-effort，tun2socks 自己經 ioctl 建 tun0（兩路都實錚過）。如果 netd 狀態變化令 `ip link add` 又得返，都唔使改 code（兩路兼容）。
2. **gateway exception 唔可以省**：table 100 冇 `172.17.0.1 dev eth0 scope link` 時，gVisor→gost handshake hairpin 返 tun0 → RST → **proxy 零流量但 routing 睇落「正常」**（dev2 實測事故；`ip route get 8.8.8.8` 照常顯示 via tun0）。
3. **TCP-over-TUN：產品鏈已成立、spike 拓撲根因 open（R7 修訂口徑 — 2026-10-21）**：R3/R4 live（真鏈 device→t2s→**gost 容器**→upstream）雙向 TCP canary（nonce+sha256 回顯）**PASS** + watchdog 30s 常規 gate（HEALTHY 唯一入口 = fresh canary PASS）— 見 `docs/audits/fail-closed-validation.md` + `docs/live-evidence/r3|r4-20261020/`。⚠️ 邊界：R2 spike 拓撲（t2s 第一跳 = **裸** mock relay，無 gost）實錚過 forward-stall（SYN 過 payload 唔過），根因未完全裁定（`docs/audits/tcp-transport-investigation.md` R7 addendum §C）— 產品唔存在裸第一跳配置（gost 永遠第一跳）→ 現行 fleet 無影響；**引入任何非 gost 第一跳拓撲 = 必須先重跑 R2 八層矩陣**（README K1）。
4. **mock 用舊 code 起過 → 靜默 RST**：`tests/mocks/mock-socks5.js` 修過 UDP ASSOCIATE / gVisor relay framing（commit `18f8139`）；起 mock 前確認系修後版本，否則 device 端只見到 `connection reset by peer` 而 mock 零記錄。
5. **rule 5000 要兜底**：netd 只為佢「註冊過」嘅 TUN 建 rule 5000；ioctl 建嘅 TUN netd 唔知 → script 有 EEXIST-safe 兜底（`ip rule add priority 5000 from all lookup 100`）。

### 10.6 實錚證據（2026-10-19 14:24 UTC，2 device 2 路）

- dev1(172.17.0.3) → mock1(172.17.0.1:20082)：`canary.example` = NOERROR + A 93.184.216.34
- dev2(172.17.0.4) → mock2(172.17.0.1:20084)：`canary.example` = NOERROR + A 93.184.216.34；`other.example` = NXDOMAIN
- 各 mock 只見到自己嗰部 device 嘅源 IP（路由隔離成立）。詳細 log / 過程：`logs/redroid-matrix-B-progress.md`。
- **TCP 級實錚（R3/R4，2026-10-20 — 上列 DNS 實錚之後）**：雙向 TCP payload canary（nonce+sha256 回顯，~1s）行完整真鏈 PASS + kill/canary-down 故障注入全循環（DEGRADED/BLOCKED/recovery → HEALTHY，recovery ledger 9 episodes 全部 exactly-one）— `docs/live-evidence/r3-20261020/summary.md`（時間線）+ `docs/audits/fail-closed-validation.md` §2（全矩陣）。

### 10.7 adbd recreate stall（R5 live 實測 — 2026-10-20；R6 decide-and-document）

**症狀**：device recreate（delete + 同名重建 / 重新 create）後，container `running`、Android 實際 boot 咗，但 host adb 永遠 `offline` —— `adbState=offline` 而 `containerState=running`。R5 live：recreate **100% 中招**；fresh boot（全新 create）唔中招；stop/start 循環亦唔中招 → 係 recreate 特有嘅 container-runtime 行為（adbd host-protocol 未重新掛接），唔係 product 回歸。

**machine-readable signature（diagnostics zone 3 自動標記）**：container `running` + 上次確認過 `adbState=online`（persisted）+ 而家 adbd 無回應 → diagnostics `adbConnectivity` 帶 `suspectedHostProtocolStall:true` + `hint`（見 runbook §10.7）。⚠️ `suspected` 就係 suspected：合法嘅 adbd 死法（system 重啟、adbd crash）signature 一樣，要 recovery 先確認。

**點解 product 唔自動 recovery（決定，唔係遺漏）**：
1. **whitelist scope**：adb 引擎只放 5 個 read-only op（`getprop/dumpsys/logcat/connect/get-state`）——冇 `shell`/`setprop`，所以 `setprop ctl.restart adbd` 根本唔喺 product 能力內；為咗呢一個 stall 去 expand whitelist 加 shell op = 擴攻擊面（§8.2 明確相反方向），唔做。
2. **container restart 實測無效**：R5 live 試過經 API 全 container restart，stall 無清 → 自動重啟都救唔到，做咗反而多一個破壞性自動動作。
3. **誠實優先**：而家 product 已經 honest 報 `containerState=running` + `adbState=offline`（R6 起 diagnostics 加 `suspectedHostProtocolStall`），operator 見到 signature 就有明確下一步；靜默自動重啟反而抹走跡象。

**recovery（operator，admin）**：
1. 確認 signature：`GET/POST .../diagnostics` 看 `adbConnectivity.suspectedHostProtocolStall=true`（或親驗 `container running` + `adb -s 127.0.0.1:<port> get-state` = `offline` + 之前確確實實 online 過）。
2. 首選：**API 再 recreate 一次**（delete → 同 template 重建；`removeData` 按需——唔 tick 就保留 `/data`，F-Droid/設定跟住）；recreate 完 boot 完（14–24min，§10.1）→ `adbState` 回 `online`。
3. 仲係 offline：落到 host 級——`sg docker -c "docker restart redroid-matrix-b-<dev>"`（等同 API restart，R5 已試可能無效）；或核 host adb server 本身（`adb kill-server && adb start-server`，只影響 host 層 adb client，唔郁 device）。
4. 仍無解：當 container-runtime/kernel 層問題升上嚟（留 `docker inspect` + diagnostics 輸出），唔好喺 product 層再試。

**防復發**：R6 已將 signature 做咗 machine-readable（`suspectedHostProtocolStall`）+ 本節 runbook；product 層刻意保持「只 surface、唔自動重啟」。

### 10.8 代理憑證輪替 / 刪除（MD §8.2 — secret handling）

**儲存契約**：proxy URL（含 `user:pass`）只以 **AES-256-GCM 密文**（`v1:` 前綴，key = `APP_ENCRYPTION_KEY`）存 DB（`redroid_templates.proxyUrlEncrypted` + `devices.proxyUrlEncrypted`，device create 時從 template 複製 = **device 自己一份**）。API view / list / audit / log **永遠唔輸出 URL**：view 只出 `hasUrl` / `gostPort` / `proxyState` / `network`；audit detail 只出 `proxyChanged: true/false`（唔出 URL）；校驗錯誤（`proxyUrl must look like socks5://...`）同解密失敗（`REDROID_PROXY_CONFIG_INVALID`）都**唔回顯 URL**。唯一持有明文的界 = docker host（gost container `Cmd` 帶 `-F <upstream>`）——documented risk：docker host root 可讀，唔係 product 層新風險（§10.1）。

**輪替（改上游 proxy 憑證）**：
1. **先喺上游換**（舊憑證仲有效嘅窗口），唔好先 revoke 舊嘅再落新嘅（gap = fleet 斷出口）。
2. template 層：`PUT /api/redroid/templates/:id {proxyUrl: "socks5://newuser:newpass@host:port"}`（admin）→ 重新加密落庫（audit `proxyChanged:true`）。
3. **既有 device 唔會自動跟**（device 持有自己 create 時嘅密文副本；proxy 綁定 per-device immutable by design — 冇 in-place 改 proxy 嘅 API，呢個係有意嘅：改 = 重建，避免半改狀態）。要換既有 device 嘅出口：delete → 同 template 重建（`removeData` 唔 tick = 保留 `/data`）。
4. 重建 / start 後 verify：`proxyState` → `network.state=HEALTHY`（canary PASS 先算數，fail-closed）。

**刪除**：
- template 嘅 proxy：`PUT /api/redroid/templates/:id {proxyUrl: null}` → 密文清掉（DB null；view `hasUrl:false`）。
- device 嘅 proxy：冇獨立「清 proxy」API（同上 immutable-by-design）— delete device（row 消 = 密文消）即洗；要留 device 但改回 template 預設 = 重建。
- **上游憑證 revoke**：等所有 device 都轉完 / 重完先 revoke（先新後舊，避免 fleet 斷出口）。

**`APP_ENCRYPTION_KEY` 輪替 × proxy 密文（誠實代價，跟 §3.4）**：key 換咗之後，**所有** `proxyUrlEncrypted`（template + device）解唔開 → 用嗰下（provision / 重 provision）= `REDROID_PROXY_CONFIG_INVALID` 500（**唔係靜默失敗**）。所以 §3.4 流程做唔做完，都要跟住：
1. 所有 template 用 `PUT {proxyUrl: <原明文>}` 重傳（重新加密）；
2. 既有 device：冇 in-place 重傳 API（immutable-by-design）→ 有需要嘅 device 重建（原明文 URL 喺手先做得到）；
3. 原明文 URL 唔喺手 = 要喺上游重發憑證（同 §3.4 provider 口徑）。

**測試 fixture 紀律（§8.2）**：所有 test 嘅 proxy URL 係假 target（`proxy-a.example` / `10.9.9.9` / `fixture-user:fixture-pass`），零真憑證；`.env` 永唔提交（`.env.example` 只列 program 真讀嘅變數 + 佔位符）。

### 10.9 Kernel 層 fail-open 殘留風險 + operator 守則（R7 decide-and-document — 2026-10-21）

**平台層（已實錚，R3/R4）＝ 有效防線**：tunnel/process/data-plane 任何失效 →
watchdog 將 `netState` 置 **BLOCKED**（definite loss 立即；soft 路徑 threshold 2）或
**FAILED**（max retry 3 次後 + manual door）→ worker 網絡任務 gate
（`networkReady=false`）**唔派發**任何依賴網絡嘅任務；UI 文字 badge + audit row 全透明。
「设备唔會繼續執行依賴網絡嘅任務」= 平台管嘅任務 — 實錚成立
（`docs/audits/fail-closed-validation.md`）。

**殘留（誠實項）＝ kernel 層 egress**：tunnel 死 → tun0 消失 → routing shadow
消失 → **Android app 自己開嘅 socket**（平台 task 以外）可以經 eth0（docker
bridge）直連出去 — 平台層 BLOCKED 唔阻斷呢條路。窗口 = 失效到 watchdog 下一次
tick（≤ `REDROID_HEALTH_POLL_MS` 30s；definite loss 下實測 +2s 已 BLOCKED）。

**點解唔喺修復鏈內實裝 iptables 兜底（R7 決定，同 R6 adbd stall 口徑）**：
1. Android **netd 擁有**容器 netns 嘅 iptables 規則 — 產品級 default-DROP 會同
   netd 嘅 connectivity 管理互踩（規則被 flush = 假安全）；netd 行為未 spike。
2. R2 已實錚容器內 iptables build 係阉割版（無 `nat` 表、無 `xt_REDIRECT`）—
   可用面比想像窄。
3. 正確做法 = 獨立 spike（netd 互踩實測）→ ADR → 安全評審 → 實裝 — **另開 P0
   單**（backlog；README K12）。

**Operator 守則（而家生效）**：
- `netState = BLOCKED/FAILED` 嘅 device = **視其 egress 為 untrusted/unmanaged**：
  唔好畀佢任何外向功能（webhook 回調、第三方 API 推送等）；需要硬隔離嘅部署，
  喺 **host 層 firewall**（docker 網絡/ufw/nftables — host 層唔受 netd 影響）限
  redroid 容器 egress 只准去本 device 嘅 gost 容器（`172.17.0.1:<gostPort>`）+
  host loopback（ADB）。
- audit 有完整時間線（每次 netState 轉移 = audit row，source + 原因 + 時間）—
  事後審計窗口內嘅流量暴露可用 `netLastChangeAt` 收窄。
- 長期 = 等 P0 單（netns DROP + netd spike）落地。

**2026-10-22 實測 addendum（BR-Acceptance C — kernel 層 egress live 實測）**：
隔離 + 可逆嘅 scratch 實測（harness：`scripts/br-b6-egress/`；evidence：workspace
`logs/br-b6-egress/`，唔入 repo）用真實 per-device tunnel wiring（matrixa-r3
digest pin + gost digest pin + 本 repo 嘅 tunnel setup sequence）喺專用 bridge
（`br-b6e-*`，零 host 規則、零 host 埠、零 touch 現有網絡/服務）實測：
1. kernel 層 fail-open 窗口（tunnel 死 → app 型 socket 經 eth0 直連出口）；
2. fail-closed 隔離策略（Docker `--internal` 網絡；root nft 逐規則 counter 變體
   = `nft-failclosed-template.nft`，本服務用戶無 CAP_NET_ADMIN → 未執行，標 BLOCKED）。
- 正式口徑：Batch Rotation 程式及沙箱 E2E 已完成；真機 50 容器容量、完整
  warm-rotation 與 Batch Rotation live egress 尚待驗收 → **C 項實測結果**
  （完成後填實：每場景 PASS/FAIL/SKIPPED/BLOCKED + 證據路徑；netns 層驗證
  （boot 前）誠實標註）：**完成 2026-10-22 — 8/8 場景 PASS**（詳細：workspace
  `logs/br-b6-egress/acceptance.md`，不入 repo）。
  - **Q1 fail-open（open net，tunnel 死）= 實錚成立**：t2s 死 → kernel 釋放 tun0 →
    table-100 default 消失 → main/per-net table → eth0；canary（container）收到**直連**
    probe，src IP = device container IP（非 gost IP）= 核心 fail-open 證據。
  - **Q2 fail-closed（`--internal` net，tunnel 死）= 實錚成立（FIB 層，比 FORWARD 更強）**：
    canary **0 直連**；`ip route get <target>` = `Network unreachable`；Control A（手加
    main default route）都打唔败 — netns 有 `32000: from all unreachable` catch-all rule。
    機理：internal net 嘅 per-net table 無 default → walk 落 unreachable rule；open net 有
    default（table 1002）→ 直連可行。attribution caveat：本 host 一般性 inter-net FORWARD
    isolation（Control B 實錚），per-layer iptables 歸因 = root nft 變體 = BLOCKED。
  - **Code finding（交平台團隊）**：`redroid-health.js` L191 netcheck `grep "table 100"`
    係 substring match → 會誤 match "table 1002"（docker per-net table）→ tunnel 死時
    `effective` 誤報 tunnel。實際影響 LOW（`classifyNetcheck` 經 iface/route=missing 已先
    返 definite→BLOCKED，平台判定正確），但 raw field 誤導。建議：`grep "table 100[[:space:]]"`。
  - 本測試 **≠ Batch Rotation 真 egress 生產驗收**；kernel 層發現係其輸入。Batch Rotation
    live egress 狀態：**照樣 NOT VERIFIED**（另立大單）。驗證層 = **netns 層（boot 前）**：
    routes/rules/tun0 係 netns-global，Android container 見同一 kernel 狀態；honest label。

## 11. Batch Rotation 監控／告警應變（BR-B5 — MD Phase 5）

### 11.1 日常睇法
- **UI**：`#monitor`（Live Monitor — 5s auto-refresh：current batch、計數、containers、host、deps、alerts、task 表）／`#batches`（Planner — preview 預設，Start 要打 `start` 二次確認）／`#identities`（身份列表 + 詳情，零秘密）／`#reports`（cycle 匯出 JSON/CSV，operator+）。
- **API**：`GET /api/batch-monitor/summary`（整屏 snapshot）／`GET /api/batches/metrics`（MD §13 14 metric + alerts）／`GET /api/identities[/:id]`／`GET /api/batch-reports[/:cycleId?format=csv]`。
- 探測降級口徑：Docker down = `containers: null`；host probe 失敗 = `host: null`；**endpoint 仍然 200，唔會 500**（500 只留俾真錯誤 + secret 硬門 `REPORT_SECRET_TRIP`）。

### 11.2 Metric 對照（`/api/batches/metrics` → MD §13 名）
| MD §13 metric | 來源 |
|---|---|
| `batch_active_count` / `batch_queued_count` / `batch_failed_count` | `TaskRun` status 計數（global + 本 cycle） |
| `active_containers` | Docker list（managed label + exception，`containers.running`） |
| `container_start_duration_seconds` | `batch_state` `container_start` 事件（24h 窗口）p50/p95/max + fail 計數 |
| `task_run_duration_seconds` | `TaskRun`（finished − started）p50/p95/max（24h 窗口） |
| `task_retry_total` / `task_timeout_total` | 成功 retry 後最終完成 / `errorCode` 含 TIMEOUT 嘅 run |
| `worker_heartbeat_age_seconds` | 最舊 active run 嘅 heartbeat 年齡（無 active = null） |
| `expired_lease_total` | `ResourceLease.leaseExpiresAt <= now` 且未釋放 |
| `host_memory_available_bytes` / `host_disk_available_bytes` | host probe（`/proc/meminfo` + data root statfs；失敗 = null） |
| `network_policy_denied_total` / `network_health_failures_total` | BR-B4 network policy 匯出（deny 計數 / health fail 計數） |

### 11.3 Alert 應變（`alerts[]`：severity critical 先）
| alert code | 意義 | 應變 |
|---|---|---|
| `active_over_capacity` | active containers > `batch.global_max_active_containers` | 暫停派新 batch（UI Stop/Pause — operator+）；核 capacity 設定 |
| `worker_heartbeat_stale` | active run 心跳過期 | 查 worker 存活（`docker logs` / queue stalled）；lease 到期會自動重新指派 |
| `dependency_unavailable`（db/redis/docker） | 關鍵依賴 probe 失敗 | 跟對應 runbook 章節（§1 重啟／§2 queue／§10 proxy）；API 本身降級繼續服務 |
| `disk_low` | data root 可用磁碟低於門檻 | 清老 container/data dir（admin 判斷，§4 高危操作）；暫停 batch |
| `container_start_failures` | 24h 內連續啟動失敗超門檻 | 核 image / disk / docker daemon；`container_start` 事件有 fail 詳情 |
| `task_unknown_persistent` | task 持續 UNKNOWN（狀態機失步） | 對 `TaskRun` vs container 實際狀態；手動修正前審計 |
| `orphan_managed_container` | managed container 無有效 identity label | `docker inspect` 核 label → 手工歸屬或（admin）清理；**唔好 blind kill** |
| `network_policy_unavailable` | B4 policy 檢查器不可用 | fail-closed：網絡任務應被擋；查 policy 模組狀態 |

**Alert 落地**（MD §13）：repo 無獨立 alert channel → 三軌 = ①可查詢狀態（`/api/batches/metrics` + summary `alerts[]`：code/severity/detail/fingerprint/firstSeen）②pino 日誌（critical → `level: error`，其餘 `warn`；同 fingerprint 去重，每小時最多 re-log 一次）③audit（`batch_alert_raised` 首次 fire＋`batch_alert_cleared` 恢復；hourly re-audit 上限）。

### 11.4 報告匯出（MD §11.4）
- `GET /api/batch-reports/:cycleId?format=json|csv`（**operator+**；viewer = 403）。
- 匯出體 = 各 identity 終態、成功/失敗/跳過統計、嘗試次數、失敗原因（`errorMessage` 經 `maskCredentialShapedValues` 遮罩）、資源峰值、時間範圍 — **零秘密硬門**：builder 入場先 `scrubObject` + `assertNoSecrets`，觸發 = 500 `REPORT_SECRET_TRIP`（寧缺毋漏）；每次匯出寫 audit（`batch_report_export`：cycleId、format、actor、requestId）。
- CSV = 每行一 identity（stable ID、終態、attempt、失敗碼、錯誤摘要遮罩）— 供 Excel 分析；JSON = 完整結構（UI 下載 + 檔案歸檔）。

### 11.5 Batch 操作與故障應變（BR-B6 實測補齊，2026-10-22）

**開 cycle（正常流）**：
1. `POST /api/batches/preview`（operator+）— 純讀；看每一 batch 的預測結果（unknown id 只喺呢度報告）。
2. `POST /api/batches`（同 body）— strict：unknown id = 400；DISABLED/terminal identity = SKIPPED 帶 `skipReason`（同 preview 一致）。`idempotencyKey` 冪等：重打 = 200 同 cycleId。
3. `POST /api/batches/:id/start` — 冪等（已 RUNNING = `{started:false, reason:'already-running'}`，唔會雙派工）。scheduler 都會 auto-start，兩者競合安全。

**容量**：`GET/POST /api/batches/capacity`（**admin only**）— 全局 `maxActiveContainers`；`effective = min(batch 自己嘅 cap, globalCap ?? ∞)`。`POST {maxActiveContainers: null}` = 清除全局上限。

**停止語義（三級，data 保留铁律 — MD Phase 3 item 4）**：
| 動作 | 容器 | port lease | **identity data** |
|---|---|---|---|
| `POST /api/batches/:id/cancel` / task-run cancel | best-effort stop | 釋放 | **保留** |
| `containers/stop`（可逆） | exit | 釋放 | **保留**（可再 start） |
| `containers/remove` | 刪除 | 已釋放 | **保留**（冪等） |
| `POST /api/identities/:id/purge`（**admin+human only**，service token 拒） | ownership-gated stop+remove | 已釋放 | **唯一抹 data 嘅路徑**；`dryRun=true` 預覽零改動；實抹要 `confirm` = identity id |

**Reconcile（orphan 清理）**：`POST /api/batch-containers/reconcile`（operator+）— 掃 ①無 label 嘅 managed 容器 ②stale lease ③DB 有 run 無容器。`fix=true` 先會動手（stop+remove orphan、release 死 lease、孤立 run → FAILED_FINAL `ORPHAN_RECLAIMED`）；所有動作有 audit row。worker 正常運行時每 5 分鐘 scheduler 自帶一轮，手動 reconcile 主要係事故後核對。

**故障應變（按組件）**：
| 故障 | 觀測 | 應變 | 收斂 |
|---|---|---|---|
| worker 重啟 / SIGKILL | active run 心跳斷 → `worker_heartbeat_stale` | 重啟 worker（compose restart 或新 process） | lease 到期（TTL 8s）→ 下個 tick reconciler 重新指派；已 running 容器由新 worker **adopt**（S4② hermetic 實測：一 create、一容器、run 完成）— 唔會雙跑 |
| API 重啟 | 短時間 503/拒連 | 重啟 | DB 係 source of truth；queue job 照喺 Redis；worker 唔受影響；重啟後 scheduler auto-start 繼續 |
| Redis 斷 | queue 唔可用 → scheduler **停止派新工**（唔會 blind 派）；在跑容器照跑完 | 修復 Redis（AOF 損壞 → §1 第 5 條） | 復原後 queue drain + scheduler 繼續；BR-B6 live 故障注入實測（15s 中斷）：中斷窗口內 `attempt_started` 計數零增加（派工真停），無漏單無雙跑（evidence: `logs/br-b6-e2e/fault-summary.json`） |
| Postgres 斷 | API `/api/health/ready` = 503（誠實，唔假 200）；worker 心跳失敗 → 在跑 run **fail-closed**（slot lease lost → 容器 best-effort stop、volume 保留） | 修復 PG（`pg_ctl` / volume 檢查） | 復原後 reconciler 收斂：retryable 失敗自動重派、終態失敗誠實 FAILED_FINAL；BR-B6 live 實測（15s 中斷）：每 identity 有且只有一個終態結果（evidence: 同上） |
| worker kill + Redis 斷（組合） | 雙重 | 同時復原（先 Redis 再起 worker） | reconciler 收斂，零漏單零雙跑（BR-B6 F3 live 實測） |
| Docker daemon 斷 | 所有容器操作 fail-closed（**冇任何 op 會被當成功**） | 重啟 daemon（**注意：shared daemon 上 user compose 會一齊停 — 生產要獨立 daemon 或者接受全停**） | 復原後 adopt + reconcile；hermetic 實測 S4③（daemon-down fail-closed）。BR-B6 未 live 停 daemon（shared daemon = user compose 紅線） |
| image 404 / port 池用盡 | `IMAGE_NOT_FOUND`（404）/ `PORT_POOL_EXHAUSTED`（503） | 404 = 永久失敗（第一次即 FAILED_FINAL，唔會重試耗）；503 = RETRY_WAIT 指數 backoff 到上限 | S4① hermetic 實測 |

**Rate limit（429）**：人工 operator 20 寫/60s（batch 寫 + purge 獨立 budget）；**service lane（`x-wa-service-token`）豁免**（受 global cap 支配）；429 對 scheduler 係 retryable（park RETRY_WAIT，下 tick 重派）— 唔會誤判永久失敗。
