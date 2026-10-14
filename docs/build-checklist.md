# Build Checklist — water_army（7 階段 P0–P6）

- 依據：施工 MD §17 分階段施工及每階段交付（摘要 + 補狀態欄）
- 紀律（全程適用，MD §0 + 工單硬規則）：
  - 全程 **JavaScript ESM**，前後端唔用 TypeScript/Python；JSDoc 表契約
  - P0 只文檔零代碼；**唔擴需求**（MVP 之外列後續）
  - 每階段完成 = 跑過該階段測試並全綠，「寫完」≠「完成」（MD §0-4）
  - 唔硬編碼 secret（`.env.example` 只 placeholder；`.env` 入 `.gitignore`）
  - 破壞性操作 = 確認 + 顯示對象 + 審計（MD §0-7）
  - Docker socket 只掛 `api`；ADB 只 127.0.0.1；DB/Redis 唔 publish 對外
  - 3-strike 規則：同一操作 fail ×3 → 停手、progress 檔記錄、回報 CEO
  - 每 subtask 完成即更新 Kairo Monitor（`mv7qf0zqprokw`）；progress 檔逐步 append（repo 外，唔 commit）

**狀態圖例**：⬜ 未開始 / 🔄 進行中 / ✅ 完成（附完成日）/ ⛔ 阻塞（附原因）

---

## P0 — Repository audit + design decisions　`mv7qf0zqhm0r0`　🔄 進行中（本 commit 後轉 ✅）

**目標**（MD §17）：檢查既有程式、記錄現況與風險；建立三份文檔；確認 Node/npm、Docker、Redroid 與 BullMQ 版本相容性。

**交付物**：
- [x] `docs/repo-audit.md` — 空 repo 實錄（git 實跑輸出）+ host 環境實測 + Redroid 可行性實測 + 風險記錄
- [x] `docs/architecture-decisions.md` — repo 現況聲明、技術選型 + 理由、**MD §2 十條反制逐條**、環境現況、版本核實實跑輸出（§5）、待驗證項（§6）、已決/未決（§7）
- [x] `docs/threat-model.md` — Docker socket / AI prompt injection / Provider secret / ADB / 權限越界 / 排程重複執行，每項風險描述 + 緩解 + 殘留
- [x] 本檔 `docs/build-checklist.md`（P0–P6 + 狀態欄）
- [x] 版本核實實跑：Node 24 LTS 狀態（nodejs.org dist index）、BullMQ 6.3.15 三 scheduler API 解包實證、其餘依賴 `npm view`、Prisma RC 陷阱、Redroid Docker Hub tags、redroid-doc 文件核對（輸出全部貼喺 ADR §5）

**驗收條件**（MD §17 P0）：文件包含實際 repository 現況、選型理由及尚待驗證項目；唔係模板文章。
- [ ] commit 入 main 並 push origin（single commit，message 按工單指定）
- [ ] worktree clean（工單/progress 檔除外，兩檔本唔喺 repo）
- [ ] Kairo subtask `mv7qf0zqhm0r0` 標 done

**完成標準**：4 份文件存在、§2 十條齊、版本核實有實跑輸出、`origin/main = HEAD`。

---

## P1 — Skeleton + deployment　`mv7qf0zqza5xh`　⬜ 未開始

**目標**（MD §17）：Web/API/Worker/PG/Redis scaffold、Compose、環境設定、migration、健康檢查、structured logger；Admin bootstrap CLI、登入/登出/me、RBAC middleware。

**交付物**：
- [ ] MD §5 結構 scaffold（apps/api、apps/worker、apps/web、packages/shared、prisma、tests、docker/、docs/）
- [ ] `package.json`（`"type": "module"`、`engines.node >=24`）+ **`package-lock.json` 提交**（按 ADR §5 版本鎖定：fastify 5.12.7 / dockerode 5.0.1 / prisma 7.10.0 / bullmq 6.3.15 / vite 8.3.4 / react 19.3.0 / pino 10.4.0 / @playwright/test 1.64.0 / ioredis 6.0.0 / lucide-react 1.57.0 / @node-rs/argon2 2.2.2）
- [ ] `compose.yaml`：web / api（**唯一掛 docker socket**）/ worker（無 socket）/ postgres（volume + healthcheck）/ redis（healthcheck、無 publish）；多階段 Dockerfile；非 root / ro-rootfs（如可行）/ drop caps / no-new-privileges
- [ ] `.env.example`（MD §14 全欄 placeholder）+ `.gitignore`（.env、logs、build output、coverage、playwright output）
- [ ] Prisma schema + **versioned migrations 提交**（MD §7 十表：users / sessions / provider_configs / task_definitions / task_runs / task_run_events / schedules / approval_requests / audit_events / app_settings）
- [ ] `GET /api/health/live` + `/api/health/ready`（DB/Redis/Docker 各自狀態）
- [ ] `npm run setup:admin` CLI 建首 admin（Argon2id）；`POST /api/auth/login|logout`、`GET /api/auth/me`；session（HttpOnly/SameSite/Secure、revoke）
- [ ] RBAC middleware（admin/operator/viewer）+ Origin/CSRF + rate limit + 安全 headers
- [ ] pino structured logging + request ID + redaction（authorization/key/password/cookie/session/proxy）
- [ ] README：clone → 啟動、首 admin、啟動/停止（分「停止」vs「刪 volumes」）、備份還原、socket 權限說明（禁 chmod 666）

**驗收條件**（MD §17 P1）：乾淨環境可按 README 由 clone 到啟動；health/ready 回報各依賴狀態；預設無公開註冊。
- [ ] 額外紀律：P1 落 lock 前重查 Prisma 8 stable（V6）；commit 時 `tsc` 無關（無 TS）但 `node --check` 過主要入口

---

## P2 — Docker dashboard　`mv7qf0zqt6mbs`　⬜ 未開始

**目標**（MD §17）：Dockerode service、容器列表、詳情、logs、stats、start/stop/restart/pause/unpause；managed label 規則、操作確認、審計、API error handling。

**交付物**：
- [ ] `DockerService`（MD §9）：list/inspect/logs/stats/events（SSE）+ 錯誤分類（**只 404 = not found**；daemon_unavailable / permission_denied / timeout 各自分類 — §2-7 反制）
- [ ] Template allowlist 模型 + API（`GET /api/templates`）：一般 template `Privileged=false`、禁 host mount 白名單外目錄；容器 label `app.managed=true` / `app.template` / `app.created-by`；create 用冪等 key
- [ ] 容器操作 routes：start/stop/restart/pause/unpause/delete（admin + 二次確認 + 審計）；變更操作先讀現態、成功後 re-inspect 確認（MD §9.3）
- [ ] 非 managed 容器預設只讀；管理員明確授權既有容器（設定 + 審計）
- [ ] Containers UI（§6.2/6.3）：表格/搜尋/篩選/分頁、詳情三 tab（Overview/Logs/Stats）、logs 限 500 行 + SSE + 斷線清理、stats 單容器失敗唔拖垮 dashboard、敏感 env 遮蔽
- [ ] 操作中防連點（loading 狀態禁重複 API 呼叫）
- [ ] Unit tests：錯誤分類四類、template 欄位驗證、port 衝突、label 權限（MD §16.1）
- [ ] Integration tests：fake Docker adapter 或專用測試環境 — 列表/inspect/logs/start/stop/restart；daemon 不可用時錯誤正確（MD §16.2）

**驗收條件**（MD §17 P2）：測試操作真正反映喺 Docker daemon；對唔存在容器、daemon 關閉、無權限分別回報正確錯誤。

---

## P3 — AI provider + task queue　`mv7qf0zqia6mm`　⬜ 未開始

**目標**（MD §17）：Provider adapter interface、OpenAI-compatible Provider、mock Provider、BullMQ Worker、TaskRunService、SSE、取消、重試、逾時及歷史；安全 Tool Registry（先唯讀 + 人工批准）。

**交付物**：
- [ ] Provider adapter 合約（MD §11.1，JSDoc）：timeout / AbortSignal / 429 / 5xx / connect error / 無效 JSON / 超大回應 / 取消；**只對 transient error 重試**
- [ ] `openai_compatible` adapter（base URL / endpoint 由配置，唔硬編碼）+ **mock provider**（CI 零真 token）
- [ ] BullMQ worker（BullMQ 6.3.15；queue payload 只 DB id + 非敏感參數）+ `TaskRunService` 狀態機集中（MD §11.3 九態；finished_at 只 terminal 寫）
- [ ] 提交 = `202 + runId`（唔等模型完成）；SSE events + 斷線重連（Last-Event-ID 或可靠重新載入）
- [ ] 取消（AbortSignal / `cancel_requested` 兩軌）、重試（新 run 或新 attempt，唔覆蓋舊記錄）、逾時（系統上限 900s）、`skipped`
- [ ] 輸出限制 + JSON 模式 parse + schema validate（無效 = failed 具體錯誤）；錯誤摘要遮蔽憑證
- [ ] Tool Registry：唯讀工具（`system.get_health`、`docker.list_managed_containers`、`docker.get_managed_container_status`、`docker.get_managed_container_logs`（限行/字元）、`redroid.get_diagnostics`）；**無** shell.exec / docker.raw_api / 任意 adb（§2-10 反制）；schema + RBAC + 風險級 + 人工批准（`approval_requests` 流，AI 唔自批）
- [ ] Tasks UI（§6.5）：表單（title/prompt/provider/model/mode/timeout/retries/output format/批准）、列表、詳情（輸出/錯誤/事件/tool calls 審計）、取消 + 安全重試
- [ ] Unit tests：provider timeout/429/500/無效 JSON/超大/取消；tool args schema、未批准工具唔可執行、AI 唔自批；狀態機合法/非法轉換（MD §16.1）
- [ ] Integration：提交 → worker → DB 狀態/結果/事件更新；worker crash/restart 處理（MD §16.2）

**驗收條件**（MD §17 P3）：mock Provider 走完整任務生命週期；狀態/輸出/事件全部持久化；**Worker 無 Docker socket**（compose 驗證）。

---

## P4 — Persistent scheduler　`mv7qf0zqrdqhe`　⬜ 未開始

**目標**（MD §17）：Schedule CRUD、timezone/Cron validation、BullMQ Job Scheduler、DB source-of-truth、reconciliation、overlap lock。

**交付物**：
- [ ] Schedules CRUD + pause/resume/run-now/delete（MD §8 API）；cron/interval/timezone 驗證（非法 → 400 說明年/頻率限制）；預設 `Asia/Taipei`，每排程可覆寫 IANA tz
- [ ] **PG = 唯一 source of truth**；`bullmq_scheduler_id` 穩定 + `sync_status`；同步用 **`upsertJobScheduler`**（6.3.15 實證，§2-9/ADR §5.2；**禁舊式 repeat API**）
- [ ] 啟動 reconciliation（冪等：核對 → 更新/建立 → 清理殘留；重跑唔產生重複）；同步失敗 = `sync_error` + UI 可重試
- [ ] 重疊策略 `skip_if_running`（預設）/ `queue`（**無隱含 cancel-replace**）；skip 必記 `skipped` run + 原因
- [ ] 重試/退避：預設 3 attempts 指數退避 + 上限 + 系統最大值；唔重試 400/認證/schema 錯誤
- [ ] `concurrency_key` 互斥鎖（TTL/續租或 DB lock，crash 後唔永久存在）；`idempotency_key` 防 API 雙擊
- [ ] Schedules UI（§6.6）：cron 人讀描述（後端解析）、下次/上次執行、延遲可見（盡力執行口徑）
- [ ] Unit tests：cron/timezone 驗證、reconciliation 冪等、pause/resume/delete 行為（MD §16.1）
- [ ] Integration：create/update/pause/resume/delete 同 BullMQ scheduler 一致；worker restart 後處理（MD §16.2）
- [ ] E2E（§16.3-5）：建幾分鐘排程 → 暫停/恢復/立即執行/查歷史；**測試 cron 唔殘留**

**驗收條件**（MD §17 P4）：重啟 API/Worker/Compose 後排程**不重複、不遺失**；暫停/修改/刪除同步到 queue；延遲與略過 UI 可查。

---

## P5 — Redroid device templates　`mv7qf0zqu3omy`　⬜ 未開始

**目標**（MD §17）：Redroid preflight、Template 建立、localhost-only ADB binding、持久化數據、ADB health check、允許的診斷操作及 GPU verification status。**本機無 binder/ashmem（P0 實測）→ API 用 adapter/mock 驗證，真機驗證明確列未完成，唔假裝。**

**交付物**：
- [ ] `scripts/redroid-preflight.js`（MD §10.1，只讀）：OS/kernel/daemon/binder module+device/dmesg/磁碟/port/GPU 資訊；缺 module → 手動修正建議 + redroid-doc 連結；**唔自動 modprobe**（§2-3 反制）
- [ ] Redroid Template：**dated tag 必填（拒 `latest`/`*-latest`）+ digest 記錄**（§2-2 反制；候選 16.0.0-250627 / 15.0.0-250627）；`bootArgs`（androidboot.*）/`env`/`roOverrides`（實測後先加）分欄（§2-1 反制）；特權只喺 Redroid 專用 template + UI 警告
- [ ] 設備建立/列表/詳情/啟停 API（MD §8）；每設備專屬 data dir；ADB PortBindings **127.0.0.1** + 唯一已批准 port + 伺服器端衝突檢查
- [ ] 診斷：kernel prerequisites / container logs / ADB connectivity / GPU verification 四張獨立結果卡；ADB 操作 = 固定 allowlist function（getprop / 指定 dumpsys / 限量 logcat），`execFile` + 參數陣列 + timeout + 輸出上限；**無任意 shell**（§2-8 反制）
- [ ] GPU 五態機 `not_configured / configured_unverified / verified / degraded / failed`；`verified` 只來自設備內可重現檢查 + 記錄（命令/輸出/時間/映像版本）（§2-4 反制）
- [ ] **mock Redroid adapter**：無真設備環境時 API 全路徑可測（起機模擬、ADB 狀態、診斷結果）
- [ ] 部署驗證：`ss -ltnp` 確認 loopback-only + 外部視角 ADB 連唔到（V5）
- [ ] 真機驗收清單（module 手動載入後執行）：啟動 / ADB / 持久化 / GPU / App 行為（V1–V4）— **P0 時刻本機未完成，P5 交付時如實標註**

**驗收條件**（MD §17 P5）：可建立/啟停已配置測試設備（mock 或真機）；ADB 無法連線或 GPU 無法驗證時顯示明確狀態；ADB 唔可从外部網絡直連。

---

## P6 — UX polish + security + tests　`mv7qf0zqorb36`　⬜ 未開始

**目標**（MD §17）：前端錯誤/loading/error/empty states、重複提交/重連；Unit/Integration/E2E 全綠、依賴掃描、secrets redaction、審計、runbook。

**交付物**：
- [ ] 前端收尾：所有 UI 控件連真 API + 四態（loading/error/empty/success）；防連點；SSE 重連
- [ ] 測試全綠（MD §16 全清單，含 §16.3 七條 E2E 主流程）；**failing test 唔准 skip/標綠**
- [ ] `npm audit` + 依賴掃描（唔忽略 audit error）+ secret 掃描；log redaction 抽測
- [ ] 審計覆蓋抽測：Docker 操作/Template/Provider/排程/批准/登入失敗
- [ ] `docs/runbook.md`：啟動/停止/備份還原/migration 升級前備份/排障/socket 權限/GPU 實測窗口流程/禁止功能清單（引 ADR §2-10）
- [ ] README 最終版（MD §18）：从零安裝、首次 admin、啟停、備份還原、更新、疑難排解、API 文件
- [ ] 最終交付口徑（MD §18 三分法）：**實際可用 / 以 mock 驗證 / 必須特定硬體驗證** 三欄分開列明 + 未完成項 + 已知限制 + 修復建議

**驗收條件**（MD §17 P6）：所有必須測試通過；failing tests 唔可略過或標記成功。

---

## 總體 Definition of Done（MD §19，MVP 完成定義）

P6 收口時逐條核（13 項，MD §19 原文 checklist 直接引用，唔重複貼全文）：新環境可裝可啟 / 登入登出 RBAC CSRF / Dashboard 真 API / Docker 五操作可用 / Template allowlist 門控 / mock AI 全生命週期 / Tool allowlist 無任意 shell / 排程冪等重啟 / 逾時重試取消歷史 / Provider secret 零洩漏 / socket 隔離 / ADB loopback + GPU 如實 / 測試全綠 + 硬體限制如實列明。

**Kairo 對應**：每 phase 完成 → `PUT /api/tasks/mv7qf0zqprokw` 標對應 subtask `done: true`（用 `subtasks_done: ["<id>"]` 字段 — 見 TOOLS.md 2026-08-22 實測，PUT `subtasks` 陣列唔生效）；全部 7 項 done 後 server 自動置 task done。
