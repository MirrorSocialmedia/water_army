# Audit — Manual Mobile Console + Human Intervention（MD §1.1）

日期：2026-10-23（HKT）· Baseline：`4f5284e`（= origin/main，RAM Gate G2 收貨）
工單：五畫面手機監看 + 人工介入通知 + 手動操作台（17 節施工 MD）
方法：repo 盤點 + 只讀實測（`docker exec`/`docker network ls`/port 掃描）；未改任何運行中 stack。

## 1. Redroid devices — route / page / components / hooks

| 層 | 現狀 | 位置 |
|----|------|------|
| Routes | `GET/POST /api/devices/redroid`、`POST /:id/:action`（start/stop/restart/refresh/diagnose/remove…）、`GET /:id/diagnostics`、`POST /:id/diagnostics`（logcat/clear-data）、`POST /:id/network/retry`；RBAC operator+（list/diagnose viewer 可讀） | `apps/api/src/routes/devices.js`（179 行） |
| Service | `createRedroidService`：dockerode 容器生命週期、device-network（自管 bridge `water-army-devices` 172.38.200.0/24）、gost 容器、ADB engine、net watchdog（`setInterval` in-process，pollMs 可配）、RAM gate 接入（admission+lease 原子 Lua） | `apps/api/src/services/redroid-service.js`（2664 行） |
| Web 頁 | `Devices.jsx`（card list + create form + actions）、`DeviceDetail.jsx`（393 行：diagnostics/net state/logcat） | `apps/web/src/pages/` |
| Components | `redroid-utils.js`（state badge、`deviceActionsForState`、`adbPortLabel` — ADB 永遠渲染 `127.0.0.1:<port>`）、`StateFrame`、`BatchContainersPanel` | `apps/web/src/components/` |
| Hooks | 通用 `useApi`（poll/intervalMs/reload）、`useTaskEvents`（DB-polling SSE 風格 cursor）；**無 device 專屬 hook**；無 WebSocket 使用 | `apps/web/src/hooks/` |

## 2. Notification — schema / service / API / UI

- Model：`ScheduleNotification`（`id` cuid、`runId`、`userId`、`status`、`title`、`message`、`isRead`、`createdAt`/`updatedAt`）— 只服務排程 run 完成/失敗。
- Writer：worker `schedule-notifier.js`（BullMQ job）寫 DB；API 無 write 端點（只 read + `POST /read-all`，operator+）。
- API：`GET /api/schedule-notifications?limit=`、`GET /api/schedule-notifications/unread-count`、`POST /api/schedule-notifications/read-all`。
- UI：`NotificationBell.jsx` — topbar bell，30s poll unread-count（silent）、open 時抓 10 條、deep-link `#/tasks/:runId`、Esc/outside-click 收合、防連點。
- **無 SSE 推送**（task events 係 DB-polling cursor；MD §8.2 允許「沿用現有通知模式」→ ManualIntervention 用同模式：polling + `updatedAt` cursor + 退避）。

## 3. Prisma / migration 慣例

- `prisma/schema.prisma` 單檔；`@@map("snake_case 表名")`、`@map("snake_case 欄名")`；id 慣例：核心表 `uuid()`（devices/runs…）、notification 用 `cuid()`。
- Migrations = versioned folders（`20261015_xxxx_…` 日期+描述），只追加、禁改已上線（README + ADR 鐵律）。
- Runtime：Prisma 7.10.0 + `@prisma/adapter-pg` 7.10.0（`prisma.config.js`）。
- 本工單新增（MD §9）：`DeviceStreamLease`、`ManualIntervention`、`ManualInterventionHistory` — 跟 uuid()/snake_case/@@map 慣例，additive。

## 4. 登入 / RBAC / audit

- Session：HttpOnly cookie（`SESSION_SECRET`，`security/cookie.js`）；`/api/auth/me` 回 `{user:{id,username,role}}`。
- RBAC：`requireRole(minRole)`（`security/rbac.js`）→ async preHandler；`ROLE_LEVEL` viewer<operator<admin（`packages/shared`）；401/403 用標準 envelope。
- Audit：`createAuditService({db, log})`（`services/audit.js`）— 結構化 log + DB audit row；所有 mutative API 已有 audit 慣例。
- 其他 helpers：`security/origin.js`（same-origin 校驗，Fastify 5 必須 async hook）、`rate-limit.js`（Redis-backed）、`service-auth.js`（worker↔api token）、`url-guard.js`。
- Error envelope（全站）：`{ error: { code, message, requestId } }`；HTTP 401/403/404/409/422/500 各有慣例 code（見 `docs/api-reference.md`）。

## 5. ADB engine / scrcpy 現狀

- ADB engine：`services/adb-whitelist.js` — **固定 binary path**（`REDROID_ADB_BINARY`，prod 設 `/usr/bin/adb`）、**固定 5 個 op**（getprop/dumpsys/logcat/connect/get-state）、固定參數陣列、禁 `shell:true`、target 只准 `127.0.0.1:<port>`、per-call timeout + 輸出上限。
- **scrcpy / 畫面擷取：完全不存在**（全 repo 無 scrcpy 字樣）→ 本工單從零加。
- **⚠️ 實測發現 1**：api 生產 image **冇 adb binary**（`docker exec water-army-api-1 command -v adb` → NO_ADB；`docker/api.Dockerfile` 無 adb 安裝步驟）→ 生產 compose 環境 ADB 診斷/refresh 實際會落 `ADB_UNAVAILABLE`。G1/G2 全部真機證據用 **host process** API + `$HOME/.local/share/platform-tools/adb`（**v37.0.1-15733141**，`adb version` 實測）。
- **⚠️ 實測發現 2（ADB 可達性）**：device 容器 ADB 只 publish `127.0.0.1:<adbPort>`（host loopback bind）。host process 直達；**bridge 容器理論上不可達 host loopback**。→ 流串流 sidecar 嘅 ADB 路徑設計（ADR-019）：
  - **production**：sidecar = API 用 dockerode spawn 嘅自管容器（跟 device/gost 同機制），掛 API 自管 devices network（172.38.200.0/24），**直連 device 容器 IP:5555**（redroid adbd 係 tcpip 模式，同 L2 可達 — PoC probe 實測）。
  - **scratch（G2 式 host-process API）**：sidecar 亦 host process，直連 `127.0.0.1:16500`。
  - 兩模式統一：API 在 spawn 時決定 `adbTarget`（loopback:port 或 subnet-ip:5555）傳 sidecar；sidecar 只接受「loopback + 核准 port 範圍」或「devices subnet + port 5555」，**客戶端永遠唔可以指定 host/port**（MD §5.2 / §11.6 反 SSRF）。
- **實測發現 3**：web 反代（`apps/web/server.js`，zero-dep）只係 HTTP proxy，**無 WebSocket `upgrade` handler**（`upgrade` 喺 HOP_BY_HOP 被 strip）→ 流串流 WS 必須加一段 upgrade 透傳（`/api/` 前綴 + XFF overwrite，跟 `proxyApi` 同款邏輯）。

## 6. Compose 網絡 / 反代 / host port

- 網絡：compose 聲明 `platform`（172.38.100.0/24）+ device network（172.38.200.0/24，API 自管）；**用戶運行中 stack 實測喺 `water-army_default`**（舊 compose 隱式橋 — 運行 9h+，唔郁）。
- 反代：web（node zero-dep）static + `/api` proxy；唯一 host 發布 port = `127.0.0.1:3012 → web:3012`。
- Host ports：3012（web）；device ADB `127.0.0.1:15000-15999`（prod 範圍）/ scratch 16xxx；gost bind 172.38.200.1:20080-20179；postgres/redis 只容器內。
- Docker socket：**只 api** mount（ro）；web/worker/postgres/redis 無。
- 本工單 port 計畫（全喺核准帶）：scratch API 16490、pg 16494、redis 16495、worker-health 16496（同 G2 帶，實測空閒）、**device ADB 16500-16549**、sidecar 內部 port 16550（scratch host process；production 容器內無 publish）。

## 7. 鎖定版本（實測自 lock/manifest）

| 組件 | 版本 | 來源 |
|------|------|------|
| node（container） | node:24 | Dockerfile FROM |
| node（host，local dev） | v22.22.2 | 實測（`engines>=24` 係 advisory） |
| Fastify | 5.12.7 | apps/api |
| Prisma / adapter-pg | 7.10.0 / 7.10.0 | apps/api |
| dockerode | 5.0.1 | apps/api |
| ioredis | 6.0.0 | apps/api |
| pino | 10.4.0 | apps/api |
| @node-rs/argon2 | 2.2.2 | apps/api |
| BullMQ | 6.3.15 | apps/worker |
| React / react-dom | 19.3.0 | apps/web |
| Vite / plugin-react | 8.3.4 / 6.1.2 | apps/web dev |
| Playwright（dev） | 1.64.x | root dev |
| postgres / redis image | 17.6 / 7.4.5 | compose |
| redroid image | `water-army/redroid:14.0.0-240527-matrixa-r3`（digest 591296d5，A10 10/10 實證） | template default |
| gost image | digest-pinned | ADR-014/016 |
| tun2socks | v2.7.0（sha256-pinned） | Stage B |
| platform-tools（host adb） | 37.0.1-15733141 | 實測 |
| **WebSocket 庫** | **無** → 新增 `ws`（pin 精確版本，ADR-019 理據） | — |

## 8. mock vs 真機證據分界（誠實分類）

- **真機證據（host-process stack，G1/G2 食譜）**：Stage A boot 矩陣（10/10）、Stage B DNS/canary、R3/R4 live 修復、**RAM Gate G1**（10 台真機 ladder，16,819 MiB settle）、**G2**（gate live 下 10 台，stage-5 ≈ 25,227 MiB MemAvailable）。
- **mock/整合（local manual E2E）**：P5 全部（含 p5-evidence JSON — 已核實係 mock diag）、batch rotation BR E2E。
- **CI**：unit + build + compose config；**無**真機/瀏覽器 E2E（本工單 §15 要求補 Playwright E2E + 真機 checklist，CI 只跑 mock-safe 部分並明確標記）。

## 9. 對本工單嘅直接影響（design implications）

1. 新 ADR-019（串流方案）+ `apps/stream/` 新 app（sidecar，零 DB / 零 docker socket / pinned adb + scrcpy-server）。
2. `apps/web/server.js` 加 WS upgrade 透傳（`/api/` only，XFF overwrite，origin 校驗）。
3. ManualIntervention 事件 hook 點：net watchdog tick（`healthTickDevice` state transition）、`refresh` adb offline、tunnel/boot 超時、container 狀態變更 — 全部喺 `redroid-service.js`（in-process，同 API）。
4. 生產 ADB_UNAVAILABLE gap（發現 1）：sidecar 自帶 pinned adb 唔依賴 api 嘅 adb；api image 補 adb 列為 **product decision 項**（超本工單 scope，報告列出）。
