# water_army 修復基線盤點（R0 / Phase 0）

> 施工 MD：`water_army_repair` §2（Phase 0 — Repository 與部署基線盤點，P0）
> 執行：CTO agent（subtask `mvfhu8i2bqvtr`，parent `mvfhu8i2y4a55`）
> 日期：2026-10-20 00:54–01:30 HKT
> 性質：**只讀 + docs-only**（零 code/config 改動、零 destructive 操作；所有測試 container 用 `redroid-matrix-r0-*` 前綴，已全數清理）

---

## 1. Repository 狀態

| 項目 | 值 |
|------|-----|
| commit SHA | `e31201f`（`[water-army-matrix] README: reflect security patch + redroid matrix Stage A/B`） |
| branch | `main`（up to date with `origin/main`，worktree clean） |
| remote | `origin` = `git@github.com:MirrorSocialmedia/water_army.git` |
| Node.js | host = **v22.22.2**、npm 10.9.7 |
| 版本要求 | `package.json` `engines: node >=24`、`.nvmrc = 24` — **host 冇 Node 24**（nvm 無 versions 目錄）。基線測試行咗 Node 22，見 §6 備註 |
| 套件管理器 | npm workspaces（`apps/*`、`packages/*`）；lockfile = `package-lock.json`（已 commit） |
| `.env` | 未 track（只有 `.env.example` 入 repo）— 無洩密 |
| CI | **無**（`.github/` 不存在） |
| lint / typecheck | **無**（全 repo 無 eslint/biome/prettier/TS config） |

## 2. Docker 基線

| 項目 | 值 |
|------|-----|
| Engine | 29.1.3（API 1.52，go1.24.4；containerd 2.2.1、runc 1.3.4） |
| Compose | v2.40.3 |
| `docker compose config --quiet` | **exit 0** |

### 2.1 compose.yaml 全量盤點

- **services（5）**：
  - `web` — build（context `.`，`docker/web.Dockerfile`，image `water-army/web:local`）；**host port 只綁 127.0.0.1:3012→3012**；healthcheck = `fetch('http://127.0.0.1:3012/')`；read_only + tmpfs + no-new-privileges + cap_drop ALL。
  - `api` — build（`docker/api.Dockerfile`，`water-army/api:local`）；**無 host port**（web 反代 `/api`→`api:3000`）；`group_add: ${DOCKER_GROUP_ID:-125}`；volumes = **`/var/run/docker.sock:ro`（全 stack 唯一）+ `/var/lib/water-army` bind**；healthcheck = `/api/health/live`；read_only 等同上。
  - `worker` — build（`docker/worker.Dockerfile`，`water-army/worker:local`）；**無 Docker socket**（hard boundary）；health port 3001 僅 container 內。
  - `postgres` — `postgres:17.6`（tag pin，非 digest）；**無 host port**；volume `pgdata`；healthcheck `pg_isready`。
  - `redis` — `redis:7.4.5`；AOF（`--appendonly yes`）；**無 host port**；volume `redisdata`；healthcheck `redis-cli ping`。
- **networks**：無顯式 network section → 隱式 default（bridge）。
- **volumes**：named = `pgdata`、`redisdata`；bind = `/var/lib/water-army`（api only）。
- **profiles**：無。
- **healthcheck**：5/5 services 有（web 15s/5s/5 重試/10s start；api、worker 15s/5s/10/30s 或 20s；pg/redis 5s/5s/12）。
- **build context**：web/api/worker = repo 根目錄（各自 Dockerfile）；pg/redis = 外部 pin image。
- 強制變數（缺即 compose 拒絕起）：`APP_ENCRYPTION_KEY`、`SESSION_SECRET`、`POSTGRES_PASSWORD`、`WORKER_API_TOKEN`。

## 3. 測試主機基本資訊

| 項目 | 值 |
|------|-----|
| OS / kernel | Linux 6.8.0-117-generic（x64，Ubuntu 24.04 docker buildpack） |
| binder | `binder_linux` module 已載入；binderfs 掛於 `/dev/binder`（`binder-control` 0600 + `features/` — host 只係需要 mount 存在，chardev 節點由 wrapper image 容器內自建） |
| GPU | 2× NVIDIA RTX 3090 24GB，driver 580.178.04（`nvidia-smi` OK） |
| data root | `/var/lib/water-army`（750，uid:gid 1000:1000 = api 容器用戶 kenneth）；現存 `redroid/redroid-ceo-verify-a`（Stage A 殘留 1.4MB，**照指示保留**）+ 本單 smoke 後殘留 `redroid/redroid-matrix-r0-smoke`（11MB，記錄於此，**照指示保留**） |
| 磁碟 | `/` 1.9T，1.1T 可用 |
| 現有 stack | water-army compose 5 容器全 healthy（7–10h uptime）— **全程未郁**；sglang 等既有服務未觸 |
| ADB host tool | `/home/kenneth/.openclaw/workspace/tools/platform-tools/adb` |

本單測試用 port（全部 self-pick，避開禁口 15532/15432/3001/3011/3100/3008/9800/30000 同 ADB 15000-15999）：
mock socks5 = **20260**、mock sink = **20261**、disposable redis = **16379**、smoke ADB = **16001**（16000 段）。全部已釋放（`ss -ltn` 核過 zero listener）。

## 4. 檔案盤點（MD §2.2 find）

```
./compose.yaml
./docker/api.Dockerfile
./docker/redroid-matrix/Dockerfile
./docker/redroid-matrix/redroid-binder-init.c
./docker/web.Dockerfile
./docker/worker.Dockerfile
./docs/api-reference.md
./docs/architecture-decisions.md
./docs/runbook.md
./prisma/seed-redroid-templates.js
./scripts/redroid-host-setup.sh
./tests/helpers/redroid-fakes.js
./tests/integration/redroid-diagnostics.test.js
./tests/integration/redroid-lifecycle.test.js
./tests/integration/redroid-proxy.test.js
./tests/unit/redroid-seed.test.js
```

重點檔案結論：

| 檔案 | 結論 |
|------|------|
| `docker/redroid-matrix/Dockerfile` | multi-stage：`ubuntu:24.04`（dated，禁 latest）builder 用 gcc `-static` 編 `redroid-binder-init.c` → final `redroid/redroid:14.0.0-240527` + `COPY` static entrypoint + `ENTRYPOINT`。**無 tun2socks 任何步驟**（見 §5） |
| `docker/redroid-matrix/redroid-binder-init.c` | 靜態 C：private binderfs mount → `BINDER_CTL_ADD` ioctl 建 binder/hwbinder/vndbinder → `chmod 0666` → bind-mount 上 `/dev/{binder,hwbinder,vndbinder}` → exec `/init qemu=1 androidboot.hardware=redroid …`（container-local，host 零改動） |
| `scripts/redroid-host-setup.sh` | root 一次性冪等 script：`modprobe binder_linux` + `/etc/modules`、binderfs mount + fstab、`/var/lib/water-army` chown 1000:1000。host 已執行過（狀態核對 §3） |
| `apps/api/src/services/redroid-service.js`（1493 行） | 裝置/模板/proxy 全生命週期；路徑引用 `/data/local/tmp/tun2socks`（`TUN.bin` :90、`logFile` :91）；`tun2socks v2.7.0 baked into the wrapper image` 註釋（:61）**與事實不符**（§5） |
| `prisma/seed-redroid-templates.js` | 2 個 seed 模板：`redroid-15-gpu-privileged`（`redroid/redroid:15.0.0`、privileged+host GPU）、`redroid-14-swiftshader`（`redroid/redroid:14.0.0`、swiftshader）。**兩個 image 都唔係 wrapper、都唔係 -240527 tag**（§5.3） |
| `docs/runbook.md` §9/§10 | Stage A/B 實測記錄；§10.1 聲稱 tun2socks「bake 入 wrapper image」+ sha256 `98d545a6…c031`（stale，見 §5.4）；§10.3 已自述 fail-open 行為；§10.5 已自述 TCP-over-TUN payload 限制 |
| `docs/api-reference.md`、`docs/architecture-decisions.md` | 存在（Phase 7 同步用；本單未逐字核） |

其他：`tests/mocks/{mock-socks5.js, mock-sink.js, mock-socks5-diag.js}`（Stage B 可重用 mock，本單 §7 有重用）；`e2e/{p6-e2e,secret-redaction-e2e,seed-e2e}.mjs`（playwright，需 live stack，唔喺 `npm test` 範圍）；`scripts/test-real-redis.sh`。

## 5. tun2socks binary 生命週期（P0 §3.1 疑點 — 實測全鏈路）

### 5.1 三層核對（build context → build stage → 最終映像 → runtime）

| 層 | 檢查 | 結果 |
|----|------|------|
| build context | `find . -iname '*tun2socks*'`（repo 全掃，含 scripts/docker） | **repo 零檔案、零下載 script、零 COPY/ADD** |
| build stage | 逐個 Dockerfile（api/web/worker/redroid-matrix） | 無 tun2socks 步驟；wrapper 只編 binder entrypoint |
| 最終映像（host 現有） | `docker create` + `docker cp redroid-matrix-r0-binchk:/data/local/tmp/tun2socks` 於 `water-army/redroid:14.0.0-240527-matrixa` | **`Could not find the file /data/local/tmp/tun2socks`（MISSING）**；entrypoint `/usr/local/bin/redroid-binder-init` 存在（static ELF x86-64，790360B，0755） |
| fresh build 重現 | `docker build -f docker/redroid-matrix/Dockerfile -t redroid-matrix-r0-matrixa-rebuild docker/redroid-matrix` | **exit 0，產出 image ID `c9c4e6e5c6e9` = host matrixa 同一個 ID** → wrapper 由 repo 源碼 100% 可重現；tun2socks 依然缺失（同源必然） |
| runtime 路徑 | `buildTunnelSetupScript`（redroid-service.js:173-193）`nohup /data/local/tmp/tun2socks --device tun0 --proxy socks5://172.17.0.1:<gostPort>` | fresh 裝置上此路徑唔存在 → 背景 exec 失敗 → 脚本尾 `ps -ef \| grep [t]un2socks` 失敗 → exit 1 → `REDROID_TUNNEL_PROVISION_FAILED`（proxyState=error）— **錯誤會浮出，但代價係先等裝置 boot 完（數分鐘）先失敗** |

### 5.2 binary 實際來源（對照 Stage B 記錄 `logs/redroid-matrix-B-progress.md`，host 上有、repo 無）

- 來源：`xjasonlyu/tun2socks` **v2.7.0**（2026-07-12，當時最新 release）`linux-amd64`，fully static ELF（x86-64 stripped）。
- pin：sha256 `98d545a663b790b4a4100d0c796e1d43d82c5442efdb6e9c4d82e2e32e99c031` — **只寫喺 Stage B progress doc 同 runbook §10.1，repo 內無 checksum 檔、無下載 script、無版本常數**。
- host 上唯一實體：`/tmp/redroid-b-spike/t2s/tun2socks-linux-amd64`（11780222B，`file` = ELF 64-bit x86-64 static，**sha256 核對 = 匹配**）。`/tmp` = volatile — **唔構成部署**（reboot 即失）。
- Stage B 當時嘅部署路徑（progress:54）：「bake 入 wrapper image（matrixb = FROM matrixa + COPY 靜態 binary）」— **`matrixb` image 已唔喺 host**（`docker images` 只剩 `water-army/redroid:14.0.0-240527-matrixa`、`redroid/redroid:14.0.0-240527`、`redroid-matrix-b-capimg:latest`（後者 = debian+tcpdump 診斷用，同 binary 無關））。即：**部署狀態唔可重現、唔可審計**。
- 結論：**MD §3.1 疑點成立** — 最終映像（repo 可重建嗰個）無 binary；「baked into wrapper image」係對一個已消失 ad-hoc image 嘅描述；fresh clone + fresh build 嘅裝置永遠 `proxyState=error`。

### 5.3 第三重 image 不一致（template 層）

seed 模板 image = `redroid/redroid:15.0.0` / `redroid/redroid:14.0.0`（上游裸 image）— 唔係 wrapper（`…-matrixa`）、亦唔係 Stage A 實測過嘅 `14.0.0-240527` tag。用 seed 模板建裝置 = 無 binder entrypoint → 喺呢個 host 會 boot 即 abort（Dockerfile 頭註釋記錄嘅 `Binder driver '/dev/binder' could not be opened` 行為）。Stage A 實測用嘅 `matrix-a-host` 模板係 API 手建（repo 外）。**即：repo 內任何 template 都建唔到可 boot 裝置**。

### 5.4 新發現 F-B（本單實測 — P0 級）：`pkill -f` 自殺式 provisioning

`buildTunnelSetupScript` 第 2 行 `pkill -f tun2socks`（redroid-service.js:179）。生產執行路徑 = `execInContainer`（:355）→ `docker exec … sh -c '<整段 script 文字>'`（同 adb shell 一樣，**script 文字喺 runner 嘅 cmdline 入面**）。`pkill -f` 用 regex 匹配全 cmdline → **匹配到 runner sh 自己**（cmdline 含字串 "tun2socks"）→ kill 自己個 shell：

```
$ sg docker -c "docker exec redroid-matrix-r0-smoke sh -c 'pkill -f tun2socks 2>/dev/null; echo after-pkill-still-alive'"
（無任何輸出）rc=143   # SIGTERM
```

實測 ×2（adb shell、docker exec）皆中。含義：**即使 binary 存在，repo 現行 code 嘅 tunnel provisioning 都會喺第 2 行死**（`set -e` 下 exec 回 143 → `proxyState=error`）。Stage B 當時成功必然用咗 file-based 執行（push script 上裝置再 `sh /path/script` — 呢個 R0 workaround 就係咁跑通嘅，見 §7），但 repo/工單未記錄。修法方向（俾 R1）：bracket pattern `pkill -f '[t]un2socks'`（regex 唔會匹配自己嘅字面 pattern — R0 實測有效）或 file-based staging。

### 5.5 stale 文件聲稱（需 Phase 7 同步）

- `redroid-service.js:61`「tun2socks v2.7.0 baked into the wrapper image」— 錯（對 repo 可重建 image）。
- `docs/runbook.md` §10.1 同樣聲稱 + sha256 前綴 — 錯（同上；sha256 本身對，載體錯）。
- runbook §10.2 驗收指令 presuppose binary 存在（`tail /data/local/tmp/tun2socks.log`）。

## 6. 網絡執行流程地圖（file:line 全部指到）

全部喺 `apps/api/src/services/redroid-service.js`（除註明者外）：

| 步驟 | 位置 | 行為 |
|------|------|------|
| 1. template 解析 | `createDevice` :710-733 | name/override 驗證、`redroidTemplate.findUnique`、disabled 409 |
| 2. proxy 解析 | :735-749 | device `proxyUrl` > template `proxyUrlEncrypted`（AES-256-GCM，`encryptSecret`/`decryptSecret`）；明文只在 function scope |
| 3. preflight | :764-772 | `preflight({gpuMode, port:null})` → warning only，永不 sole verdict |
| 4. dataDir | :774-788 | `<REDROID_DATA_ROOT>/redroid/<name>` mkdir 0750（root 常數 `/var/lib/water-army/redroid`，config.js:151） |
| 5. 端口分配 | `allocateAdbPort` :523（DB unique + 範圍 config.js:89-90 預設 **15000-15999**）、`allocateGostPort` :547（20080-20179，`GOST_PORT_RANGE` :86）；P2002 撞車重試 ≤25（:826-831） |
| 6. DB row | :814-833 | `containerState='provisioning'`、`adbState='unknown'`、`gpuStatus='unverified'`（host）/`software`、`proxyState='provisioning'`/`off` |
| 7. docker create | :838-876 | `Image: template.image`（template 時 pin）；HostConfig = bridge + `5555/tcp → 127.0.0.1:<adbPort>`（`REDROID_LOOPBACK_BIND` :29 常數，client 改唔到）+ `/data` bind + `Privileged` 只來自 template + host GPU 時 `DeviceRequests nvidia` |
| 8. start（best-effort） | :878-905 | start 失敗 = `startError` 回傳但 create 契約已成立 |
| 9. gost provision（**同步**） | `provisionGost` :575-600 | deterministic name `redroid-matrix-b-gost-<dev>`；image = `gogost/gost@sha256:f7a958…b7580`（digest pin，:72）；bind `172.17.0.1:<gostPort>`（bridge gateway，:78）；失敗 → rollback 連 device |
| 10. tunnel provision（**背景**） | `provisionTunnel` :625-658 | adb connect → poll `sys.boot_completed`（5s poll / 10min timeout，config `redroidTunnelBootTimeoutMs`）→ `execInContainer(buildTunnelSetupScript({gostPort}))` :355/650 |
| 11. tunnel setup script | `buildTunnelSetupScript` :173-193 | pkill（**自殺 bug F-B**）→ `ip link del/add tun0`（best-effort，netd RTM_NEWLINK 可 block）→ `nohup /data/local/tmp/tun2socks --device tun0 --proxy socks5://172.17.0.1:<gostPort>`（:185）→ `ip addr add 10.8.0.1 peer 10.8.0.2/32` → link up → table 100 flush + `default via 10.8.0.2 onlink` + **gateway exception** `172.17.0.1 dev eth0 scope link`（hairpin 防線，:190）→ rule 5000 EEXIST-safe → `ps -ef \| grep [t]un2socks` 存活檢查 → `ip route get 8.8.8.8` |
| 12. 成功判定 | :650-653 | `exitCode===0 && /tun2socks/.test(stdout)` → `proxyState='running'` — **只係 process-existence 證據，無 data-plane 驗證**（Phase 3 目標） |
| 13. health/狀態 | `refreshDevice` :1134-1179 | containerState（inspect）+ adbState（whitelist `get-state`）**而已**；`proxyState` 喺 refresh 路徑**完全唔郁** → tunnel 死咗 API 都照報 `running`（fail-open，§7.4 實測） |
| 14. 4 區診斷 | `diagnoseDevice` :1195-1290 | kernel（preflight）/ containerLogs（bounded tail）/ adbConnectivity / gpuVerification（host mode 恆 `unverified` — MD §2.4 誠實核心）。**無 tunnel/binary/data-plane 區** |
| 15. 清理 | `deleteDevice` :1073-1132 | `teardownTunnel` :660-672（pkill + `ip link del`）→ `teardownGost` :602-613 → container remove（confirm name）→ `removeRedroidDataDir`（opt-in） |
| 16. 狀態投射 | `deviceView` :1429+ | `proxy.state = row.proxyState`（off/provisioning/running/stopped/error，:88 `PROXY_STATES`）— 無 timestamp、無 fail 計數、無 `binaryState` |

worker 參與：無（device ops 全同步 API-side，文件頭註釋）。`PROXY_STATES` 無 transition 驗證（任意 assign 得）。

## 7. 測試分類表（40 test files + 3 e2e）

| 類別 | 檔案 | 性質 |
|------|------|------|
| unit（24） | `tests/unit/*.test.js`（rbac、redaction、scrub、task-run-state-machine、scheduler-*、provider-*、url-guard、tool-registry、login-flow、adb-whitelist、docker-error-classification、docker-service-core、preflight、redroid-seed、worker-*） | **純 mock**：in-memory fake db（`tests/helpers/fakes.js`）、fake redis、純 function |
| integration — redroid（3） | `redroid-lifecycle`、`redroid-diagnostics`、`redroid-proxy` | **mock**：`makeRedroidTestApp`（`tests/helpers/redroid-fakes.js`）= `REDROID_ADAPTER=mock`（`apps/api/src/services/redroid-mock.js`）+ fake docker（disabled wrapper）+ fake adb + in-memory db。**無一個 test 觸真 Docker / 真 Redroid / 真 binary** |
| integration — platform（12） | `docker-api`、`docker-sse`、`docker-templates-create`、`health-ready`、`dashboard-summary`、`schedules-api`、`task-concurrency-gate`、`task-engine`、`tasks-api`、`schedule-notifications-api` | **mock / API-only**：fake db/redis/docker（`fakeDockerOk/Down/Disabled`） |
| integration — 有真依賴（1） | `schedules-real-redis` | **env-gated**：`SCHEDULES_REDIS_URL`/`REDIS_URL` 無 = skip；有 = 真 redis + 真 BullMQ（唔係 Redroid） |
| e2e（3） | `e2e/p6-e2e.mjs`、`secret-redaction-e2e.mjs`、`seed-e2e.mjs` | playwright，需 live compose stack — **唔喺 `npm test`** |

## 8. 基線實跑（原样記錄）

| # | 命令 | exit code | 結果 |
|---|------|-----------|------|
| 1 | `npm test`（= `node --test tests/unit/*.test.js tests/integration/*.test.js`） | **0** | **tests 492 / pass 491 / fail 0 / cancelled 0 / skipped 1 / duration 10.5s**（skip = `schedules-real-redis` gated） |
| 2 | `SCHEDULES_REDIS_URL=redis://127.0.0.1:16379 node tests/integration/schedules-real-redis.test.js`（disposable redis `redroid-matrix-r0-redis`，跑完即刪） | **0** | **1/1 pass**（真 redis + 真 BullMQ `upsertJobScheduler` 等） |
| 3 | `npm run build`（web workspace，vite 8.3.4） | **0** | 1941 modules，dist 311KB js + 11.9KB css，93ms |
| 4 | `sg docker -c "docker compose config --quiet"` | **0** | config 有效 |
| 5 | lint | N/A | repo 無 lint config（唔算通過，計「未設」） |
| 6 | typecheck | N/A | 無 TS |
| 7 | CI | N/A | 無 CI（Phase 7 範圍） |
| 8 | e2e（playwright） | **未執行（BLOCKED-by-scope）** | 需 live stack 登入 + UI；R0 只讀原則下唔做 — 記錄為 NOT VERIFIED |

**版本 mismatch 備註**：#1 行咗 Node **22.22.2**，repo 要求 ≥24。零 fail，但 Node 24 上嘅行為（尤其 argon2/prisma native binding）未驗證 → R1 之前建議 host 補 Node 24 重跑一次全套（列未解決事項）。

## 9. 真 Redroid 能力基線（smoke boot — 實測）

**設定**：`redroid-matrix-r0-smoke` = `docker run -d --privileged --gpus all -v /var/lib/water-army/redroid/redroid-matrix-r0-smoke:/data -p 127.0.0.1:16001:5555 water-army/redroid:14.0.0-240527-matrixa`（= Stage A 實測過嘅配置 + 16000 段 ADB port）。

| 時間點（UTC，host 17:xx = HKT 01:xx） | 事件 |
|------|------|
| 17:06:40 | container `StartedAt` |
| 17:06:42.152 | `boot_progress_start`（logcat events） |
| 17:06:46.944 | `boot_progress_ams_ready` |
| 17:06:47.4–48.1 | `ACTION_BOOT_COMPLETED` broadcast（`sys.boot_completed=1`） |
| 17:13:22 | host adb 首次 `device` + 驗證（**delay 係 R0 polling script 未 `adb connect` 嘅測法問題，唔係 boot 慢** — 見下） |

- **framework boot ≈ 7–8 秒**（container start → BOOT_COMPLETED；fresh `/data`）。
- 驗證：`ro.build.version.sdk = 34`、`ro.product.model = redroid14_x86_64`、`sys.boot_completed = 1`（host adb platform-tools）。
- GPU：`--gpus all` 暴露但**渲染未驗證**（MD §2.4 誠實核心；Stage A 已知 boot 頭 13s 有 gralloc GBM SIGFPE 一次性 crash 自愈 — 本單 boot 快過 13s 觀察窗，logcat 未深查，列未驗證）。
- **缺失分析**：呢個 host 真 Redroid **可 boot**（binderfs + wrapper 就夠；ashmem 唔需要，kernel 6.x memfd 取代）。缺失唔喺 host 核心/裝置節點 — 缺失喺 §5（binary 部署契約 + template image 選擇 + F-B pkill bug）。
- Teardown：container `rm -f` 已做；**11MB `/data` skeleton 殘留**（`redroid-matrix-r0-smoke`）— 照指示記錄唔清（同 Stage A `redroid-ceo-verify-a` 1.4MB 殘留同類：raw `docker run` 唔經 API `deleteDevice(removeData)` 就會留）。

## 10. 網絡基線快測（tunnel 現行行為實測 — 只記錄，唔修）

**topology**（簡化 Stage B spike，去 gost 層）：
host mock sink（`tests/mocks/mock-sink.js` @127.0.0.1:20261）← relay ← host mock socks5（`tests/mocks/mock-socks5.js` @0.0.0.0:20260，relay→20261，log `/tmp/r0-net/mock.jsonl`）← device `tun2socks v2.7.0`（adb push 上 `/data/local/tmp/tun2socks` — sha 核對 §5.2）起 `tun0`（10.8.0.1/peer 10.8.0.2）→ table 100 default + gateway exception + rule 5000（runbook §10 netd-safe ordering；執行用 file-based `sh /data/local/tmp/r0-setup.sh` 繞過 F-B）。

| # | 測試 | 結果 | 證據 |
|---|------|------|------|
| 1 | **DNS canary**（`canary.example` A query，raw UDP 經 8.8.8.8:53） | ✅ **PASS** | 回應 = 精確 mock canary A `5d b8 d8 22`（93.184.216.34，真實世界呢個域名係 NXDOMAIN — 唯一來源係 mock）；mock log：`udp-associate(mode=tcp-granted)` → `udp-flow dest=8.8.8.8:53 bytes=32` → `dns canary=true` |
| 2 | **TCP connect**（`nc 93.184.216.34:20261`） | ✅ **PASS（控制面）** | mock log `tcp-connect dest=93.184.216.34:20261 from=172.17.0.4:58150`；SYN/ACK 全過 tunnel；mock 仲 relay 咗 51B 返 device（sink 嘅 400 回應 = 反向控制面都通）；close 記錄 `bytesIn=0`（device 無發任何 payload — 符合測試設計） |
| 3 | **TCP payload 雙向**（93B HTTP GET + `X-Nonce: r0pay-7f3a9c`，`nc` 送 + 讀 10s） | ❌ **FAIL** | device→mock **tcp-connect OK**（:56508）但 **0 字節 request 落去**（sink.jsonl 根本無產生 = sink 收到 0 個 HTTP request）；device 讀返 **0 字節回應**。即：**SYN 過、payload 唔過** — **與 Stage B 結論一致**（gVisor 內置 TCP-over-TUN payload forwarding 缺陷；Stage B 另有 TUN counter 證據：device 寫落 TUN +164B、TUN 無 drop、gVisor 冇 forward） |
| 4 | **shutdown / fail-open**（`pkill -f '[t]un2socks'`） | ⚠️ **FAIL-OPEN 確認**（MD 預期嘅危險行為，現行無保護） | kill 前：`ip route get 8.8.8.8` = `via 10.8.0.2 dev tun0 table 100`；kill 後：`Device "tun0" does not exist` + route 即變 **`via 172.17.0.1 dev eth0`（直連恢復，靜默）**；rule 5000 殘留但 table 100 已空（harmless stale）；post-kill 直連 probe（真 DNS 8.8.8.8:53）本環境**無回應**（host 直連 egress 現行受限 — 環境備註；Stage B 當時呢個 host 係有真直連嘅，收到真 root NXDOMAIN） |

**與 Stage B 一致性**：DNS ✅ / TCP connect ✅ / TCP payload ❌ / fail-open ⚠️ — **四項全部同 Stage B 一致**（Stage B 用真 gost 兩 device 實錚；本單用 mock socks5 一 device 重現）。
**代理狀態一致性**：全过程 `proxyState` 無人監控（R0 無 DB 裝置 row — 手動 docker run）；API 路徑下 `refreshDevice` 唔查 tunnel（§6 step 13）→ UI 照 `running`。

## 11. P0 疑點「已知/未知」清單（俾 R1–R4）

### R1 = Phase 1（binary build/deploy 契約）
- **已知**：
  - binary 來源/版本/架构/sha256 明確（§5.2：v2.7.0 linux-amd64 static ELF, `98d545a6…c031`，static = 無動態庫依賴，x86-64 host ELF 喺 redroid（Android x86_64 userspace on host kernel）可執行 — 實測 `--version` OK）。
  - 缺失點全部定位：repo 無檔案/無 script/無 Dockerfile 步驟；host image 無 binary；matrixb 已消失；唯一實體喺 `/tmp`（volatile）。
  - 執行路徑、錯誤浮出點（`REDROID_TUNNEL_PROVISION_FAILED`）、F-B pkill 自殺 bug（含實測 rc=143 證據 + bracket 修法驗證）。
  - 重現基線：wrapper image 由 repo 可 1:1 重建（同 image ID）。
- **未知**：
  - 官方 release 資產嘅授權條款（xjasonlyu/tun2socks license — R1 需確認商業/內部使用條款同再分发要求）。
  - 點先係最優注入點：build-stage COPY（要先把 binary 入 repo 或 build-arg 下載）vs container-init 時 host bind-mount 注入 vs `adb push` 化契約 — 取決於 deployment 模型（Docker-only host 有冇 host 側可信 binary 位置）。
  - fresh 裝置「binary 缺失」時嘅 UX/錯誤碼設計（MD §3.3 建議 `binaryState: missing|ready|invalid|error` — 現行 schema 無此欄）。
  - seed template image 同 wrapper image 嘅治理（咩係唯一 source of truth；`redroid/redroid:15.0.0` 上游 tag 喺呢個 host 根本 boot 唔到）。

### R2 = Phase 2（TCP payload 根因）
- **已知**：故障層 = **tun2socks v2.7.0 內置 gVisor 嘅 TCP-over-TUN payload forwarding**（Stage B TUN counter 實證：device 寫入 + TUN 無 drop + gVisor 唔 forward；fresh process ×3 + TUN recreate 無改善）；v2.7.0 = 當時最新 release（2026-07-12），無更新 pin 可試；升級選項 A/B/C 已記錄（Stage B progress:31：A=換 gVisor version 重 build tun2socks、B=透明 proxy/iptables REDIRECT 唔行 gVisor、C=接受現況文檔化）。
- **未知**：
  - 有冇更新嘅 tun2socks/gVisor release 解決咗（R2 時要重新查上游 — 距 Stage B 已約 1 個月）。
  - 選項 A/B 嘅 compatibility/arch/license 評估（MD §4.5 要求先列清楚先換）。
  - 本 host 直連 egress 現行狀態（§10 #4 無回應 — 可能沙箱/ISP 限制）：影響 R2 嘅「baseline direct test」設計（要用 mock 端點做真基線）。

### R3 = Phase 3（health state + fail-closed）
- **已知**：
  - 現行零 watchdog、零 data-plane 檢查；`proxyState` 只由 provision/teardown 寫（§6:12/13/15）；`refreshDevice` 唔觸 proxyState；`PROXY_STATES` 無 transition 驗證。
  - fail-open 實測確認（§10 #4）+ 機制（tun0 死 → table 100 路由消失 → eth0 直連；rule 5000 stale 殘留）。
  - runbook §10.3 已自述「監控 proxyState + fail-closed monitor（iptables 兜底，另開單）」— 本單即係嗰單嘅基線。
- **未知**：
  - fail-closed 嘅「阻斷」實作層（device netns 內 iptables DROP vs 路由 shadow vs 停裝置）— 要喺唔破壞 Android netd 自己管理嘅 table/rule 下設計（netd 會自訂 table 100/rule 5000 — 覆寫有互踩風險）。
  - watchdog 放邊（api 同步 loop vs worker）— 現行 worker 無 device 權責（device ops 全 API-side），MD §5.4 又要求「獨立監控邏輯」— 架構決策待 R3。
  - 同 MD §5.2 狀態模型（STOPPED/STARTING/VERIFYING/HEALTHY/DEGRADED/BLOCKED/FAILED）對齊现有 `PROXY_STATES` 嘅 migration 法。

### R4 = Phase 4（proxyState/API/UI 一致性）
- **已知**：狀態來源全盤點：`db.device.{proxyState,containerState,adbState,gpuStatus}`（唯一 authority = DB row）；寫入點 = createDevice/provisionGost/provisionTunnel/teardownTunnel/refreshDevice/deleteDevice；讀取 = `deviceView`（:1429，UI 經此）+ diagnostics。無 timestamp/無 fail 計數/無 `lastErrorCode`（MD §6.2 health payload schema 全缺）。
- **未知**：`containerState` 嘅 stale 問題（refresh 係手動觸發；容器自己死咗 DB 唔變 — 無 poller）同 R3 watchdog 嘅關係（會唔會合併做一個 reconciler）。

## 12. 未解決事項 / 回滾

**未解決**（照 MD §1 回報格式：冇 code 改動 → 無回滾需求；以下係列俾 R1+ 嘅 open items）：
1. tun2socks 部署契約（§5）— R1。
2. F-B pkill 自殺（§5.4）— R1 順手修（一詞 bracket）但**必須**獨立驗證。
3. TCP payload 根因修復 — R2。
4. fail-closed 狀態機 + watchdog — R3。
5. 狀態 schema 一致性 + 前端 — R4。
6. Node 24 基線重跑（host 版本 mismatch，§8 備註）。
7. seed template image 治理（§5.3）。
8. 殘留：`/var/lib/water-army/redroid/redroid-matrix-r0-smoke`（11MB）+ `redroid-ceo-verify-a`（1.4MB，Stage A）— 記錄備查。
9. R0 測試痕跡：`/tmp/r0-*`（scripts/logs，volatile）、`/tmp/r0-net/*.jsonl`（mock 證據）— 可清可留；host image 無新增（rebuild 已 untag）。
10. 本單 port 使用記錄：20260/20261/16379/16001（全釋放）。

**回滾**：本單零 code/config 改動 — 唯一 repo 改動 = 本檔（docs-only）+ commit。回滾 = `git revert <commit>`（或 `git reset --hard e31201f` 經 CEO 批准）。

---
*R0 完成於 2026-10-20 01:3x HKT。所有實測證據原件：`/tmp/r0-smoke-poll.log`、`/tmp/r0-net/mock.jsonl`、`/tmp/r0-net/sink.jsonl`（可選留）、progress 檔 `/home/kenneth/.openclaw/workspace/logs/waterarmy-repair-R0-progress.md`。*
