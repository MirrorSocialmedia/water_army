# Architecture Decisions — Docker + AI 任務管理平台

- 版本：P0（2026-10-14 14:45 HKT），trace `water-army-20261014`
- 依據：施工 MD §0–§19（762 行全份已讀）
- 結構：§1 repo 現況聲明 → §2 技術選型 → §3 MD §2 十條反制 → §4 環境現況 → §5 版本相容核實（實跑輸出）→ §6 尚待驗證項 → §7 已決/未決

## ADR 索引（Mobile Console 編號 ADR；其餘決策見各 § 標題）

| ADR | 標題 | 狀態 | 位置 |
|-----|------|------|------|
| ADR-019 | scrcpy 授權評估（GPL-3.0 義務分析 → scrcpy MIT 路線） | PASS | §19.1 |
| ADR-020 | 視頻源降級優先（scrcpy 失敗 → screencap 自動降級；H.264 = NOT VERIFIED） | 已實裝（screencap tier 全鏈實錚） | §20 |
| ADR-021 | 人工介入事件系統（狀態機 + dedupe + blocked_pending_review + 零 secrets） | 已實裝、E2E T40–T49 通過 | §21 |
| ADR-022 | P5 security hardening（rate limit 落點 / sidecar inbound guard / scrub 補漏 / E2E matrix） | 已實裝、E2E T50–T61 通過 | §22 |
| ADR-023 | NV follow-up（NV1/NV2/NV4 暫緩；NV3 受控全鏈 8/8；NV5 cookie slot 非 scrcpy 限定 + rate-limit×storm 新發現；NV6 基本級核對） | 已實裝、NV E2E 通過（2026-10-24） | §23 |
| ADR-024 | Mobile Console stream ticket 冪等化 | 已實裝 | §24 |
| ADR-025 | W1 identity 級 device fingerprint profile | 已實裝（代碼段）、真機 V3 待 RAM | §25 |
| ADR-026 | W2 App 層基礎（adb-whitelist 擴容 + ui-tree + app-service + device-apps routes） | 已實裝（代碼 + unit + mock integration 全綠）；**真機矩陣已完成**（2026-10-27 總測試 run7：19 PASS + 2 EXPECTED-FAIL env-limit；實錚中修 2 個真機產品 bug F12/F13） | §26 |
| ADR-027 | W3 身份↔出口 IP 強綁定（identity egress binding + boot 核對 + drift watchdog + credential 零洩漏） | 已實裝（代碼 + unit + mock integration 全綠；canary 零洩漏實錚）、live egress **NOT VERIFIED**（真機矩陣成單） | §27 |

---

## 1. Repository 現況聲明（空 repo 實錄）

`/home/kenneth/.openclaw/workspace/water_army`，origin `https://github.com/MirrorSocialmedia/water_army.git`。

實測（2026-10-14 14:35 HKT）：`git log` → `fatal: your current branch 'main' does not have any commits yet`；`git ls-files` 零檔案；`git ls-remote origin` 零 ref。無 package.json、無 compose、無 migration、無測試。

**判定**：MD §0 規則 1 之「repository 是空的」情形成立 → 由零建立。本 commit（P0 文檔）係 `origin/main` 首個 ref；P1 起按 MD §5 建議結構落 scaffold。完整實測記錄見 `docs/repo-audit.md`。

## 2. 技術選型 + 理由

所有建議版本 = 2026-10-14 實查現行穩定版（實跑輸出見 §5），**全部標註「P1 落 lock 時鎖定」**（MD §3：鎖定版本並產生 lockfile，唔自動用 latest 當正式相依）。

| 組件 | 建議版本 | 理由 |
|---|---|---|
| Runtime | **Node.js 24 LTS（Krypton）**，compose image `node:24` | 官方 dist index 實核：v24.21.0 為現行 active LTS（首個 LTS build v24.11.0 @ 2025-10-28）；Node 26（v26.11.1 @ 2026-10-07）**尚非 LTS** → 按 MD §3 揀 24。Host 現行 v22.22.2（Jod LTS）只供本地 dev；P1 加 `engines.node >=24` + `.nvmrc`。等 Node 26 入 LTS 且依賴相容測試過先再議升級（MD §3 原文策略） |
| Package manager | npm 10.9.7 + `package-lock.json`（提交） | MD §3 指定 |
| Backend | **Fastify 5.12.7** | 內建 JSON Schema validation（ajv）+ hooks + plugin 體系，貼 MD §3「所有 API 使用 JSON Schema 驗證」；6.x 僅 alpha（6.0.0-alpha.5），唔揀 |
| Docker 整合 | **dockerode 5.0.1** | 程序化 Engine API，杜絕 shell 拼接（反制 §2-8）；預設 `/var/run/docker.sock`（MD §3） |
| Frontend | **React 19.3.0 + Vite 8.3.4 + lucide-react 1.57.0**，plain CSS | MD §3；**MVP 唔加 Tailwind**（MD 標「可選」）— 減 supply chain 同 build 配置面，P6 之後再議 |
| DB / 遷移 | **Prisma 7.10.0**（`prisma` + `@prisma/client` 同版） | MD §3 准許 Prisma/Knex 擇一；選 Prisma：versioned migrations + typed client + 一鍵 generate。**避 8.x**：latest dist-tag 係 `8.0.0-rc.22`（RC）+ `8.1.0-dev.x`（dev）— MD §3 禁 latest/未驗證版本（見 §5.4）。P1 落 lock 前再查一次 8.x 有冇出 stable（待驗證 V6） |
| Queue / 排程 | **BullMQ 6.3.15** + ioredis 6.0.0 | 實證 `upsertJobScheduler`/`getJobSchedulers`/`removeJobScheduler` 三方法存在於 6.3.15 dist（§5.2）；MD §3 明令禁舊式 repeat API — 6.x 已移除（官方 docs 見「removed legacy `utc` option」，用 `tz`） |
| 測試 | Node test runner（內建）+ **@playwright/test 1.64.0** | MD §3 准許 Node test runner/Vitest 擇一；揀內建 runner（零額外依賴、ESM 原生）；Playwright 做 UI E2E（MD §16.3） |
| Logging | **pino 10.4.0** | 結構化 JSON + 內建 redaction API（貼 MD §13.3），MD §3 指定 |
| 密碼哈希 | **@node-rs/argon2 2.2.2**（Argon2id） | MD §13.2「Argon2id 等現行安全密碼雜湊」；rust 綁定、零 native build 痛點（P1 落 lock） |
| 模組系統 | 全程 **JavaScript ESM**（前後端） | MD §0 規則 2 硬規則；JSDoc 表達函式契約（例：MD §11.1 provider contract） |
| 時區/Cron | BullMQ 內建 croner（隨 BullMQ） | IANA timezone 支持（MD §12.2）；唔另引 cron 庫 |

**P1 落 lock 時鎖定 = 寫入 `package.json` 精確版本 + 生成並提交 `package-lock.json`；以上表格版本為 P0 核實基準，P1 若發現衝突以「同 major 內最高 stable 且實測相容」為準並回寫本檔。**

## 3. MD §2 十條原稿反制（逐條：原稿錯喺邊 → 本系統點做）

> 對應原 `redroid_tun2socks.md` 之十項問題。每條：反制決定 + 實作落點（phase/組件）。10 條齊，少一條 = 唔符合工單。

**§2-1 Android 參數位置不正確**
- 原稿錯喺邊：把 `ro.product.*`、`androidboot.redroid_gpu_mode` 等塞入 Docker `Env`，當成所有 Android 設定嘅萬用入口。
- 本系統點做：`androidboot.*` 啟動設定（width/height/dpi/fps/gpu_mode 等）按 redroid-doc 官方方式**作為容器啟動參數（container args）**傳入；`ro.xxx` 係另一類 property override，**只喺選定映像實測有效後**先加入 Template，唔宣稱改 `ro.product.*` = 真手機。Redroid Template schema 分欄 `bootArgs`（androidboot.*）vs `env` vs `roOverrides`（後者預設空、需實測標記），唔存在「全部塞 Env」嘅路徑。實作落點：P5（Template schema + 建立路徑 + 單測覆蓋欄位分類）。

**§2-2 映像版本不可任意跟隨 latest**
- 原稿錯喺邊：用 `redroid/redroid:latest` 之類浮動 tag，行為隨上游漂移，故障不可重現。
- 本系統點做：Template 必填**明確 dated tag**（2026-10-14 實查 Docker Hub 可用：`16.0.0-250627`、`15.0.0-250627`、`14.0.0-240527`、`10.0.0-250907`，見 §5.5）；部署記錄保存當時 tag **+ digest**；更新映像前先在測試設備走完「啟動 / ADB / 持久化 / GPU / App 行為」驗證清單（P5 runbook），未過驗證唔准入正式 Template。實作落點：P5（Template 欄位驗證拒 `latest`/`*-latest` 字尾 + digest 記錄欄）。

**§2-3 核心模組必須按宿主機確認**
- 原稿錯喺邊：無條件 `modprobe ashmem_linux` 並把失敗當唯一判定，忽略不同 kernel/映像差異。
- 本系統點做：`scripts/redroid-preflight.js`（P5，只讀）檢查：Linux OS、kernel version、Docker daemon、**binder module/device**（`lsmod`、`/proc/modules`、`/dev/binder*`）、`dmesg`、磁碟空間、port 佔用；**按實際 kernel 給出建議**（redroid-doc 現列 `binder_linux` + `ashmem_linux`；新 kernel 有 `androidboot.use_memfd` 可取代 ashmem — 見 §5.6 文件核對）；缺 module 時回報**具體手動修正建議 + 官方文件連結**，App 啟動時**唔自行安裝/載入 kernel module**、唔做高風險系統修改。實作落點：P5 preflight + 診斷頁獨立結果卡。

**§2-4 NVIDIA DeviceRequests 唔係 GPU 成功證明**
- 原稿錯喺邊：加了通用 GPU device request 就宣稱 Redroid 用咗宿主 NVIDIA 做 Android EGL/WebGL 渲染。
- 本系統點做：GPU 狀態五態機 `not_configured / configured_unverified / verified / degraded / failed`（MD §10.4）：`verified` **只可以**來自設備內可重現檢查 + 記錄（檢查命令、輸出摘要、測試時間、映像版本/driver）；只設定參數未實測 = `configured_unverified`，UI 顯示「未驗證」；GPU 不可用時容器管理照常，UI 提示效能可能下降。**DeviceRequest 配置本身唔改狀態。**實作落點：P5（診斷 + GPU verification 存 `diagnostics` 記錄，唔自動升級狀態）。

**§2-5 tun2socks 原稿未完成透明導流**
- 原稿錯喺邊：「建 `tun0` + 起二進位 = 流量全部被攔截」— 路由、DNS、iptables/nftables、權限、回程路由、故障封鎖全缺。
- 本系統點做：**MVP 唔部署任何 tun2socks 透明代理**，亦無 tun0 相關代碼/配置。若日後合法內部網路測試有需要：**另立網路設計文檔**（路由表、DNS 路徑、fail-closed 測試、還原程序）先實作（MD §2-5 原文流程）。實作落點：無 P0–P6 落點（明確排除），需要時單獨立項。

**§2-6 代理監聽範圍及憑證處理危險**
- 原稿錯喺邊：`gost -L=:1081` 監聽所有網卡；代理帳密寫命令列（入 `ps`/log）。
- 本系統點做：**唔實作**住宅 IP 輪換、代理身份輪換、平台風控規避功能（MD §2-6 + 附錄 B + 頭部範圍原則三重排除）。任何日後合法企業/內部代理配置必須：Secret 管理（入 `app_settings`/env，唔入命令行）、**限制監聽位址（127.0.0.1）**、審計記錄。實作落點：設計約束（P1 settings schema 如有 proxy 欄位必須 `bind: 127.0.0.1` + secret 引用）；P0–P6 唔有代理功能交付。

**§2-7 Docker inspect 錯誤唔可以一律當不存在**
- 原稿錯喺邊：inspect 失敗就當 container 唔存在 → 觸發重建流程；daemon 掛咗/權限問題/timeout 全被誤讀成「容器消失」。
- 本系統點做：DockerService（P2）**錯誤分類**：只有確定 `404 / no such container` → not-found 流程；`ECONNREFUSED`/socket 缺失 → `daemon_unavailable`；`EACCES`/permission → `permission_denied`；timeout → `timeout`；其餘原樣分類並顯示（含 request ID、operation、container ID）。每次失敗寫 log（唔入 audit，除非係操作類）。UI 對已消失容器：更新資料但保留 task/audit 歷史（MD §9.1）。實作落點：P2（DockerService 分類層 + §16.1 指定的四類 unit tests：404 / permission denied / daemon down / timeout）。

**§2-8 現有 Node 腳本阻塞且有注入風險**
- 原稿錯喺邊：把網頁/AI 提供嘅文字拼進 `execSync()`（阻塞 + shell 注入）。
- 本系統點做：一般容器操作**一律 dockerode**（Programmatic API，無 shell）；必要系統程式呼叫（例如 adb binary）用 `spawn`/`execFile` + **固定程式路徑（配置注入，唔接受輸入）+ 參數陣列 + 嚴格白名單 + 逾時 + 輸出位元組上限 + 退出碼檢查**；**禁 `shell: true` 接收使用者/AI 字串**（MD §0-5、§10.3 硬規則）。實作落點：P2（dockerode）+ P5（adb allowlist functions）；P6 加 lint 規則禁止 `execSync`/`shell:true` 模式。

**§2-9 缺少真正的任務生命週期**
- 原稿錯喺邊：`console.log('[✓] 完成')` 當成功證據，無 run_id、無狀態、無時間、無事件歷史。
- 本系統點做：`task_runs`（id、status、input/result、error、attempt、queued/started/finished、duration、idempotency_key）+ `task_run_events`（每次狀態事件含 payload，敏感已清理）持久化（MD §7）；**所有合法狀態轉換集中喺 `TaskRunService`**（queued/running/needs_approval/succeeded/failed/cancel_requested/cancelled/timed_out/skipped，MD §11.3），唔准 route 直接改狀態；`finished_at` 只在 terminal status 寫入；成功 = 有持久化結果 + event 鏈，UI 全部來自真 API。實作落點：P3（狀態機 + 事件寫入 + §16.1 合法/非法轉換 unit tests）。

**§2-10 安全邊界（防檢測/偽裝內容）**
- 原稿錯喺邊：以 Magisk/LSPosed/HMA、硬體指紋偽裝、Canvas/WebGL 噪點「防檢測」為目標。
- 本系統點做：**明確排除，零實作** — 唔加入裝置指紋偽裝、Root/模擬器隱藏、逃避第三方平台檢測、虛假評論/互動功能（MD 頭部範圍原則 + §2-10 + 附錄 B）。設備管理只服務合法測試與運維；社交平台相關工作（如日後有）只接官方授權 API + 授權測試帳號。實作落點：範圍鐵律（code review checklist 一欄；P6 runbook「禁止功能清單」引用本條）。

## 4. 環境現況（2026-10-14 實測，詳見 `docs/repo-audit.md` §2–3）

- Ubuntu 24.04.4 LTS (Noble)，kernel `6.8.0-117-generic`，91Gi RAM，`/` 剩 1.2T。
- Docker Engine 29.1.3（client=server，API 1.52 / min 1.44，containerd 2.2.1，runc 1.3.4）。本 agent session 執行 docker 需 `sg docker -c 'docker ...'` wrapper（session group snapshot 舊；host 配置正常）。
- Host Node v22.22.2 / npm 10.9.7（compose 用 `node:24`，§5.1 已核 LTS 狀態）。
- GPU：2× RTX 3090（driver 580.178.04，CUDA 13.0）；audit 時 busy（97% util）— GPU 實測要另揀窗口。
- **binder/ashmem：`lsmod`、`/proc/modules`、`/dev/binder*` 三查全無 → 本機起唔到真 Redroid 設備** → P5 用 adapter/mock 驗證 API 路徑，真機列入待驗證（§6 V1–V4），UI 如實顯示未驗證狀態，唔假裝。
- 禁 touch 範圍（工單）：其他 repo、15532/15432 DB、3001/3011/3100/3008/9800 服務、30000 model。

## 5. 版本相容核實（必實際跑命令 — 實跑輸出，2026-10-14 14:36–14:40 HKT）

### 5.1 Node 24 LTS 官方支援狀態

命令：`curl -s https://nodejs.org/dist/index.json`（870 releases）+ node 解析，輸出：

```text
--- Node 22:
  latest: v22.23.3 lts: Jod date: 2026-09-23
  first-LTS of line: v22.11.0 on 2024-10-29 lts codename: Jod
--- Node 24:
  latest: v24.21.0 lts: Krypton date: 2026-09-07
  first-LTS of line: v24.11.0 on 2025-10-28 lts codename: Krypton
  newest 3: v24.21.0(Krypton), v24.20.0(Krypton), v24.19.0(Krypton)
--- Node 25:
  latest: v25.9.0 lts: false date: 2026-03-31
--- Node 26:
  latest: v26.11.1 lts: false date: 2026-10-07
  newest 3: v26.11.1, v26.11.0, v26.10.0
```

**結論**：Node 24（Krypton）= 現行 active LTS（MD §3 要求成立）；Node 26 已出（v26.11.1，2026-10-07）但**官方 index 標 `lts: false`**（預期 2026-10 底先入 LTS）→ 按 MD §3「等 Node 26 進入 LTS 並經過依賴相容測試後再升級」，P1 用 **Node 24（compose image `node:24`；Docker Hub tag 實查存在，last_updated 2026-10-06）**。Host 本地 dev 用 v22.22.2（Jod LTS，官方支援中）可接受，CI/lock 基準 = 24。

### 5.2 BullMQ 鎖定版本 + Job Scheduler API 實證

命令 1：`npm view bullmq version` → `6.3.15`（latest）。

命令 2：解包實證三方法存在於該版本 dist（sandbox `/tmp/openclaw-sandbox-waterarmy-p0/bm`，`npm pack bullmq@6.3.15` + tar + grep）：

```text
=== engines ===
{"node":">=14.17.0"}
=== method presence in dist ===
upsertJobScheduler:   package/dist/cjs/classes/worker.js package/dist/cjs/classes/job-scheduler.js package/dist/cjs/classes/queue.js package/dist/esm/classes/job-scheduler.d.ts
getJobSchedulers:     package/dist/cjs/classes/redis-queue-backend.js package/dist/cjs/classes/job-scheduler.js package/dist/cjs/classes/queue.js package/dist/cjs/postgres/postgres-queue-backend.js
removeJobScheduler:   package/dist/cjs/classes/redis-queue-backend.js package/dist/cjs/classes/job-scheduler.js package/dist/cjs/classes/queue.js package/dist/cjs/scripts/index.js
```

命令 3：官方 docs（`https://docs.bullmq.io/guide/job-schedulers`，2026-10-14 抓取）：`queue.upsertJobScheduler('id', {every|pattern}, template)` 為現行 API；upsert =「updated or created without duplications」（貼 MD §12.1 reconciliation 冪等要求）；UTC cron 用 `tz: 'UTC'`（**舊式 `utc` option 已移除** — 即 MD §3 禁之舊式 repeat API 喺 6.x 已除）。

**結論**：鎖定 **BullMQ 6.3.15**（P1 落 lock）；三方法實證存在；Node 24 滿足 engines（>=14.17.0）；排程統一用 Job Scheduler API（`upsertJobScheduler`/`getJobSchedulers`/`removeJobScheduler`），**代碼中禁止出現舊式 repeatable API**。備註：6.3.15 dist 內有 postgres-queue-backend，但 MD §3 指定 Redis → 維持 Redis（V7）。

### 5.3 其餘依賴現行穩定版（`npm view <pkg> version` 實跑，2026-10-14）

| 包 | 實查 latest | 備註（實查 dist-tags） |
|---|---|---|
| dockerode | **5.0.1** | stable |
| prisma | latest dist-tag = `8.0.0-rc.22`（**RC**） | 見 §5.4 → 選 **7.10.0** |
| @prisma/client | **7.10.0** | 與 prisma CLI 7.10.0 配對 |
| fastify | **5.12.7** | next = 6.0.0-alpha.5（唔揀 alpha） |
| vite | **8.3.4** | stable |
| react | **19.3.0** | next = canary（唔揀） |
| pino | **10.4.0** | stable（next dist-tag 為舊 7.0.0-rc.9，忽略） |
| playwright / @playwright/test | **1.64.0** | next = 1.65.0-alpha（唔揀） |
| ioredis | **6.0.0** | BullMQ 6.x 之 redis 驅動 |
| lucide-react | **1.57.0** | MD §3 指定 UI icon 庫 |
| @node-rs/argon2 | **2.2.2** | MD §13.2 Argon2id 實現（argon2 0.45.1 為備選） |
| zod（可選） | 4.6.7 | 如 P1 決定用 zod 做 provider 回應/tool args 驗證；MD §3 只強制 Fastify JSON Schema + 「另做 schema 驗證」，P1 再定（ajv 已隨 fastify 有） |

**以上全部 = P1 落 lock 時鎖定基準。**

### 5.4 Prisma RC 陷阱（實查記錄）

`npm view prisma dist-tags` → `latest = 8.0.0-rc.22`；`npm view prisma versions --json` 全 9367 版中 stable 317 個，**最新 stable = 7.10.0**（7.9.0 → 7.9.1 → 7.10.0）；8.x 另有 `8.1.0-dev.5..9` 在 development。`latest` 指向 RC 唔代表 8 可用 — 按 MD §3「不要自動把 latest 當作正式相依版本」，**P1 鎖定 7.10.0**；P1 落 lock 前重查 8.x 有無正式 stable（V6），有且實測相容先升，唔然留 7.10.0 並回寫本檔。

### 5.5 Redroid 映像版本實查（Docker Hub API）

命令：`GET https://hub.docker.com/v2/repositories/redroid/redroid/tags?page_size=25&ordering=last_updated`（2026-10-14）：

```text
10.0.0-latest            | updated 2025-09-07
10.0.0-250907            | updated 2025-09-07
16.0.0_64only-latest     | updated 2025-06-29
16.0.0_64only-250627     | updated 2025-06-29
latest                   | updated 2025-06-29
16.0.0-latest            | updated 2025-06-29
16.0.0-250627            | updated 2025-06-29
15.0.0_64only-latest     | updated 2025-06-29
15.0.0_64only-250627     | updated 2025-06-29
15.0.0-latest            | updated 2025-06-29
15.0.0-250627            | updated 2025-06-29
14.0.0-latest / 14.0.0-240527 / ...
```

**P5 候選**：`16.0.0-250627`（新）或 `15.0.0-250627`（穩）— 揀一個 dated tag，拉取後記 digest，走完 §2-2 驗證清單先入 Template。**`latest`/`*-latest` 一律拒**（§2-2 反制落地）。注意 `10.0.0-latest` 更新日最晚只係重新推送，唔代表版本較新 — 選版本按 Android 大版本，唔按 updated 時間。

### 5.6 Redroid kernel module 要求（官方文件核對，2026-10-14）

`redroid-doc` README（raw.githubusercontent.com 實抓，7023 bytes）相關行：

```text
47: ## install required kernel modules
49: modprobe binder_linux devices="binder,hwbinder,vndbinder"
50: modprobe ashmem_linux
100: | androidboot.use_memfd | use memfd to replace deprecated ashmem, plan to enable by default | false |
178: > make sure the required kernel modules are installed; run dmesg -T for detailed logs
```

對照本機（§4：module/device 全缺）→ **真設備本機阻塞**；P5 preflight 按此給出手動修正建議（`modprobe binder_linux ...`；kernel 6.8 若上游映像支持 `androidboot.use_memfd=true` 可省 ashmem — 需實測，V1/V3 合併驗證）。本 App **唔自動 modprobe**（§2-3 反制 + MD §10.1）。

## 6. 尚待驗證項（P0 實測產生，P5/P1 跟進）

| # | 項目 | 阻塞/原因 | 跟進 phase | 驗收方式 |
|---|---|---|---|---|
| V1 | Redroid 真設備啟動 | 本機無 binder_linux/ashmem_linux + `/dev/binder*` | P5 | 手動載入 module 後起真設備；preflight 綠 |
| V2 | GPU 渲染驗證（`redroid_gpu_mode=host`） | 有 2×3090 但 audit 時 busy；需真設備入機實測 | P5 | 五態機升到 `verified` 且有命令/輸出/時間/映像記錄 |
| V3 | `ro.*` override 喺選定映像有無效 | 須實測，唔假設 | P5 | 逐項實測記錄先入 Template |
| V4 | 映像版本 pin（dated tag + digest） | 候選 16.0.0-250627 / 15.0.0-250627 | P5 | 驗證清單全綠後寫 Template + digest |
| V5 | ADB 127.0.0.1 外部不可達 | 需起機驗證 | P5 | `ss -ltnp` + 外部視角連線測試失敗 |
| V6 | Prisma 8 stable 時點 | latest dist-tag 仍 RC | P1 落 lock 前 | 重查 dist-tags；stable + 相容測試過先升 |
| V7 | BullMQ postgres backend 可否替 Redis | MD 指定 Redis，唔擴需求 | 無（備註） | 如 Redis 路線出問題另議 |

**P5 特別聲明（MD §17 原文紀律）**：無可用 Redroid/kernel/GPU 環境時，用 adapter/mock 測試 API，真機驗證明確列為未完成，**不可假裝驗證成功** — 本項直接約束 P5 交付口徑。

## 7. 已決 / 未決

**已決（P0 定案，P1 起執行）**：
1. Prisma（vs Knex）— §2。
2. Node test runner（vs Vitest）— §2。
3. MVP 唔加 Tailwind（plain CSS）— §2。
4. Provider：`openai_compatible` 必做 + mock Provider 必做（MD §16.3 要求 CI 唔需真 token）；`webhook_agent` 只喺明確配置 endpoint 後啟用/顯示（MD §6.7）。
5. 時區預設 `Asia/Taipei`、API bind `127.0.0.1:3000`、AI 預設 timeout 120s / 上限 900s、預設 3 attempts、並行 4、日誌尾 500 行（MD 附錄 A 預設值全盤接受）。
6. Compose 服務：web / api（唯一掛 docker socket）/ worker（無 socket）/ postgres / redis；DB+Redis 唔 publish 對外（MD §3/§15）。
7. 首 admin = CLI bootstrap（`npm run setup:admin`），無公開註冊（MD §13.2/§14）。

**未決（留 P1 實測後定）**：
- P1 落 lock 精確 patch 版本（以 §5 表為基準）。
- zod vs ajv 做 provider 回應/tool args 驗證（P1）。
- Redroid 候選映像二擇一（P5 實測）。
- Redis persistence 配置（BullMQ 需要 AOF/快照策略 — P1 依 BullMQ 官方建議定）。
- SSE 並行上限具體數值（P2/P3 依压測）。

---

## 8. P1 回寫（2026-10-14，落 lock 時發現的實際差異）

依 §5.3 策略「P1 落 lock 前重查 + 衝突以同 major 最高 stable 實測相容為準並回寫本檔」：

1. **V6 結果（Prisma 8 stable 時點）**：P1 落 lock 前重查 `npm view prisma dist-tags` → `latest` 仍係 **8.0.0-rc.22（RC）**、`next` = 8.0.0-rc.10、`prev` = **7.10.0** → 確認鎖定 **7.10.0**（同 §5.4 判定）。
2. **Prisma 7 破壞性變更（實測，非 RC 文檔）**：`datasource.url` 已**從 schema.prisma 移除**（P1012）。新規則：
   - CLI（migrate 等）連接 URL → **`prisma.config.js`**（本 repo 用 ESM JS 配置，零 TS — `defineConfig({ schema, datasource:{url}, migrations:{path} })`，從 `prisma/config` import）。
   - Runtime `PrismaClient` 必經 **driver adapter** → 新增頂層依賴 **`@prisma/adapter-pg@7.10.0`**（與 prisma 同版；transitive `pg@^8.16.3` 入 lockfile）。`plugins/db.js` 用 `new PrismaPg({ connectionString })` + `new PrismaClient({ adapter })`。
   - `prisma-client-js` generator 喺 7.10.0 仍存在，生成入 `node_modules/@prisma/client`（ESM import 實測 OK）；唔需要用 `prisma-client`（會生 TS 檔，違反 §2 零 TS）。
3. **Web 新依賴**：**`@vitejs/plugin-react@6.1.2`**（peer `vite ^8.0.0` 滿足；oxc/rolldown/babel-compiler peer 全 optional）。無 vite 8 唔兼容嘅替代方案，lockfile 加呢一個。
4. **Web router**：自製 hash router（`apps/web/src/router.js`，~40 行）— 唔引入 react-router-dom（唔喺 §5 表；唔擴供應鏈）。
5. **映像 pin（compose，2026-10-14 manifest 實查存在）**：`postgres:17.6`、`redis:7.4.5`（`--appendonly yes` 按 BullMQ 建議）、`node:24`（api/worker/web 三 Dockerfile 統一）。
6. **Host 工具補裝（唔係 repo 內容）**：host 原無 compose plugin（`docker compose` unknown command）→ user-level `~/.docker/cli-plugins/docker-compose` v2.40.3（sha256 驗過）。
7. **lockfile 基準**：lockfileVersion 3，頂層 14 個直接依賴全部精確 pin（§5 表 13 個 + @prisma/adapter-pg）；`engines.node >=24` + `.nvmrc=24`。

## 9. 未決項更新

- ~~Prisma 8 stable 時點（V6）~~ → P1 重查：仍 RC，留 7.10.0（§8.1）。
- ~~zod vs ajv（provider 回應/tool args）~~ → P1 決定：**ajv**（Fastify 內建，零新依賴）；P3 provider 回應/tool args 驗證用 ajv 直接 instantiate，唔引 zod。
- Redis persistence 配置 → **AOF**（`redis-server --appendonly yes`，BullMQ 官方建議）— compose 已落。
- SSE 並行上限 → **P2 決定：50**（`SSE_MAX_CONCURRENT`，可 env 調；超 = 503 SSE_LIMIT，斷線/release 即時還 slot；單 owner 背景 pump 模式無洩漏風險 — 見 §10.5）。

---

## 10. P2 回寫（2026-10-14，真 daemon live 實測產生 — 全部實測可重現）

### 10.1 dockerode 5.0.1 `createContainer` 回傳形（v3/v4 文檔全部失真）

實測（host node + `sg docker`，docker 29.x daemon）：`createContainer(config)` 回傳 **`Container` 實例**（小寫 `.id`、`.name`），**唔係** 文檔常見嘅 `{Id, Warnings}` body。service 取 id 一律 `created.id` + 防呆（無有效 id → 當 create 失敗、冪等記錄清理）；fake adapter 已對齊同形（`createContainer` 回 `getContainer(id)`）。

### 10.2 容器 Name 只收 query param（body `Name` 被 daemon 忽略 — 重大 live finding）

- 實測鏈（curl 直接入 socket，控制實驗）：
  - body `{"Name":"x"}`（純 URL）→ daemon 隨機名 `/serene_beaver`（**body Name 被忽略**）
  - `?name=x`（**小寫**）→ daemon 尊重名 `p2-name-probe5` ✓
  - `?Name=x`（大寫 N）→ 被忽略（Go `r.Form.Get("name")` case-sensitive）
- docker-modem 陷阱：`buildQuerystring(opts._query || opts)` — 唔傳 `_query` 時會把**成個 config**（Env 陣列、HostConfig 物件）都 stringify 入 query string（body 亦有一樣）— 功能上 daemon 只讀 query，但 query 噪音大且 `Name`（大寫）唔生效。
- **本系統規則**：create 一律 `c.createContainer({ _query: { name }, _body: configWithoutName })`。`_query` → 乾淨 querystring；`_body` → 乾淨 JSON body。daemon 行為對齊 Docker Engine API 文檔（name = query param；ContainerConfig body 無 Name 欄）。

### 10.3 daemon remove 語義（DELETE 設計依據）

- 運行中容器 `remove` 無 `force` → **409**（`container is running: stop the container before removing or force remove`）— 實測。UI/腳本正路 = 先 stop 再 delete；`force=true` 係例外路（API 支持，兩步確認照做）。
- `removeVolumes=false`（默认）：daemon 只删容器，**bind mount 源文件/anonymous volume 保留**；`force` 對 exited 容器無副作用差異。審計記錄 `removeVolumes/bindsPreserved/byException`。

### 10.4 敏感 env mask：過保守係安全方向（live finding）

- Live api 容器 env 實查：`SESSION_SECRET` 舊正則命中，但 **`APP_ENCRYPTION_KEY` 同 `DATABASE_URL` 漏網** — `DATABASE_URL` 內嵌 `postgresql://user:pass@host` = DB 密碼直接洩。
- 修：`SENSITIVE_ENV_KEY` 加 `key|url|dsn|uri|connection_?string` 分段 — 副作用係 `APP_PUBLIC_URL` 都會 mask（**接受嘅過保守**：過 mask 無害，漏 mask 洩密）。
- 測試固化：`tests/unit/docker-service-core.test.js` 「live-daemon finding」subtest 用真 env 集驗證。

### 10.5 SSE 架構決定（undici 實測陷阱 → 單 owner 背景 pump）

- **陷阱（probe 實證）**：undici `fetch` 嘅 body `reader.read()` 若俾 `Promise.race` timeout 搶走（abandoned pending read）→ **stream 永久停擺**（之後任何 read 永遠冇 chunk）。故 SSE 測試/消費者一律：單一背景 pump 專有 reader；斷言/業務邏輯用共享 buffer + wakeup set 等待；release 冪等；route teardown 雙掛（req close + res close/finish）。
- **`app.inject` 唔能測 hijacked SSE route**（light-my-request 永久 hang）→ SSE 集成測試全部真 HTTP（`app.listen({port:0})` + `fetch` + `AbortController`）。
- 事件白名單（`start/stop/kill/die/pause/unpause/restart/rename/create/delete/update`）喺 service 層過濾（image/exec_create 等唔落 stream）；斷線偵測 = 寫失敗 / req close 雙重。

### 10.6 其他實測收錄

- **Node 22 `node --test`**：async 父 test 內嘅 `t.test()` 必須 `await`，否則父 finish 後 subtests 被 cancel（計入 cancelled）；`node --test <dir>` 唔得（目錄當 module path）→ npm script 用 shell glob。
- **Fastify 重用 route sub-schema**：`querystring: X` 要求 X 係 inner JSON Schema（唔可以再包層）；`coerceTypes:false` 時 query 一律 string，service 自己 parse int/bool。
- **daemon 404 判定**：只有「確定 404」（`statusCode===404` 或 no-such-container 訊息 + statusCode）先係 `CONTAINER_NOT_FOUND`；純 message 字樣唔夠（防 daemon-down 時嘅 5xx 被誤分 404）。
- **冪等 op 語義（§9.3 live 驗證）**：start on running → 200 `idempotent:true`；stop on exited → 同；pause on running 外狀態 → 409。audit details 記錄 `from/to/idempotent`。
- **displayName 驗證**：allow 內部空白（trim 後 1–60、唔准首尾空白）— live 實測發現 `/^\S{1,60}$/` 誤拒正常顯示名。

---

## 11. P2 live 實測摘要（2026-10-14，docker 29.x + compose stack）

完整證據：`/home/kenneth/.openclaw/workspace/logs/waterarmy-p2-progress.md` §C6。

- `GET /health/ready` → 200（postgres/redis/docker 全 up）
- login/me → 200；container list（8 實容器 = daemon `docker ps -a` 逐名對上）；inspect/logs/stats 真數據
- NOT_MANAGED gate：對 `water-army-api-1` stop → 403 `NOT_MANAGED`（audit 落 failure 行）；假 64-hex id → 404 `CONTAINER_NOT_FOUND`
- 模板：upsert 200 → create **201**（name 正確、四 labels 齊、mem=64MiB/cpu=0.5 落 daemon 實查）→ 同 key 回放 **201 + `idempotent-replay: true`**（唔建第二個）
- env mask live：`APP_TOKEN` → `••• (22 chars)`；api 容器 5 個敏感 key（SESSION_SECRET/APP_ENCRYPTION_KEY/DATABASE_URL/REDIS_URL/APP_PUBLIC_URL）全部 masked，PATH 等明文
- SSE live：`event: container` frame 實收（create/kill/stop/start，filter 生效）
- DELETE 兩步：錯 confirm → 400；stop → delete 200（`bindsPreserved` 記錄）；後 inspect → 404；audit 13 行全齊（create/ops/delete success+failure，details 只 envKeys 無 env 值）
- Web UI headless（chromium-1217）：登入 → list 頁 8 行實數據 + live CPU/mem、detail 4 tabs、SSE pill = LIVE、config tab 5 masked pills、0 意外 console error（1 個預期中嘅 pre-login 401）

**Dev admin 密碼已重置**：`P2LiveAdmin!2026x`（原密碼喺舊 log 已 mask 唔回；正式部署必改）。

---

## 12. P3 架構決定（AI Provider + Task Queue + Tool Registry，2026-10-15）

### 12.1 執行拓撲：API 只入隊，Worker 執行

- 任務生命周期 = **DB 狀態機（`task_runs`）+ BullMQ 隊列（`task-runs`）+ 事件流（`task_run_events`）**。API 只寫 DB + 入隊（`task-queue.js` plugin 用 `buildRedisConnection()` 建 Queue）；worker 消費 job、驅動狀態機、落事件。
- **iron rule（P1/P2 教訓）**：BullMQ 連線一律 `buildRedisConnection()`（api Queue 同 worker 同一 helper）；**每個 ioredis 實例必掛 `on('error')`**（否則 ioredis 未 catch error = process crash）；wiring 測試斷言 connection shape。
- worker `/health` 加 **queue 狀態**（`connected/closed/error`，事件驅動 — `ready/error/close` 事件寫 flag，唔係 request-time probe）。
- **boot reconcile**：worker 起動時 `reconcileStaleRuns` — 任何 `running` 但已唔喺 queue 嘅 run（worker crash 期間開跑緊）→ 標 `failed`（`WORKER_CRASHED`）+ 落事件。防「僵尸 running」。

### 12.2 Tool 執行邊界：worker 無 Docker socket（硬驗收）

- **worker 容器零 Docker socket mount**（`docker inspect` 實證）— 跟 P2 原則一致（只有 api 掛 `:ro` socket）。
- tool handler 全部經 **API HTTP readonly 端點**（`GET /api/containers*`、`GET /api/health/ready`）＋ **service token**：header `x-wa-service-token` = env `WORKER_API_TOKEN`（api + worker 同值）。
- API 端 service identity = **operator 角色、固定 UUID、audit 可辨**（actor = `service:worker` 樣式）— RBAC 照常行，P2 嘅 managed gate / 例外表 / audit 一併生效。AI 要動容器 = 必須經 API 真人授權層。
- **AI 唔可能自批**：approve/reject route 只收 **admin 真人 session**（`requireHuman` guard）— service token 就算係 operator 都係 403（RBAC 矩陣實測）。

### 12.3 Agentic tool loop + safety class（fail-closed）

- tool registry = `packages/shared/src/tool-registry.js`（純元數據 + schema 驗證，零 I/O）；`findTool` **fail-closed**（未知 tool / disabled class → 拒絕，唔係 default-allow）。
- safety class：`readonly`（自動執行）／`approval_required`（worker 落 `waiting_approval` 事件 + 寫 `approval_requests`，輪詢 DB 等 admin 決定）／`disabled`（registry 有 metadata 但 gate 掉 — 例如日後加 shell tool 嘅佔位）。
- P3 工具集：`system.get_health`、`docker.list_managed_containers`、`docker.get_managed_container_status`、`docker.get_managed_container_logs`（readonly）＋ `docker.restart_managed`（approval_required，演示人工批准流）。
- loop 上限：max rounds（防 runaway）；每個 tool result 過 `scrubObject`（boundary-aware 敏感 key 脫敏）先入事件/模型上下文。

### 12.4 Approval gate

- worker 喺 job 內 **1s 輪詢 DB** 等 `approval_requests.status`（`pending → approved/rejected/expired`）；同時 poll cancel/timeout 旗標 → 任何一個先至就真停。
- run 取消/逾時 → 該 run 所有 pending approval 標 `expired`（唔會留懸空 approval 俾 admin 誤批）。
- approval 記錄：`arguments`（JSON，已 scrub）、`requestedAt`、`reviewedAt`、`reviewedBy`（admin user id）、`note`。

### 12.5 Cancel / Timeout / Retry 語義

- **cancel 真停**：API 設 `cancel_requested` + best-effort 移除 waiting job（**in-flight 嘅真停靠 worker DB poll**，唔靠 queue）；provider fetch 傳 `AbortSignal`；cancel 之後**零 output / 零新事件**（live 實證：cancel 後 event count 凍結）。
- **timeout** = run-level deadline（`startedAt + timeoutMs`，per-run 可設、cap `TASK_MAX_TIMEOUT_MS`）→ terminal `timed_out`；BullMQ job timeout 做 backstop（deadline + 30s）。
- **retry**：auto（transient provider error：network/429/5xx，指數 backoff 1s→30s cap，`maxAttempts`）＋ manual（`POST /api/tasks/runs/:id/retry`，**terminal-only**）。兩者都 = 同 run row 嘅新 attempt（`attempt+1`），**舊 attempt 輸出/事件全數保留**喺 event 流（`attempt_started` 事件分隔）— 唔開新 run、唔覆蓋。

### 12.6 Provider 層

- **API key 加密**：AES-256-GCM（`packages/shared/src/provider-crypto.js`），key = env `APP_ENCRYPTION_KEY`（64 hex）；**api 同 worker 用同一 key**（worker 本地 decrypt 後直連模型 endpoint，**key 唔跨 queue** — BullMQ payload 只有 provider name）。
- provider 解析：create body `provider` > env `AI_PROVIDER` > default；`mock` = 內置可編排 mock（`AI_MOCK_SCRIPT` = 內置名/檔案/inline JSON step 陣列：`delayMs/error/content/toolCalls/finishReason`）— 實測/演示用，零外部依賴。
- OpenAI-compatible adapter：error classification（`PROVIDER_AUTH`/`PROVIDER_BAD_REQUEST`/`PROVIDER_RATE_LIMITED`/`PROVIDER_UPSTREAM`/`PROVIDER_TIMEOUT`，retryable set 明確）+ response redaction（error body 過 scrub 先入 log/事件）。

### 12.7 SSE task events

- `GET /api/tasks/runs/:id/events`：DB poll（1.5s）＋ `id:` cursor（`Last-Event-ID` / `?after=`，**cursor 必須係 uuid** — 非法 cursor = 400，唔係 500；25cd5fe 實測收錄）＋ heartbeat 25s ＋ terminal 後發 `done` 再 close ＋ 並行 cap（10）。
- 事件 = `task_run_events` 表全量（`queued/attempt_started/provider_request/provider_response/tool_call/tool_result/waiting_approval/approval_resolved/status/retry_requested/succeeded/failed/cancelled/timed_out/output/error`）— **DB 即 event log**，重連 = `?after=` resume（live 實證：斷線後 cursor 補齊、零重複零遺漏）。
- 測試：真 HTTP（`app.listen({port:0})` + fetch + AbortController）— 沿用 P2 鐵律（`app.inject` 唔能測 hijacked route）。

### 12.8 BullMQ 實測收錄

- **job id 唔得包含 `:`** — BullMQ 內部用 `:` 做 key namespace，`taskJobId` 由 `runId:attempt` 改 `runId-attempt`（f2a58b6；fake queue 同步修正保持誠實）。
- 冪等入隊：同 `jobId` 重複 `add` → `JobExistsError`，service 層 catch 後照 DB 狀態行（唔建第二個 attempt）。

### 12.9 RBAC 矩陣（P3 端點）

| 端點 | viewer | operator | admin | service token (operator) |
|------|:---:|:---:|:---:|:---:|
| GET runs / run detail / approvals list / SSE | 200 | 200 | 200 | 200 |
| POST run / cancel / retry | 403 | 200 | 200 | 200 |
| GET/POST/PATCH providers（key 加密） | 403 | 403 | 200 | 403 |
| POST approval approve/reject | 403 | 403 | 200 | **403（AI 唔可自批）** |
| GET tools（registry 元數據） | 200 | 200 | 200 | 200 |
| GET audit-events（P2 既有） | 403 | 403 | 200 | 403 |

（服務 token 只用於 worker→API 嘅 readonly tool 路徑；矩陣入面 200 嘅 cell 係「權限上可以」，非生產用路徑。）

### 12.10 其他實測收錄（P3）

- **fake db `orderBy` 雙形狀**：Prisma `orderBy` 接受 object（`{createdAt:'desc'}`）同 array（`[{...}]`）— fake 必須兩種都支持（`applyOrderBy` helper），否則 P2 舊測試（array 形）同 P3 新路由（object 形）必有一邊炸。
- **raw INSERT 冪等 seed**：e2e/seed 用固定 25 位 lowercase alnum id（cuid 形）— 短 id / hyphen id 會被 `normalizeRoute` 誤判（P2 已知陷阱，P3 seed 沿用）。
- **web EventSource re-open**：browser `EventSource` 斷線重連會 resend `Last-Event-ID` **header**，而 API cursor 係 `?after=` **query** — client（`useTaskEvents`）自己持有 cursor，有 cursor 就 close + re-open 帶 `?after=`（零重複）；無 cursor 就俾 native retry 處理。

## 13. P4 架構決定（排程系統，2026-10-15 — 全部經 live 實測驗證）

### 13.1 PG-first，BullMQ 係 derived index（核心不變量）

- 所有排程寫入 = **先 PG 落 row，後 BullMQ 同步**。BullMQ 寫失敗（redis down / 斷線）→ row 照存 + `sync_status='sync_error'`，HTTP 照 201（row 係事實），`POST /schedules/:id/sync` 重試。
- BullMQ 索引可以隨時整份丟：worker **scheduler reconciler**（boot 時 + 每 5 分鐘）以 PG `schedules` 表做 desired-state，原地重建/修正。
- 反方向禁止：BullMQ 側永不產生新排程（fire handler 只消費，guard 全部對住 DB row 重驗）。

### 13.2 Stable scheduler key + 原地 upsert

- key = `sched-<schedule uuid>`（`schedulerIdFor`）— 改參數 = 同 key `upsertJobScheduler`（原地覆蓋，**零重複**；唔係 remove+create）。
- 漂移判斷 = pattern/every/tz + `schedulingHash`（參數摘要）；**兩邊都要 `?? null` 正規化** — 真 BullMQ entry 唔會存 absent 欄位（`undefined`），fake 用 `null` — v1 判斷 `entry.every !== (want.every ?? null)` 令每次 reconcile 都假陽漂移（live 實錚：每 5 分鐘 `driftFixed:2`）。

### 13.3 once = delayed job，非 Job Scheduler

- once 排程唔入 scheduler index：確定性 id `schedonce-<uuid>-<slotMs>` 嘅 delayed fire job（BullMQ 6 對 custom jobId 重複 `add` 會 `JobExistsError` — heal 邏輯要 tolerate）。
- fire 後 = 自動停用 + `next_run_at=NULL`（terminal）。`task_runs.schedule_id` **無 FK**（屬設計：schedule 删除後 run lineage 要活埋）。

### 13.4 Slot 權威 = job id（live 發現，BullMQ 6 形狀）

- BullMQ 6 Job Scheduler fire 出嘅 job：**data/opts 都冇 slot**；slot 藏在 job id — `repeat:<schedulerId>:<nextMillis>`（`job-scheduler.js getSchedulerNextJobId` 實查）。once job 例外（自己 data 帶 `scheduledAt`）。
- fire handler 解析次序：`data.scheduledAt` → jobId regex → `opts.prevMillis`（forward-compat）→ wall clock（log warn，最後手段）。
- **重啟/漂移安全性**：handler 對 DB row 重驗（deleted/disabled/stale generation = `schedulingHash` 唔符/stale slot 過容忍窗 → drop）；slot 冪等 key `sched-<uuid>-<slotMs>`（重送 = replay 同一 run，**零重複**）；skip 行用 `sched-<uuid>-<slotMs>-skip`。

### 13.5 Orphan sweep 規則（live 修正）

- **真 BullMQ 會把每個 enabled 非-once 排程嘅 NEXT fire 實例化成 delayed job**（`repeat:<key>:<slotMs>`）— v1 sweep 當佢地 orphan 每 pass 都刪（live log `orphanJobs:3`，BullMQ 靜默重加）。
- 修正後規則：once = 只准存在「當前 slot 嘅確定性 job」；非-once = **future job 永唔碰**（BullMQ 自己管），只刪 past-slot 殘骸（crash leftover）；無 enabled owner = 真 orphan。

### 13.6 Overlap policy 語義

- `skip_if_running`（預設）：slot fire 時排程有 active run → 建 **terminal `skipped` run**（`createSkippedRun`，`input_json.skipped.activeRunId` 實指嗰個 active run，slot 照消費唔重試）— 跳過有審計、lineage 可查。
- `queue`：照建新 run（run 之間並行執行）。**`concurrency_key` 係 schema 欄但 P0–P3 冇任何執行邏輯**（grep 實證零引用）— 「queue = 串行」唔成立；若要 per-key 串行係 P5+ 範圍，ADR 此處記錄避免誤解。

### 13.7 每排程獨立 timezone

- `next_run_at` 用排程自己 IANA tz 計算（cron-parser 實算，shared `nextCronRun`），預設 `Asia/Taipei`；tz 入 `upsertJobScheduler` repeatOpts（BullMQ 按同一 tz 排下次 fire — 兩邊一致）。
- `interval` 嘅 next = fired slot + `intervalMs`（BullMQ 內部同算法）— DB 同 index 行進同步，crash 分歧由 fire handler 嘅 stale-slot 容忍窗 + reconciler 兜底。

### 13.8 一致性失敗路徑（live 實錚修正 ×2）

- **ioredis offline queue hang**：redis down 時，已連線 client 嘅命令唔會即時 reject — 進入 offline queue 等一個永唔嚟嘅 reconnect（live 實錚：`POST /schedules` hang 咗幾分鐘）。修正：sync 步加 fail-fast timeout（`SCHEDULE_SYNC_TIMEOUT_MS`，預設 10s）→ 超時即 `sync_error`（誠實 + 即時；PG row 照存，reconciler 兜底）。
- **/health 一嚙死**：BullMQ 6 `ready` 事件 **只發一次**（one-shot `waitUntilReady`；6.3.15 無 disabled/enabled 事件 — 實查 dist 源碼）。redis 中斷後 backend 自動復原、job 照常流，但 P3 嘅 `bindQueueState` 會永遠停喺 `error`（live：/health 503 + docker unhealthy 10+ 分鐘，log 顯示 job 照 complete）。修正：degraded 時每 15s 一次真 redis round-trip probe（`getJobCounts`），healthy 時零 load。
- worker 存活鐵律照舊：ioredis `on('error')`（P3 既有）— redis 全停時 worker 照 healthy 存活（live 驗證）。

### 13.9 RBAC（P4 端點）

| 端點 | viewer | operator | admin | service token |
|------|:---:|:---:|:---:|:---:|
| GET schedules / :id / preview / task definitions | 200 | 200 | 200 | 403 |
| POST/PATCH/DELETE schedules、pause/resume/run-now/sync | 403 | 200 | 200 | 403 |

（mirror P3 task-resource 模式：寫入 operator+；service token 唔入排程路徑 — 排程係 operator 意圖，AI 唔可自建排程。）

### 13.10 BullMQ 6.3.15 形狀收錄（實查 node_modules + live）

- `getJobSchedulers()` entry = `{ key, name, pattern?, every?, tz?, limit?, template: { data, opts } }` — **冇 `id` 欄**（key 先係身份）、`name` 喺 top-level（唔喺 template 內）。
- Job Scheduler fire job：name = scheduler 嘅 template name、id = `repeat:<key>:<nextMillis>`、data = template.data。
- custom jobId 重複 `add` → `JobExistsError`（once heal 要 catch）。
- Job id 唔得含 `:`（custom）— 但 scheduler 內部 `repeat:` job 唔經 `queue.add`，唔受限。

### 13.11 Live 驗收證據（2026-10-15，compose stack，mock provider）

| 硬驗收 | 證據 |
|--------|------|
| 1. cron 1 分鐘 2 次 fire | `tmp-p4-live/evidence/a3-cron-runs.txt`（2 個 `sched-<uuid>-<slot>` run，`next_run_at` 逐分鐘推進）+ worker log `schedule slot fired`（jobId `repeat:sched-...`） |
| 2. interval + pause | `a4-interval-paused.txt`（4 fires → pause → 35s 靜音 4→4） |
| 3. 重啟 reconcile 零重複 | `c1/c2-after-restart-index.json`（2 輪 restart：index=3=DB enabled non-once，`dup=0`，keys 同 baseline；boot pass 完全 no-op log） |
| 4. skip_if_running + queue | `b2-skip-runs.txt`（skipped 行 activeRunId 實指、零 orphan、零重複 slot）+ `b3-queue-runs.txt`（6 slots → 6 runs、0 skipped） |
| 5. sync_error → retry | `d1/d2/d3-*`（redis down：201+sync_error 10s 內返回、worker 照 healthy、/sync=503；redis up：/sync=200 synced、BullMQ key 存在） |
| 6. run-now | `a2-run-now.json`（202 fresh + 200 replay 同 run id；key 唔撞 auto-fire key） |
| 7. 全套綠 + secret scan + 無 socket | 343 tests（341 pass + 1 gated-skip）、secret scan 88d3248..HEAD 乾淨、worker `user=node` 零 mount、api socket read-only |

（證據檔喺 `~/.openclaw/workspace/tmp-p4-live/evidence/` — scratch 目錄，交付時隨 progress log 引用。）

### 13.12 Live catch 修正記錄（fakes 睇唔到嘅 5 個 bug → commit 4d70511）

1. fire slot 唔喺 data/opts — 喺 job id（§13.4）。
2. `requested_by` 係 `@db.Uuid` — SYSTEM caller 唔可用 `'system'` 字串（用 P3 `SERVICE_USER_ID`）。
3. 漂移判斷 `undefined !== null` 假陽（§13.2）。
4. sweep 誤刪 live next-fire job（§13.5）。
5. /health 一嚙死 + sync hang（§13.8）。

教訓：**fake queue 必須逐項對齊真 BullMQ 形狀**（P4 已補：next-fire 實例化、`:jobId` 驗證、template 形狀）— 但「形狀」之外嘅**行為**（offline queue、one-shot ready）仍只能靠 live 實錚 → 每個 phase 收尾必做 redis down/up + restart 實測。

## 14. P5 架構決定（Redroid Devices，2026-10-15 — 全部經 live 實測驗證）

P5 = 受控 Redroid Android 設備層：template 受控建立、localhost-only ADB、白名單診斷、
GPU 誠實語義、per-device 持久化。本機（無 binder_linux/ashmem_linux）起唔到真 Redroid，
故 P5 驗證 = **mock 主路徑 + 真 preflight 對本機實測**（MD 允許；真機 Redroid 列 = 未完成，§14.7）。

### 14.1 參數位置（MD §2.1 硬規則）— `androidboot.*` = 容器啟動參數，唔係 Env

- `androidboot.redroid_width/height/dpi/fps/gpu_mode` 全部作為容器 **Cmd 啟動參數**
  （redroid-doc 官方方式）傳入；**`Env: []` 明確空**。
- 理由：redroid 映像嘅 init 由 kernel cmdline 讀 `androidboot.*`；塞 Env 要 redroid 內部
  有 readenv 邏輯先生效（版本敏感、無文件保證）。啟動參數 = 映像層級保證。
- `ro.xxx` property override 屬「實測先可用」範圍 — **MVP 唔用**（MD §2.1）。
- 實測證據：mock dockerode 記錄到嘅 create call，`Config.Cmd` 含 5 個 androidboot 參數、
  `Config.Env === []`（`tests/integration/redroid-lifecycle.test.js` 斷言）。

### 14.2 ADB 只綁 127.0.0.1（MD §1.2 硬規則）

- 容器 5555（redroid 映像固定）publish 到 host，**HostIP 係 server-side 常數
  `REDROID_LOOPBACK_BIND = '127.0.0.1'`** — 創建 route schema 根本冇 bind/HostConfig
  欄位（additionalProperties: false），client 連「試」都試唔到（實測 0.0.0.0 / privileged /
  hostConfig 注入全 400）。
- ADB port（15000 起）由 server 分配：DB unique 約束 + **真 127.0.0.1 bind probe**
  （`checkPortAvailable`）+ 碰撞重試 + 用盡 503（實測 collision → next port）。
- 診斷引擎 target 校驗：`^127\.0\.0\.1:([0-9]{1,5})$` + 1..65535 — localhost/::1/0.0.0.0/
  公網/注入全拒（unit 14 case）。

### 14.3 診斷白名單（MD §1.2/§7 硬規則）— 零任意 shell

- 引擎（`services/adb-whitelist.js`）係平台同 ADB 對話嘅**唯一通道**：
  - shell ops 只 3 類：`getprop`（property allowlist 23 個固定 key；無參 full-dump 另 cap）、
    `dumpsys <service>`（service allowlist 15 個）、`logcat`（**server 側永遠加 `-d -t <n>`**，
    n 嚴格整數 ≤ `redroidLogcatTailMax`（5000）— 永遠唔會 stream）。
  - 固定非 shell ops：`connect` / `get-state`（連線診斷用，零 shell）。
  - **固定二進制路徑**（`REDROID_ADB_BINARY`，預設 `/usr/bin/adb`，必須 absolute）、
    **參數陣列 + `execFile`（`shell:true` 物理上唔存在）**、逾時、stdout/stderr byte cap
    （256KB 預設，截斷 = flagged `truncated`）。
  - **冇 `POST /exec` 端點**（實測 404）；op 白名單外（`shell`/`pm list`/…）= 400。
  - 注入 defense-in-depth：target 正則、prop key 正則 + allowlist、service allowlist、
    tail 嚴格整數 — 多層，任何一層都夠拒。
- 輸出口徑（honesty flags）：`truncated`（byte cap 硬截斷）與 `mayHaveMore`（tail window
  未必够 buffer 頭 — 真 adb 無法拉 report，UI 披露而唔係假裝完整）係兩個唔同信號。

### 14.4 GPU 誠實語義（MD §2.4 硬規則）— 設定 ≠ 實測

- `gpuStatus` 狀態機：`unknown | unverified | software | verified`。
  - `host` 模式 = DeviceRequests 設定咗 GPU **→ 初始 `unverified`（未驗證）**。
    **`verified` 只可由 in-device render check 產生 — P5 冇呢個 check，故 P5 永遠唔會
    發 `verified`**（UI/API 雙層：service 唔發、UI badge 原樣顯示）。
  - `swiftshader_indirect` = `software`（設定嘅軟體渲染 — 照實顯示「軟體/降級」）。
  - nvidia-smi 成功 / DeviceRequests 存在 **≠ GPU 正常**（MD 逐字）— preflight 嘅 GPU
    偵測只做 informational（`gpu.verified: false` 固定），kernel zone 顯示 driver 資訊但
    gpuVerification zone 仍 `unverified`。
- 實測證據：mock gpu device 4-zone 診斷 = `unverified` + note；UI badge「未驗證 (unverified)」；
  swiftshader device = `software`。全套 test 斷言 mock 永遠唔發 `verified`。

### 14.5 Preflight（MD §10.1）— 真執行、fail-open with explicit warning

- `GET /api/redroid/preflight`（+ create 前自動跑，結果隨 response 返回）：kernel
  modules（/proc/modules 讀 binder_linux/ashmem_linux）、device nodes、dmesg 相關行（cap）、
  docker 可達性、data root、port。
- 三態誠實：`supported | unsupported | unknown` — 讀唔到（權限/平台）= `unknown`，
  **嚴禁假報**（dmesg EPERM 就話 dmesg 讀唔到 + 用 /proc/modules 判斷）。
- **設計決定（工單要求寫清）：preflight 失敗 = warning，唔係 fail-closed**：
  - create/start 可以照行（template 受控 + mock/managed 路徑），但 response 必帶
    `preflight.warnings` + UI banner 獨立顯示；
  - 4-zone 診斷嘅 kernel zone **獨立顯示**真 preflight 結果（MD §10.1 逐字）；
  - 理由：host 層模組狀態可能喺 runtime 改變（root 後 modprobe）；fail-closed 會令
    「預檢時 absent、之後 load 咗」嘅 host 永遠建唔到 device。誠實顯示 + 用戶決定 = 正確
    分工；假報成功 = 打回（鐵律）。
- 本機實測（真 adapter，生產 stack）：`overall: unsupported`，binder_linux/ashmem_linux
  `absent`、device nodes 全 absent、dmesg EPERM（如實）、data root absent — 見 §14.8。

### 14.6 Mock 驗證邊界（工單 scope 8）

- `REDROID_ADAPTER=mock`（config 層）→ 全套 deterministic mock：dockerode-shaped client
  （recording create call 供斷言）+ canned adb（每 whitelisted argv 固定輸出、記錄
  (binary, argv) 供 zero-shell 斷言）+ mock preflight（**全部帶 `mock: true`**）。
- **配置護欄：`NODE_ENV=production` 時 config 強制 `real`**（mock 永不跑生產 host）—
  compose stack（production）因此天生跑真 adapter + 真 preflight。
- mock 嘅誠實義務：GPU `verified` 永遠 false；preflight 帶 mock 標籤；dmesg/boots 輸出
  明確「mock」。任何 UI 顯示 mock 結果必須可識別（badge/label）— 實測 UI 有
  「⚠ mock preflight — deterministic simulation, not a real host check」。
- **mock 唔覆蓋嘅**（真機未完成，§14.7）：真 redroid 映像 boot、真 kernel module 互動、
  真 adb daemon 行為、GPU render check。

### 14.7 真機 Redroid 未完成清單（MD 要求明列 — 交付誠實項）

本機（kernel 6.8.0-117-generic）**無 binder_linux / ashmem_linux module、無 /dev/binder\* /
/dev/ashmem**（CEO 實核 + P5 preflight 實測），故以下列**未完成**，留待有 binder 嘅 host：

1. **真 Redroid 容器 boot**（任何映像）— 本機起唔到（`/dev/binder not found`）。
2. **真 ADB 連通**（真 adb server ↔ 真 redroid 5555）— 依賴 1。
3. **真 logcat / getprop / dumpsys 輸出對接**（白名單引擎本身已 live 驗證 argv/cap/timeout；
   對真機 adb 嘅兼容 = 未驗證）。
4. **GPU 硬渲染驗證**（in-device render check → `verified` 狀態嘅唯一來源）— P5 無此 check，
   故 `verified` 狀態全平台未啟用（by design）。
5. **privileged template 嘅真機必要性**（redroid 官方文檔：部分配置需 privileged + cgroup 調整）
   — 本機無法實測；template 已按 MD 要求建好（`redroid-15-gpu-privileged`，reason 標籤）。
6. **redroid 映像 pull 策略**（pin 死版本 = 有；自動 pull/registry auth = 未建）。

**已完成嘅「真」部分**：真 preflight（本機實測 unsupported，§14.8）、真 port 分配（真
127.0.0.1 probe + 碰撞）、真 docker create 形狀（mock recording + code review 斷言）、
真 DB/audit/RBAC 全路徑（mock adapter 行晒）。

### 14.8 Live 驗收證據（2026-10-15，本機 — 全部實測可重現）

| 硬驗收 | 證據（`docs/p5-evidence/`） |
|--------|------|
| 1. Preflight 真跑本機 | `01-real-preflight.json`（生產 stack 真 adapter：kernel 6.8.0-117-generic、binder_linux/ashmem_linux absent、dmesg EPERM 如實、overall unsupported）+ `02-prod-ui-devices.png`（UI banner 顯示真結果 + 「本機起唔到真 Redroid」解釋，零假「已驗證」） |
| 2. Mock 生命週期 | `03-mock-create-swiftshader.json` / `03b-mock-create-gpu.json`（create→running、adbPort 15000/15001、adbBind 127.0.0.1）+ `05-mock-diag-running.json`（stop→exited→restart→running 全程審計：audit_events 5 類 redroid 動作全入）+ integration 30/30（create/start/stop/restart/delete + 碰撞 + data dir volume 斷言） |
| 3. 127.0.0.1 強制 | create response `adbBind:"127.0.0.1"`（兩 device）+ `04-mock-injection-400.json`（hostConfig 0.0.0.0 / privileged 注入 = 400 additional properties）+ unit/integration 斷言 HostIP 常數 |
| 4. 零任意 shell | `POST /exec` = 404（integration）+ 白名單外 op 400（unit 14 case）+ 注入（`;`/`$(`/反引号）全拒（unit）+ 實測 `04-mock-injection-400.json` |
| 5. 輸出 cap | `06-mock-logcat-cap.json`（tail=999999 → effective 5000 server-side clamp）+ `06b-mock-logcat-default.json`（200）+ byte cap 256KB 截斷 + truncated flagged（integration）+ `07-mock-ui-logcat.png`（UI 顯示 cap 披露） |
| 6. GPU 誠實 | `05b-mock-diag-gpu.json`（host device gpuVerification = **unverified** + MD §2.4 note）+ `02/03` UI badge「未驗證 (unverified)」「software / 降級」+ mock 永遠唔發 verified（test 斷言） |
| 7. 全套綠 + 其餘 | 423 tests（422 pass + 1 gated-skip，0 fail）；tsc：本 repo JS-only（P4  precedent §P4-progress — 等效 gate = `vite build` 綠，304KB bundle）；secret scan（P5 diff）零命中；worker **0 mounts**（無 socket）；api 只 socket ro；P0–P4 已收貨檔案零行為改動（diff：app.js/config.js 純 additive；`fakes.js` + `schedule-service.test.js` = 見 §14.9） |

### 14.9 P4 test-harness 修復（P5 期間發現，product code 零改動 — 披露項）

P4 嘅 `sync guard: HUNG queue fails fast` unit test 喺 **a59f4ee（P4 收貨基線）已
deterministic-cancelled**（worktree 實測 3/3）：fail-fast timer 係 `unref()`（正確 —
timer 唔應該 keep process alive），但 hermetic test 冇其他 event-loop handle → unref'd
timer 獨力撐唔住 loop → node:test 喺 guard fire 前 cancel（「event loop has already
resolved」）。真機 HTTP server 永遠有 socket 住住 loop，故生產行為冇問題。
修法：test 內加 ref'd keep-alive interval（mirror 生產 socket），**零 product code 改動**
（`tests/unit/schedule-service.test.js` +21 行）。修後 24/24 ×3 穩定。
## 15. P6 架構決定（UX 收尾 + 安全 + 測試 + 文檔，2026-10-15 — 全部實測驗證）

### 15.1 flag#1 收結：managed 判定單一事實源（label OR exception）
P3 遗留：`GET /api/containers?managed=true` 只睇 label，但 mutation gate（start/stop/delete）
honors `app_settings` 嘅 admin exception 表 → 已授權但無 label 嘅容器「改到但 list 唔到」。
修法（commit 9383498）：`docker-service` 層 `isManaged()` = label **OR** exception，
`listContainers` + `inspectSummary`（`managedSummary` helper）同用 — service 係唯一事實源，
route 層唔再各自 fetch exception。dashboard summary（§15.5）同規則。**唔加** label 同步寫入
exception（兩軌獨立：label = compose 持久目標，exception = 一次性行政授權，審計可分辨）。
Unit（filter totals 2/1→3/0 flip）+ integration（grant→list/inspect→revoke）全綠。

### 15.2 flag#3 收結：排程通知 = worker 寫、API 只讀
通知行由 **worker**（`schedule-notifier.js`）喺 terminal scheduled run 寫入 — 因為
terminal 語義（succeeded/failed/timed_out/**skipped**）只有 worker 知道（fire handler
overlap-skip 嘅 notification = 該 slot 唯一記錄，MD §12.3「無痕缺跑唔被允許」）。
API（`/api/schedule-notifications`）只做 list/unread-count/read/mark-read。
**RBAC**：讀 = viewer+（通知內容唔係敏感 — run 標題 + 狀態）；**mark-read = operator+**
（`is_read` flip 係寫操作 — 嚴格 viewer=read-only 矩陣）。failure non-fatal（通知寫失敗
唔 block run 終態，log + 審計缺行可查）。UI = topbar bell 30s 靜默 poll（便宜、唔加 SSE 面）。

### 15.3 flag#4 收結：flaky test 根因 = wall-clock drift（唔係 race）
`schedules-api 'list: …(delay computed)'` 斷言 `delayMs === 4200`，slot 相対 `Date.now()`
設 → delay = createdAt − slot 會加多 runNow→update 之間嘅 wall-clock drift，跨 ms boundary
即紅（實測 1/4 runs）。**修法 = 斷言改 deterministic**：slot anchor 喺 run 自己 `createdAt`
（恰 4200，零 drift）。修後連跑 3×450 tests 全綠。**結論**：hermetic 斷言唔可以含
wall-clock 差值；要「精確 X ms」就得自同一 timestamp 算。

### 15.4 flag#5 收結：concurrency_key = bounded defer → 可視化 skip（唔係無期限鎖）
ADR §13.6 話明 MVP 未強制執行 → P6 實裝（唔 defer）：
- **holder 定義**：同 key 嘅 `running`/`needs_approval`（`queued` sibling 唔計 — 兩個 queued
  互相等 = deadlock；`cancel_requested` 唔計 — 快 stop 了）。
- **gate**（engine `gateConcurrency`，startAttempt 前）：holder 存在 → `moveToDelayed(15s)`
  （`TASK_CONCURRENCY_DEFER_MS`）+ 計數；超過 `TASK_CONCURRENCY_MAX_DEFERS=10`（≈2.5min）
  → **可視化 skip**（新 `queued→skipped` 轉換 + `inputJson.skipped{reason,key,activeRunId,policy}`
  + status event + notification bell）— MD §12.3 誠實：唔永久掛、唔雙開、skip 有痕。
- 唔用 DB advisory lock（BullMQ delayed-retry 已提供「鎖會死」：delayed job 冇 TTL 問題 —
  job 永遠存在直到被 pickup；lock 语义 = in-flight holder 查詢，crash 後 holder 自然消失）。
- ad-hoc run（無 definition）/ 無 key 嘅 definition 永遠唔 gate（唔影響既有行為）。
7 hermetic gate scenarios（defer/holder 完=續跑/超 cap skip/queued 唔 block/cancel_requested
唔 block/非 queued no-op/迟到 gate 唔復活 terminal）全綠。

### 15.5 UX 收尾：Dashboard = 單一 real-data 端點 + bell + SSE backoff
- `GET /api/dashboard/summary`（viewer+）：全部 dashboard 數字（fleet 計數 = 同 list/gate 同一
  label-OR-exception 規則 / active + 24h task windows + 5 recent failures / schedules / unread）
  一個端點 — **零硬編碼**（MD §6.1）。Docker down = 200 + `{available:false}` 降級（唔 500 —
  同 health/ready 語義）。
- 深鏈修正（E2E 捉到）：`#tasks/:id` → `#/tasks/:id`（hash router 要 leading slash — 舊值
  靜默 fallback 去 dashboard，用戶以為深鏈壞咗其實 router 匹配唔到）。
- SSE backoff：`useTaskEvents` cursor-reopen 冇 backoff → downed server 時 bypass 咗
  EventSource 原生 3s retry 變緊密循環 → 3s bounded backoff + `reconnecting` 顯示。
- `useApi` enabled flip 第一幀 bug（bell 首開 = uncaught TypeError → 全 app 白屏）：
  `enabled && data===null && !error` 時 `loading=true`（pending 派生）— P6 最大單點修復
  （冇 error boundary 前，任何 uncaught render error = 白屏；P6 修根因，error boundary
  入已知限制）。

### 15.6 E2E harness：system Chrome + 冪等 fixture + 真 worker
- 無 Playwright 瀏覽器 build（host 限制）→ `channel: 'chrome'`（system Chrome 13x）—
  可重現性：e2e 要喺有 Chrome 嘅 host 行（runbook/CI 註明）。
- Fixture（`e2e/seed-e2e.mjs`）冪等：3 users（argon2id, `E2ePass12345`）+ provider **`mock`**
  name row（fire-handler join 需要；worker resolver 特判 'mock' = built-in，永不撥出）+ 固定
  UUID task definition。**教訓**（入測試紀律）：e2e provider 名會經 fire path join 真
  provider_configs — 名唔對 = PROVIDER_NOT_CONFIGURED 假紅。
- 14 步全流程（`e2e/p6-e2e.mjs`）：login → dashboard 實計數器（flag#2 live 驗證：
  fleet ≥3 running）→ containers → detail + **SSE pill=live** → UI 建 run → **live worker 行到
  succeeded** → interval schedule → run-now → **該 run 自己嘅 notification row**（flag#3 e2e）
  → bell 深鏈 → viewer RBAC（403 + 無 form）→ logout。截圖 ×13 + summary.json（console 計數
  whitelist）。**E2E 捉到 5 個真 UI bug**（§15.5 + interval input step 值 — 所有整千 ms
  `stepMismatch` → 瀏覽器靜默 block submit，headless 零提示）。

### 15.7 安全收結：scrub-on-read + service token redact + audit 清零
- **Approval scrub-on-read**（`publicApproval`）：寫路徑（createApproval/recordEvent）早已
  scrub；P6 補讀路徑（同審計 API 同一姿勢）— 就算 legacy import / 手動 SQL 寫入未清理行，
  API 都唔會洩。Live 實打：raw-insert 含 `api_key`/`Authorization` 嘅 pending approval →
  API 回 `***redacted***` 零明文（`e2e/secret-redaction-e2e.mjs` B1–B3）。
- **Service token redact**（threat-model T7）：`req.headers.x-wa-service-token` 入
  `PINO_REDACT_PATHS`（defense-in-depth — 今天無 code path log 整個 headers，但未來任何
  序列化都唔會洩）+ 回歸測試。
- **npm audit 清零**（api/worker/web = 0）：prisma 7.10.0（最新 7.x）transitive 4 high
  （deepmerge-ts <8 堆疊耗盡；mysql2 <=3.23.0 auth-downgrade + zlib bomb）。上游無 in-line
  fix → **root overrides**（`deepmerge-ts ^8.0.2`、`mysql2 ^3.24.6`）。驗證鏈：prisma
  validate+generate（config-load = deepmerge path 真行過）+ 全測 465/464 + vite build +
  `npm ci --dry-run`（Docker build 用新 lockfile 唔會 fail）。
  **實曝面評估**：兩庫都係 prisma CLI（build/ops tool）transitive、PG 項目 mysql2 code path
  唔會行、deepmerge 輸入 = 本地 config 文件 — 即使未修都係低實曝面；但 overrides 係一線
  修復，做咗就唔好留已知限制。
- **Secret redaction 17/17**（`docs/evidence/p6-security/secret-redaction.json`）：provider key
  全路徑（create → GET 零 key 材料只 `hasApiKey` → DB `v1:` AES-256-GCM 無明文 → audit
  details 零 key）+ approval 讀 gate + audit spot-check（actor + action 齊、零 key）。

### 15.8 驗收方法學（P6 定下嘅鐵律，後續 project 沿用）
1. **宣稱 = 證據**：每個安全/功能宣稱要有可重現證據檔（JSON/log/截圖）入 `docs/evidence/`。
2. **Clean install 先收貨**：README 必須過一次 `down -v` → 由零起 → 全 healthy → 首 admin
   → 登入 200 嘅實跑（證據：`docs/evidence/p6-cleaninstall/`）— 因為 dev 環境嘅「能行」
   永遠唔等於新環境能行（volume 殘留/手動 DB 改動/env 漂移）。
3. **零 skip 假綠**：hermetic suite 嘅 gated skip（real-redis test）要 **實跑一次** 對住真
   redis 驗證（`SCHEDULES_REDIS_URL` disposable container）先可以當「覆蓋到」— skip
   唔好當覆蓋。
4. **E2E 一定要走真 worker**（唔係純 API）：5 個真 UI bug 全部係「API 綠但 UI 紅」嘅形狀 —
   真 headless 瀏覽器 + 真后台 worker 先捉到。
5. **gen 交接**（P6 實際經歷：gen1 死喺 threat-model 編集中）：接手第一步 = 核舊 session
   mtime（防鬼活）→ `git status` → 全測 → commit WIP → **push**（relay 保命：未 push = 冇）
   → 先繼續新工作。

## 16. 網絡修復鏈（R0–R6，2026-10-19/21）架構決定 — 全部有 test/live 證據

> 施工 MD = `water_army_repair_*.md`（P0 Phases 0–6）。逐 phase 證據：
> `docs/audits/repair-baseline.md`（R0）/ `tcp-transport-investigation.md`（R2）/
> `fail-closed-validation.md`（R3/R4）/ `redroid-host-validation.md`（R5）/
> `r4-state-sources.md`（R4 狀態盤點）。

### 16.1 健康狀態單一權威 = `Device.netState`（7 狀態機）
`STOPPED/STARTING/VERIFYING/HEALTHY/DEGRADED/BLOCKED/FAILED`（`redroid-health.js`
pure state machine）。**HEALTHY 唯一入口 = VERIFYING + fresh 雙向 TCP canary
PASS 證據**（`isCanaryPassEvidence` 結構校驗 — 無證據 = 轉移拒 = no blind
HEALTHY）。process alive / DNS OK 單獨唔夠（hermetic §6.4-1/2 實錚）；stale
（> `REDROID_HEALTH_STALE_MS` 60s）按不健康處理。Legacy `proxy.state` 降級為
**derived 投影**（保守映射、唔做輸入）— 根因：R0 盤點發現多邊界各自判斷
（API/worker/UI/DB）= 假 HEALTHY 結構性來源。審計：每次轉移落 audit row
（前/新狀態、原因、時間、source watchdog|manual|provision）。

### 16.2 Watchdog + fail-closed 紀律（唔係「重試到成功」）
獨立 sweep（`REDROID_HEALTH_POLL_MS` 30s）查 control plane（container/process/
tun0/table-100/rule-5000/effective route）+ data plane（nonce+sha256 雙向
canary）。definite protection loss（process dead / interface missing / route
loss / proxy leg dead）= **立即 BLOCKED**（唔候 threshold）；soft fail =
consecutiveFailures → DEGRADED(1) → BLOCKED(`REDROID_CANARY_FAIL_THRESHOLD` 2)。
Recovery 紀律：**DB lease 單飛 lock**（跨 crash，contention = WAIT 唔係第二
recovery）+ **persisted backoff anchor**（每個 attempt 含 #1 都等過錨 — 唔 spin）
+ 每 episode `REDROID_RECOVERY_MAX_RETRIES` 3 次 → 超限 **FAILED +
manualIntervention**（manual door `POST /proxy/retry`）。stall signature
（process alive + canary dead = R2 形狀）= 小預算（1 次 re-provision 即 manual —
R2 實錚 re-provision 對佢無效）。恢復後**必須重走 VERIFYING + 全套 canary**
（transition table 無 BLOCKED→HEALTHY 直達邊）。Live 實錚：kill -9 → BLOCKED
+2s；9 episodes 全部 exactly-one attempt（`fail-closed-validation.md` §2）。

### 16.3 Binary 可重現性契約（tun2socks）
Single source = `docker/redroid-matrix/tun2socks.env`（VERSION + inner-binary
SHA256；URL derived — floating `latest` 結構性唔可能；fetch script 拒
`latest` URL）。sha256/arch 唔符 = **build fail-fast**。`redroid-service.js`
嘅 `TUN2SOCKS_PIN` 同 env 檔由 `redroid-t2s-pin.test.js` 靜態掃描鎖同步
（drift = test 爆）。**CI 每次 push 真重建 image + smoke-assert 兩個落點
（canonical `/data/local/tmp/tun2socks` + fallback `/usr/local/bin/tun2socks`）
sha256 == pin**（R7 CI `images-redroid` job）。

### 16.4 gost pin 修復（R3 live 發現嘅 production bug — a34baad）
Stage B（ffe800f）起 **所有 provisioned gost 容器 ~73ms 內 Exited(1)**：
pin 咗嘅 `gogost/gost` image ENTRYPOINT = `["/bin/gost"]`，舊 Cmd 多咗
`start` arg → gost CLI 當 config filename 解析 → `fatal: Config File "gost"
Not Found`。**mock E2E 喺 docker 層 mock 咗所以冇捉到** — 教訓：pin 第三方
image 要 pin ENTRYPOINT 契約（fixture pin test 已加）；「mock 綠」唔等於
「runtime 綠」。

### 16.5 Boot-timeout 校準（2400s）+ poll knob wiring（R7）
R5 live：真 fresh cold boot **~24 min**（23:17:24 → 23:41 boot_completed=1；
R6 記錄範圍 14–20 min + margin）；RECREATE ≈ cold boot。舊 default 600s 會
hard-fail 健康但慢嘅 boot（R3 live 實錚事故）→ `REDROID_TUNNEL_BOOT_TIMEOUT_MS`
default 校準 **2400s**（40 min = 2× 最差實測）。R7（handoff #1）：
`REDROID_TUNNEL_POLL_MS` 同類 unmapped-knob 缺陷（service 讀
`config?.redroidTunnelPollMs ?? 5000` 但 config.js 冇 map）→ **wire 晒**
（default 5000 行為一致 + optInt fail-fast + test）。

### 16.6 TCP data-plane 定位（誠實邊界 — 唔吹、唔瞞）
R2 spike 拓撲（t2s 第一跳 = **裸** mock relay）：SYN 過、payload 唔過，14+
flows 可重現（`docs/audits/r2-evidence/`）。R3/R4 live（**產品拓撲** = t2s →
**per-device gost 容器** → upstream）：雙向 TCP canary（nonce+sha256）**PASS**
（~1s）— spike stall 喺產品鏈**未重現**。機制裁定 **open**（R2 §8 restapi
instrument 未做；host runtime = runc 唔改 t2s **內嵌** gVisor netstack 事實 —
R3「mechanism-level wrong」口徑已被 R7 addendum 修正）。產品**唔存在**裸
第一跳配置（gost 永遠第一跳）→ 現行 fleet 無影響；引入非 gost 第一跳 =
必須重跑 R2 矩陣。常規防線 = 30s watchdog canary（任何回歸 → DEGRADED/
BLOCKED — 唔會假 HEALTHY）。

### 16.7 模板 PATCH 唔可以 clobber absent 字段（AJV default 陷阱）+ 資源限制
Live 事故（R5）：partial `PUT /api/redroid/templates/:id`（例 `{fps:60}`）靜默
reset `gpuMode→swiftshader_indirect` + `privileged→false`（AJV create-schema
default 套到 absent PATCH field + service merge 寫入）→ recreate 後
`Privileged=false` → binderfs mount 126。修復：`TEMPLATE_PATCH_BODY` strip
`default`（absent 保持 absent）+ regression lock
（`redroid-resource-limits.test.js`）。同 phase：`RedroidTemplate.cpuLimit /
memoryLimitBytes`（nullable = 無限；migration `20261020235900` additive）+
live `docker inspect` 實錚（Memory/NanoCpus/DeviceRequests）。

### 16.8 adbd recreate-stall：decide-and-document（R6 決定、R7 入文檔）
delete+recreate 後 framework 完全 boot 但 adbd 停答 host protocol（recreate
特有；stop/start 唔中招；產品診斷 honest：`running + adbState=offline`，無假
陽性）。image/內核層 root cause 未定位 → **記錄為已知限制 + 追索方向**
（redroid image adbd auth relay on recreate / binder transport 重掛時序），
唔喺修復鏈範圍定位到；backlog 另開單（`redroid-host-validation.md` §5）。

## 17. R7 架構決定（2026-10-21 — CI、release gate、decide-and-defer）

### 17.1 GitHub Actions CI 採用（repo 之前無 CI — MD §9.2）
5 jobs 全綠先算綠：test（`npm ci` lockfile 一致安裝 + 全 hermetic suite
Node 24 + compose config validation）/ web-build（vite prod + artifact）/
images-app（api+web+worker docker build）/ images-redroid（R1 pin 每次 push
真驗）/ secrets（gitleaks 全 history + tracked-.env check）。**誠實邊界**：
真 Redroid/GPU + Playwright E2E 唔可以喺 GitHub-hosted runner（runc VM，無
binder/GPU/live stack）跑 — workflow 明文標記，CI 綠**唔包含**呢兩項；佢哋嘅
證據 = `docs/live-evidence/`（manual，本 host）。lint/typecheck = N/A by
design（plain ESM JS，無 eslint/biome/TS）；static guard 喺 suite 內
（patch-default-guard、t2s-pin）。

### 17.2 Real-redis test 喺 CI 真跑（skip 唔好當覆蓋 — ADR §15.8 rule 3 升級）
`SCHEDULES_REDIS_URL` 設咗 job-level service（redis:7.4.5）→ gated test
喺 CI **真跑**（627/627/0/0 — 零 skip）。hermetic-only 嘅 1 skip 只存在於
無 redis 嘅本地 quick run；CI 永遠跑真。

### 17.3 Hermetic config test 規則（第一次 CI run 捉到嘅 latent 缺陷）
`loadConfig(env)` 會 merge `process.env` **並且** load `CWD/.env` — dev host
repo root 嘅 untracked operator `.env`（真 DATABASE_URL/REDIS_URL）會**靜態
mask** 任何 env 隔離缺陷（R6 嘅 config test 喺 clean checkout 全紅）。規則：
config test 一律行 `cfg()` helper（pinned fake secrets ≥32 char +
`envFile: false`）— 任何機器、任何 shell 環境都 deterministic。

### 17.4 Kernel 層 fail-open 殘留：decide-and-defer（唔實裝 iptables 兜底）
平台層 fail-closed 已實錚（16.1/16.2）；殘留 = tunnel 死後 Android app
kernel 層 egress 可經 eth0 直連（routing shadow 消失）。**唔喺 R7 實裝**
netns DROP：Android netd 擁有容器 netns 嘅 iptables 規則（產品級 default-DROP
會同 netd 互踩）+ R2 已實錚容器 iptables build 係阉割版（無 nat 表/
xt_REDIRECT）— 需要獨立 spike（netd 行為實測）+ ADR + 安全評審 = 另開 P0
單。過渡 = **operator 守則**（runbook：BLOCKED/FAILED 期間視設備 egress 為
untrusted；需硬隔離 = host 層 firewall 限 redroid 容器 egress 只過 proxy
leg）+ README K12 文檔化。

### 17.5 Release gate 紀律（MD §9.3 八項）
`docs/audits/release-gate-r7.md`：八項逐項 verdict + 證據引用（只收
PASS/FAIL/BLOCKED；誠實註唔影響判定但要寫出邊界）。release 聲明 = 證據鏈
（4 審計檔 + live-evidence + CI run 連結），唔係自我宣稱。

## 18. BR Batch Rotation 架構決定（B1–B6，2026-10-21/22 — 全部有 test/live 證據）

> 前面 17 節冇 BR 是因為 B1–B5 隨 MD phase 落 main 而 ADR 欠更新（B6 文檔收口補齊，2026-10-22）。以下係 lane 嘅核心決定 + 點喺邊。

### 18.1 PG-first，BullMQ 係 derived index（唔係 source of truth）
排程／run／membership 全部以 PostgreSQL 為準；BullMQ（Redis）只做「邊個 job 應該即刻跑」嘅派工索引。worker boot + 每 5 分鐘 reconciler 由 PG 原地 upsert 對齊 queue（清 orphan、自愈 `sync_status`）。**後果**：Redis 斷 = 派工停（scheduler 唔 blind 派）但狀態零損；Redis 復原 / worker 重啟 = 自動收斂。BR-B6 live 故障注入實測（Redis 15s 中斷：中斷窗口 `attempt_started` 零增加；復原後全收斂，evidence `logs/br-b6-e2e/fault-summary.json`）。

### 18.2 單 run row + attempt 事件 = 唔雙跑嘅結構性保證
每個 (batch, identity) 一列 `task_run`；重試唔開新 row、唔覆蓋 — `task_run_events.attempt_started`（unique per `(runId, attempt)`，DB 層冪等）做 lineage。adopt 語義：worker 重啟後對同一 run 嘅再 dispatch 先 inspect 已存在容器（同 run label）→ adopt 而唔係 create 第二個（S4② hermetic 實測：一 create、一容器、run 完成）。**BR-B6 E2E 硬斷言**：200 identity 全部 `attempt_started` unique、零雙跑零漏單。

### 18.3 Resource lease CAS（port/slot，TTL 8s）
ADB host port 同 container slot 用 `resource_lease` 表 + atomic claim（CAS on `leaseId`）— 冇 distributed lock。TTL 短 = worker 死咗 lease 快到期、reconciler 快收斂。port pool 163xx（batch）與 15000–15999（device，user 保留）hard 隔離。port 池用盡 = 503 `PORT_POOL_EXHAUSTED` = RETRY_WAIT（bounded 指數 backoff），唔係永久失敗。

### 18.4 Rate budget：human lane vs service lane（B6 修復）
MD §13.2 嘅 per-actor 寫 budget（20/60s）係為**人工誤操作**設嘅；worker→API 嘅 service lane（`x-wa-service-token`）**豁免** — 佢嘅真正節流器係 global container cap（`effective = min(batch cap, globalCap)`）。**B6 E2E 發現**：單一 service actor 派 4 個 batch 時搶同一個 20-req budget → 第一波派工 burst 429 → 而 429 當時被 engine 分類為 non-retryable → 首個 429 = FAILED_FINAL = 漏單。**修復**（`16a7e3e`）：①service actor 豁免 write budget（human budget 原封、purge 照要 admin+human）②429 加入 retryable（park RETRY_WAIT 等下 tick）。E2E 重跑後 0 個 429 相關 FAILED_FINAL。

### 18.5 失敗分類：fail-closed + 唔燒重試
- Docker 層任何 error（daemon down / create fail）→ **fail-closed**：冇 op 會被當成功（S4③ hermetic 實測）；container 狀態以 Docker 實查為準，DB 永唔假完成。
- `IMAGE_NOT_FOUND`（404）= **第一次即 FAILED_FINAL**（永久性，重試只會再 404，唔燒）；`PORT_POOL_EXHAUSTED`（503）/ health 中斷（transient）= RETRY_WAIT bounded retry → 達 cap 先 FAILED_FINAL（S4① 實測）。
- 永久失敗**唔偽裝成功**（MD DoD 6）：FAILED_FINAL 帶 `errorCode`，report 匯出照樣出（誠實列失敗）。

### 18.6 Volume retention 三級語義（MD Phase 3 item 4）
`stop`（可逆）/ `remove`（容器走、data 留、冪等）/ `cancel`（best-effort stop）**全部保留 identity data**；**唯一**抹 data 路徑 = `POST /api/identities/:id/purge`（admin + **human** only、service token 拒、`dryRun` 預覽、`confirm` 必須 = identity id 防錯字）。不同 identity 嘅 data 各自獨立 data dir（`<dataRoot>/<identityId>/`）= 結構隔離（E2E P5 斷言）。

### 18.7 Reconcile 三軌 + manual 口
①worker boot 全量對齊 ②每 5 分鐘 scheduler tick ③`POST /api/batch-containers/reconcile`（manual，`fix=true` 先動手）。orphan 定義：無 label 嘅 managed 容器 / stale lease / DB 有 run 無容器。fix 動作（stop+remove orphan、release 死 lease、孤立 run → FAILED_FINAL `ORPHAN_RECLAIMED`）全部有 audit row。

### 18.8 零秘密報告硬門
所有 batch 面向嘅 read surface（identities、monitor、report JSON/CSV）= allow-list 投影 + `scrubObject` + `maskCredentialShapedValues`；report builder 入場 `assertNoSecrets`，任何 credential 形狀漏過 = **500 `REPORT_SECRET_TRIP`**（fail-closed：寧缺毋漏）。E2E/audit 用 admin 帳號（`brb6admin`）行 API，secret 只喺 scratch env file（收工即拆）。

### 18.9 Preview parity（B6 修復）
`POST /api/batches/preview` 與 `POST /api/batches` 必須用同一套 identity 實際 status 做計劃：DISABLED/terminal = plan 時就 SKIPPED 帶 `skipReason`（唔排 doomed run）；unknown id：preview 報告、create 400（strict write）。E2E 實測：4 DISABLED → 4 SKIPPED 帶原因，preview/create 計數一致。

### 18.10 BR-B6 測試層（200-id E2E + 故障注入 + 真機階梯）
- **Sandbox E2E**（`scripts/br-b6-e2e/`，163xx scratch、`br-b6-*` 前綴、ADB-mock image）：200 identities / 4 batches 全 cycle + 重複 create/start、worker SIGKILL、API 重啟、transient/permanent 故障、200 終態 audit。
- **故障注入**（`scripts/br-b6-e2e/fault-driver.mjs`）：Redis 斷 15s / PG 斷 15s / worker kill + Redis 斷（組合）— 斷言 = 每 identity 一個終態 + `attempt_started` 全局 unique + 零殘留容器。Docker daemon 斷 = hermetic only（shared daemon 有 user compose = 紅線；S4③ fail-closed 已實錚）。
- **真機階梯**（`scripts/br-b6lt/`，165xx scratch、`br-b6lt-*` 前綴、pinned digest `matrixa-r3`）：1→5→10→25→50（**絕唔一開始開 50**）；5s VRAM+host sampler（`nvidia-smi`）+ halt monitor（SGLang 30000 共卡 — 任何 GPU free < 1500MiB / SGLang creep / health fail / host RAM-load-disk 超線 → cancel + 縮下一階）；每階段 report → `logs/br-b6-loadtest/`。

## 19. Mobile Console 串流架構決定（MC-1..MC-6，2026-10-23 — Phase 0 PoC 前決策）

### 19.1 候選比較（MD §5.1 全項）

| 項 | 官方 scrcpy（Genymobile/scrcpy） | ws-scrcpy-web（bilbospocketses/ws-scrcpy-web） |
|----|------|------|
| URL | https://github.com/Genymobile/scrcpy | https://github.com/bilbospocketses/ws-scrcpy-web |
| 固定版本 | **v5.0.1**（2026-10-08 release，實測取最新 stable） | main 分支浮動（pushed 2026-10-13）；release 命名 8.x 頻道 — **無可固定之穩定 tag** |
| License | **MIT**（LICENSE 實測） | **GPL-3.0**（repo metadata + README 實測） |
| 授權義務 | 無 copyleft；只須保留 copyright notice | 合併/修改/再散布 = GPL-3.0 传染；即使 internal-only 部署，任何 modification（拆功能/換 auth）都構成衍生作品 → 全倉 compliance 負擔；**且其 admin 面 = 單密碼 + 內建 shell(node-pty)/檔案/命令功能，無法在不修改下安全關閉** → 修改即觸發 GPL，關閉又做不到 = 雙重不可行 |
| Node/ADB/scrcpy-server 要求 | 只需 adb（任意近期版，實測 37.0.1 OK）+ scrcpy-server jar（隨 release 發布，本項目 pin v5.0.1） | Node 20+ + adb + 自帶 scrcpy-server 版本（跟其 release 走，浮動） |
| Redroid ADB 相容 | ADB-over-TCP（`adb -s ip:port`）原生支持；`adb forward tcp:PORT localabstract:scrcpy_xxxxxxxx` 抽象 socket 隧道（v5 架構）— PoC 實測 | 同左（其底層亦用 vanilla scrcpy），但多一層 Node server 抽象 |
| 可否關閉 shell/檔案/APK | **可以** — 官方 client 的 shell/file 功能在 client 端；server jar 本身只有 mirror+control+audio+record 能力，**無 shell 通道**（v5 server 源碼實測：無 shell 處理路徑）；我方 sidecar 只實作 mirror+control 子集 | **不可以安全關閉** — shell/檔案/命令係 core feature（node-pty 直接依賴），須改碼才能關 = 衍生作品 |
| 瀏覽器要求 | H.264 硬解 + WebSocket；**WebCodecs**（Chromium/Firefox 130+）；secure context（127.0.0.1 天然 secure；LAN 須 HTTPS） | 同左（WebCodecs） |
| CVE/更新策略 | Genymobile 官方維護（pushed 2026-10-22）；pin release + sha256；跟版 = 改 pin + ADR 回寫 | 個人維護（stars 69，fork 16）；停更風險高 |
| 健康/清理/觀測 | server 自帶 `cleanup=true`（結束刪 jar）、stderr 可觀測、session 結束自清理 | 有，但隨其 server 架構（黑箱） |

**歷史註**：原 `NetrisTV/ws-scrcpy`（MIT，2.6k stars）已停止維護（Genymobile/scrcpy issue #4533 實測引述）；`coder104/ws-scrcpy*` repo 現為 404。MD 所指「ws-scrcpy-web」= bilbospocketses 現存專案（GPL-3.0）。

### 19.2 決定：MC-1 — scrcpy v5.0.1 server + 自研薄 Node sidecar（`apps/stream`）

- **拒絕 ws-scrcpy-web**（GPL-3.0 + 無法安全拆管理面 + 維護風險）；**拒絕 NetrisTV/ws-scrcpy**（停更）。
- 採用**官方 scrcpy v5.0.1 協議**（MIT），由本項目 Node sidecar 實作 client 端：
  - 版本鎖定：`scrcpy-server-v5.0.1`，**sha256 `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`**（733,930 bytes，release asset 實測）。
  - 協議關鍵（v5.0.1 server 源碼實測，非猜）：
    - 啟動 = `adb -s <serial> shell "CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 5.0.1 scid=<8hex> log_level=INFO video=true video_bit_rate=<n> max_size=<n> max_fps=<n> audio=false control=true tunnel_forward=true"` — **首參 = client 版本字串，server 強制校驗相等**；`scid` 決定抽象 socket 名 `scrcpy_<8hex>`。
    - `tunnel_forward=true` → server 建 `LocalServerSocket`，**按 video→audio→control 順序 accept**；client 用 `adb forward tcp:<p> localabstract:scrcpy_<scid>` 後**按同序**連 `127.0.0.1:<p>`。
    - video socket 流 = `[64B deviceName(zero-padded)][4B codecId BE]([4B sessionFlags(B31=1)+4B w+4B h])*` + 每幀 `[8B ptsAndFlags(B63=config,B61=keyframe) + 4B size BE] + payload`。H264 codecId = `0x68323634`（4B ASCII "h264"）。
    - control socket = 純 control message 流：`1B type + payload`；MVP 只用 0=INJECT_KEYCODE(13B)、1=INJECT_TEXT(4B len+UTF8, ≤300B)、2=INJECT_TOUCH_EVENT(32B)、3=INJECT_SCROLL_EVENT(18B)、4=BACK_OR_SCREEN_ON(1B)、5/6/7/11=面板/rotated(0B)；**明確不實作** 8/9=clipboard、12-14=UHID、16=START_APP、22=SCAN_FILE（安全面縮小；UI 不暴露）。
    - dummy byte（`sendDummyByte=true` 預設）：第一條流首 byte=0，用於快速探測連線死。
- **sidecar 自帶 pinned adb**：platform-tools **37.0.1-15733141**（host 現行版實測；image 內固定 binary + sha256）。sidecar adb 層 = 固定白名單（`connect`/`get-state`/`forward`/`forward --remove`/`push`（只准 scrcpy jar 單檔）/固定 `app_process` 啟動模板）— **無 `shell:true` 任意命令、無用戶可指定參數**（跟 `adb-whitelist.js` 同款紀律；MD §5.2/§11.10）。
- 新增 npm 依賴：**`ws@8.22.0`**（pin 精確版，npm registry 實測 latest；純 JS、MIT、scrcpy 無關的 WS server；API 端與 sidecar 端各用一次）。無其他新增依賴。

### 19.3 決定：MC-2 — 拓撲與 ADB 可達性（audit 發現 1/2 的解法）

`Browser → web(:3012, WS upgrade proxy) → api(:3000, auth/RBAC/lease/ticket) → stream sidecar → adb → device`

- **sidecar = API 用 dockerode spawn 嘅自管容器**（跟 device/gost 容器同一機制，`app.managed=true, app.purpose=mobileconsole-stream`），掛 **devices network**（172.38.200.0/24，API 自管）；**零 docker socket、read-only rootfs、cap_drop ALL、no-new-privileges、非 root、無 port publish**。
- **ADB 可達性**（audit 實測：api image 無 adb；bridge 容器唔到 host loopback）：
  - **production**：sidecar 容器內自帶 adb server（netns-local 5037），直連 **device 容器 IP:5555**（同 devices L2；redroid adbd = tcpip 模式）；`adb forward` 綁 sidecar 自身 loopback。
  - **scratch（host-process API，G1/G2 食譜）**：sidecar = host process，用 host adb server 連 `127.0.0.1:<165xx>`（G2 實證路徑）。
  - 統一：API spawn 時決定 `adbTarget`（`loopback:<port>` 或 `<device-ip>:5555`）傳 sidecar；sidecar **只接受** `127.0.0.1 + 核准 port 範圍` 或 `devices subnet 172.38.200.0/24 + port 5555` — 客戶端永遠唔可以指定 host/port（反 SSRF，MD §5.2）。
- **web 反代補 WS upgrade 透傳**（audit 發現 3）：`apps/web/server.js` 加 `server.on('upgrade')` — 只放 `/api/` 前綴、覆寫 XFF（跟 `proxyApi` 同款防 spoof）、api 端再驗 session/Origin。

### 19.4 決定：MC-3 — stream ticket 與 lease 綁定

- `POST /devices/redroid/:id/streams`（api，operator+ 取 controller / viewer 取 read-only，RBAC 按現行角色）→ 返回 **stream ticket**：`randomBytes(32)` base64url，**TTL 60s、單次使用**，payload 綁 `{userId, deviceId, leaseId, mode, permission}`，HMAC（`STREAM_TICKET_SECRET`，env，唔入 repo/唔入 log）；**ticket 唔入 query string**（WS handshake 用 `Sec-WebSocket-Protocol: ticket.<value>` subprotocol 傳 — 唔經過 access log 嘅 URL 層；api 端 upgrade handler 校驗）。
- 驗完 ticket → api 與 sidecar 之間**換長壽 per-lease WS 通道**（api↔sidecar 用 service token，同 worker 模式）；之後 heartbeat/lease 過期由 server 時間裁定（MD §4.1）。
- 重連 = 新 ticket + 重新驗權（唔恢復過期控制權，MD §2.1.8 / §10）。

### 19.5 決定：MC-4 — 容量與降級

- `MAX_CONCURRENT_DEVICE_STREAMS`：env，**缺省 5、上限 5**；非法值（非整數 / <1 / >5）→ 啟動 fail-safe 落 5 + 明確 log error（MD §4.1）。
- 品質預設：**low**（max_size=720, video_bit_rate=2M, max_fps=15）→ 中（1080/4M/30）可選；5 路 ladder 用 low 預設（MD §4.2）。
- 延遲建立：tile open 先 acquire lease + 啟動 sidecar stream；close = 停影像 + 釋放 slot（冪等）。
- 每路 sidecar stream = 單一 TCP 連線對（video+control 各一），無 fork（Node 單 process 內 async）；sidecar 自身 guard：同時 stream 數 = api lease 計數（sidecar 自身亦硬性 fail-closed 上限 5，雙重保險）。

### 19.6 PoC 實測結果（2026-10-23 02:19Z，P0 收尾）

| # | 項 | 結果 | 證據 |
|---|-----|------|------|
| 1 | redroid A10 (gpuMode:host) H.264 MediaCodec 編碼 | **NOT VERIFIED — 圖像級 blocker（非 code bug）** | 見 §19.9：media HAL 只有 gralloc mapper 2.x，scrcpy 同 screenrecord 零 frame；screencap（繞過 MediaCodec）正常 |
| 2 | WebCodecs 解 H.264（headless Chromium） | **PASS**（環境修正：實測 cache 只有 chromium-**1217**=Chrome 147 / 1208=Chrome 145，**冇 1228** — 原草稿筆誤；且 WebCodecs 只喺真實 origin page 出現，`about:blank` 冇 → E2E 頁面必須走真 http origin） | `browser-evidence.json`: `webcodecs:true, chromeVersion:Chrome/147.0.0.0, configured:true` |
| 3 | 跨 bridge 網絡可達性 | **production 路徑 PASS**：sidecar 容器掛 devices L2 → device IP:5555 = `SAME_L2_OK`；cross-bridge（api net → device IP）= FAIL 屬預期設計（隔離），因為 production 中同 device 通訊嘅係 sidecar（devices L2）而唔係 api 容器 | `probe.txt` |
| 4 | `adb forward` 綁定地址 | **PASS**：`tcp:<port>` forward 由 sidecar 喺 127.0.0.1 loopback 連回成功（video + control 兩條） | sidecar events `forwards_up` + connect 成功 |
| 5 | 5 路 × low 品質 host CPU/GPU 開銷 | 留 Phase 3 ladder 實測（RAM gate live 下） | — |

**browser 級串流（screencap 降級模式）= PASS**：video `decoded=8 codecUsed=screencap-png`、touch `swipeDiffPct=23.83` + device logcat `SHADE_EXPAND_FROM_STATUS_BAR` / `NOTIFICATION_SHADE_EXPAND_COLLAPSE::Expand`（注入 touch 真係打開咗通知欄）+ Home keycode → `KeyguardService setOccluded` 事件。證據：`logs/mobileconsole-poc/browser-evidence.json` + `0{1,2,3}-*.png` + `sidecar-events.jsonl`。

**wire 協議關鍵陷阱（PoC 實測，產品 sidecar 必須處理）：**
- **scid 必須係 int32 範圍（≤ 0x7FFFFFFF）**：server `Options.parse` 用 `Integer.parseInt(scid, 16)`，隨機 8-hex 超範圍 → server 起咗都無 socket → 永久 timeout。生成法：`Math.floor(Math.random()*0x7fffffff).toString(16).padStart(8,'0')`。
- **JVM cold-start race**：`adb forward` 成功 ≠ server 接受連線（JVM 要數秒先 bind `localabstract:scrcpy_<scid>`；之前嘅 connect 會被 adb 接受即斷，~3ms）。sidecar 必須 **connect retry + 首 byte probe（dummy byte）**，對齊上游 client（100×100ms）；本 PoC 用 30s deadline / 250ms interval。video（或 control-only 模式嘅 control）= first socket，收 dummy byte；scrcpy 模式嘅 control = 單次 attempt（防 double-queue 誤接受）。
- **device meta（64B name）落喺 first socket**：video=true 時喺 video 流；`video=false control=true`（control-only）時喺 control 流 — 讀完 dummy byte 後必讀 64B。
- **`cleanup=true` 副作用**：server 正常退出會刪 `/data/local/tmp/scrcpy-server.jar` — 若前一個 server 乾淨收場，下一個 launch 會 `ClassNotFoundException`。sidecar 每 run 重新 push + sha256 校驗 = 冪等（已實裝）；產品 sidecar 建議 `cleanup=false` + 開機 push 一次（减少每 stream 一次 push）。
- **browser WS `binaryType` 必須設 `'arraybuffer'`**：Chromium 預設 `'blob'`，`new Uint8Array(blob)` = 空 buffer → 所有 binary frame 靜默丟失（PoC run #2/#3 假死根因，wsReadyState=1 無 error 無 close，只係 frames=0）。

### 19.7 PoC 範圍（P0 交付）

1 台 disposable 真機（`redroid-brmc-poc`，G2 食譜 720x1280/320/30 + host GPU + privileged + 4GiB，ADB 16500）：
- sidecar PoC script：push jar（sha256 校驗）→ launch（固定模板）→ forward → 讀 video 流（解 frame header，計幀）→ 發 touch/key → 證據。
- **browser 級**：headless Chromium + WebCodecs 頁面解 H.264 畫 canvas + mouse→touch 回傳；截圖 + 點擊前後 frame diff = touch 生效證據。
- probe 容器：跨 bridge 可達性 + adb forward 綁定地址。

### 19.8 實測補充：scid int32 與 connect race（PoC 期間發現，已修）

- 見 §19.6 wire 協議陷阱清單（scid / connect retry / dummy byte / device meta / cleanup / binaryType）。
- 上游對齊：scrcpy v5.0.1 `app/src/main/jni/server.c` client = connect + read-1-byte（dummy）+ 100 attempts × 100ms；`Server.java` accept 順序 video→audio→control；`sendDummyByte` 預設 true；`sendDeviceMeta` 預設 true 且寫入 **first socket**。

### 19.9 redroid image gralloc 限制（產品決策項）

**事實（2026-10-23 實測，`redroid:14.0.0-240527-matrixa-r3`，gpuMode:host，host=RTX A10）**：
- MediaCodec surface-encoder 路徑完全死：scrcpy（`OMX.google.h264.encoder`，setupVideoEncoder succeeded、virtual display 建咗）同 `screenrecord --time-limit 5` 都產出 **零有效 frame**（screenrecord mp4 = ffprobe `Invalid data`）。
- 根因：media HAL process（`media.codec hw/android.hardware.media.omx@1.0-service`）打 `Gralloc4: mapper 4.x is not supported` + `Gralloc3: mapper 3.x is not supported`；`/vendor/lib64/hw/` 只有 `android.hardware.graphics.mapper@2.0-impl-2.1.so`（mapper 3.x/4.x 無 impl）→ encoder 分唔到 input GraphicBuffer。
- 已知上遊問題：redroid-doc issue #427（scrcpy black screen，error signature 相同，closed as not planned）。
- **screencap（SurfaceFlinger 直接 capture → PNG）正常**：720x1280 PNG ~270ms/frame（~2-4fps）。
- 顯示渲染本身正常（launcher 內容完整）— 問題局限喺 encoder buffer 路徑。

**影響與決定**：
- PoC 加 `VIDEO_SOURCE=scrcpy|screencap` 降級開關（MD §4.2「降級」語義）：screencap 模式 = 同一 scrcpy control 協議（`video=false control=true`）+ sidecar 輪詢 `adb exec-out screencap -p` → WS binary（16B `PNGF` header + PNG）。產品 E2E（P2/P3）喺此 image 上必須用 screencap 模式；H.264 真機路徑 = **NOT VERIFIED on this image**。
- **產品決策項（上報 boss）**：(a) redroid image 層修復 media HAL gralloc（等 image 更新 / 另一 gpu_mode / 另一 image 驗證）；(b) 產品保留 screencap 降級模式作 permanent fallback（latency 高，唔係「低延遲」，但可操作）；(c) 兩者都做（推薦）。

### 19.10 P0 交付清單（evidence 根：`/home/kenneth/.openclaw/workspace/logs/mobileconsole-poc/`）

| 交付 | 狀態 | 證據 |
|------|------|------|
| scrcpy race fix（connectWithRetry + BufferedSocket） | PASS | `sidecar-events.jsonl`: `video_retry#1 closed-before-ready → video_connected#2` |
| browser 見畫面（真 device 內容入 canvas） | PASS（screencap 降級模式） | `01-home.png`（launcher 渲染）+ `browser-evidence.json decoded=8` |
| touch 映射證據 | PASS | `swipeDiffPct=23.83` + device logcat `SHADE_EXPAND_FROM_STATUS_BAR` + 14×`INJECT_TOUCH_EVENT` sidecar events |
| key 路徑 | PASS（裝置級） | 2×`INJECT_KEYCODE` + logcat `KeyguardService setOccluded` |
| H.264 真機串流 | **NOT VERIFIED**（image gralloc blocker） | §19.9 + `logcat-gralloc-evidence.txt` + `gralloc-root-cause.md` |
| ADR-019 授權評估 | PASS | §19.1（GPL-3.0 義務分析 → scrcpy MIT 路線） |
| 版本 pin | PASS | scrcpy-server v5.0.1 sha256 `764eb6f7…c536`；platform-tools 37.0.1-15733141；ws@8.22.0（產品）/ PoC 暫用 openclaw ws@8.20.0（已註明）；Chromium 1217(147)/1208(145) |

### 19.11 P1 設計記錄（StreamLease / slot / ticket，2026-10-23）

**資料模型**（migration `20261023024112_mc_stream_leases`，additive-only）：
- `stream_leases`：`id(uuid) device_id user_id mode status version slot_index created_at last_heartbeat_at expires_at closed_at close_reason correlation_id`（MD §4.1 最少欄位全齊）。status FSM = `PENDING → ACTIVE → CLOSED | EXPIRED | INTERRUPTED`。
- **PARTIAL UNIQUE INDEX** `stream_leases_device_active_ux ON (device_id) WHERE status IN ('PENDING','ACTIVE')` — 每裝置同時只可有一條 live lease（MD §4.1「MVP 可更嚴格限制每設備一個 viewer session」之選擇；viewer/controller 共存 = future work）。DB 約束 = 同裝置雙併發嘅真 guard（第二個 inserter = 23505 → `STREAM_DEVICE_HELD` 409）。
- **全局 5 slot = 重用現有 `resource_leases` 表**（`resourceType='stream_slot'`，unique `[resource_type, resource_key]`）— 經 `createLeaseService.acquireSlot()`（shared）原子 claim：`ownerRunId = streamLease.id`（uuid），release = `release({resourceType:'stream_slot', resourceKey:'slot-N', ownerRunId: leaseId})`。零新表、零新約束；`acquireSlot` 加咗 `resourceType` 參數（default `'container_slot'` = 原有 batch 行為零改變，已用現有 1167 個 tests 驗證）。

**原子性論證（MD §4.1「不能先 count 再 insert」）**：
- 全局 cap：N 個併發 acquire → 每個 scan slot-0..4 嘅 `create` 撞 unique constraint → 每 slot key 只有一個 creator 成功 → 恰好 `maxStreams` 贏。
- 每裝置：partial unique index 同理。
- 過期 cleanup（MD §4.1 owner/version 條件）：reconcile sweep 讀 candidate 後用 `updateMany({id, version: candidate.version, status:'ACTIVE', expiresAt: {lt: now}})` — 之間如果有 heartbeat 贏咗（version bump + expiry 延長），CAS 匹配 0 rows → 新 lease 絕唔會被誤刪。
- PENDING 冪等：acquire 中 slot claim 失敗 → compensation（release slot + delete PENDING row）→ 唔會留孤兒。

**MAX_CONCURRENT_DEVICE_STREAMS（MD §4.1 config 規則）**：
- env 缺失 → 5；`1..5` 整數 → 用；`0 / >5 / 非整數 / 垃圾` → **fail-safe 5 + pino.error 明確設定錯誤**（「安全降至 5，不可默默無上限」）。hard cap = 5（除非未來容量審查另做變更）。
- `STREAM_LEASE_TTL_MS`（default 30s）/ `STREAM_RECONCILE_INTERVAL_MS`（default 15s，0=禁用）= 額外 knobs。

**Stream ticket（MD §11.8）**：
- HMAC-SHA256，格式 `base64url(payload).base64url(sig)`；payload = `{v:1, sub(userId), dev(deviceId), lease(leaseId), mode, exp}`；TTL **60s**；`STREAM_TICKET_SECRET`（≥16 字元，env）缺失 → **503 `STREAM_TICKET_UNAVAILABLE` fail-closed**（絕無 guessable fallback）。
- 一次性：Redis `SET mc:stream:ticket:<sha256(ticket)> 1 EX 60 NX`（**Redis = 短期 coordination only**；PG = source of truth）。重放 = 401 `STREAM_TICKET_REPLAYED`。
- 驗證順序（MD §10 stale 防線）：format → HMAC（timing-safe）→ version/exp（**server time**）→ user/device/lease/mode 綁定 → lease 仍 ACTIVE → （consume?）。過期 ticket 一律 401，lease 已 terminal 一律 401。
- ticket 永遠唔入：log（PINO_REDACT_PATHS 已有 token 路徑）、audit details、`GET /device-streams` 回應、lease summary。
- P1 唔設 HTTP 驗證端點（by design：P2 WS upgrade 係 consume point）；P1 E2E 用 `scripts/mobileconsole-p1/ticket-probe.mjs` 喺**真 scratch PG+Redis+同 secret** 下直接行使同一 service function 驗證 binding/replay/TTL。

**錯誤碼（固定，MD §4.1「409/429 擇一」= 選 409）**：
`STREAM_DEVICE_NOT_FOUND` 404 · `STREAM_DEVICE_NOT_RUNNING` 409 · `STREAM_DEVICE_HELD` 409 · `STREAM_CAPACITY_REACHED` 409（message 帶 `n/5`）· `STREAM_PERMISSION_DENIED` 403（controller 需 operator+；viewer mode = 任何已認證角色）· `STREAM_LEASE_NOT_FOUND` 404 · `STREAM_LEASE_OWNER_MISMATCH` 403 · `STREAM_LEASE_EXPIRED` 409 · `STREAM_LEASE_CLOSED` 409 · `STREAM_TICKET_INVALID` 401 · `STREAM_TICKET_REPLAYED` 401 · `STREAM_TICKET_UNAVAILABLE` 503 · `STREAM_INVALID_MODE` 400。

**Reconciliation（MD §10）**：
- **API restart**（`onReady` hook，第一 request 前）：所有 PENDING/ACTIVE → `INTERRUPTED`（closeReason=`api_restart`）+ release slot。P1 無 sidecar 存在 → issuing process 死 = stream 必死；P2 hook：INTERRUPTED 前先查 sidecar liveness registry（可 re-adopt）。
- **Expiry sweep**（setInterval，default 15s，busy-flag 防重疊）：ACTIVE + expiresAt < now → `EXPIRED` + release slot（version CAS）。
- **heartbeat**：owner 或 admin；server time 延長；已過期 lease 唔可 renew（409 `STREAM_LEASE_EXPIRED` — 要重新 acquire = 重新驗權，MD §2.1.8「不得因重連恢復過期控制權」）。
- **close**：owner 或 admin；冪等（terminal 再 close = 200 + `idempotent:true`）；release slot 恰一次。

**路由**（`apps/api/src/routes/device-streams.js`）：
- `POST /api/devices/redroid/:id/streams {mode}` → **201** `{lease, ticket, streamWsPath, usage}`（MD §8.1；ticket 短期受限、無代理憑證、無 upstream URL）
- `GET /api/device-streams` → `{leases:[summary], usage:{active,max}}`（零 secret）
- `POST /api/device-streams/:leaseId/heartbeat` → 200（owner/admin）
- `DELETE /api/device-streams/:leaseId` → 200 idempotent（owner/admin）
- MD §8.1 嘅「control-lease 合併進 stream create」選擇 = `mode: controller`（避免第二套端點）。
- `app.js` wiring：BR-B3 式條件（db 冇 stream surface 嘅 partial test fake → stub 503 `STREAM_LEASE_UNAVAILABLE`，boot 唔崩）。

**E2E 結果**（`scripts/mobileconsole-p1/e2e-p1.sh`，scratch stack 16490/16494/16495，TTL=3s/interval=1s 加速；**run #9 2026-10-23T04:06:51Z = 23/23 PASS, 0 FAIL**，raw：`/home/kenneth/.openclaw/workspace/logs/mobileconsole-p1/p1-summary.json` + `p1-console.log`）：
| Test | MD 對應 | 結果 |
|------|---------|------|
| T07 六併發搶 slot → 恰 5 成、1× 409 `STREAM_CAPACITY_REACHED`(5/5) | §4.1 競爭 | PASS（wins=5 cap_losses=1，usage 5/5） |
| T08 兩 manager 搶最後格（預填 4）→ 恰一成 | §4.1 | PASS（A=201 B=409） |
| T09 同裝置併發雙 acquire → 恰一成 + 409 HELD | §4.1 每裝置單 lease | PASS（A=201 B=409） |
| T12 過期後 heartbeat 409 + sweep → EXPIRED + slot freed | §4.1/§10 | PASS（status=EXPIRED slots=0） |
| T13 ticket binding/wrong-user/replay + T13b TTL 過期 401 | §11.8 | PASS（service-level probe，真 PG+Redis+同 secret） |
| T16 API restart → ACTIVE 變 INTERRUPTED(api_restart) + slot freed | §10 | PASS（status=INTERRUPTED reason=api_restart slots=0） |
| T15 MAX=99 → fail-safe 5 + config error log | §4.1 config | PASS（usage.max=5 + log 有明確設定錯誤） |
| RBAC(T05) / held(T06) / close 冪等(T10) / non-owner 403(T11) / not-running 409(T14a) / unknown 404(T14b/c) / list 無 ticket 洩漏(T03) | §8.1/§15 | PASS |

**E2E 基建陷阱（實測，已修入 script，防下次踩）**：(a) `sg docker -c "psql -c \"…\""` 二次 shell 展開會食 `$`（argon2 hash 被食）→ DB helper 一律 **stdin**（`printf | docker exec -i psql`）；(b) 同 shell background 咗 API 嘅 script，race 測試後嘅 `wait` 必須帶 **explicit pids**（bare `wait` 會等 API 永遠唔 return）；(c) 背景 wrapper 嘅 cmdline 唔好含 script 路徑（pkill bracket trick 防唔到 cross-process self-match）。

**新增依賴**：無（`ws` 仍係 P2 先 pin；ticket 用 node:crypto HMAC + 現有 ioredis）。

## 20. Mobile Console 視頻源降級優先決策（ADR-020，2026-10-23 12:40 — 來源 = 老細批准）

**狀態**：已批准、已實裝（P2/P3 起為常規預設）
**背景**：P0 PoC 證實 pinned redroid image（matrixa-r3, digest 591296d5）media HAL 無 gralloc mapper 3.x/4.x → 所有 MediaCodec surface-encoder（scrcpy H.264 + screenrecord）**零 frame**；screencap（SF 直接 capture）正常（~3-4 FPS / 22.5Mbps 實測，evidence：`logs/mobileconsole-poc/`）。產品層面需要喺 H.264 image 修復之前定咗常規路徑。

**決策（老細 2026-10-23 12:40 批准方案 (a) 降級優先）**：
- `VIDEO_SOURCE=screencap` = **常規預設 + 穩定 fallback**；H.264 只在 redroid 圖象修復並通過驗收後先自動升級。
- 此決策批准降級優先策略，**唔代表 H.264 已修復，唔代表五路串流已通過驗收**（H.264 單路/五路 = NOT VERIFIED，見 P0/P3 報告）。

**8 項 hard requirements 同落地位置**：

| # | 要求 | 落地 |
|---|------|------|
| 1 | `screencap` = 預設 + 穩定 fallback；H.264 未過測試唔可阻塞 P3 | `apps/api/src/config.js` `streamVideoSource` default = `'screencap'`（非法值 throw = 安全降級前拒絕啟動）；P3 ladder 全程用預設 screencap 跑 |
| 2 | P3 五路「穩定」定義 = 5 部正確畫面 + 可接收手動操作 + 連續 5min 無持續黑屏/串流失效；~3-4 FPS 即合格（唔要求流暢視頻） | `scripts/mobileconsole-p3/` ladder 驗收腳本（按此定義斷言：每 tile canvas non-blank + 每 device input 成功 + 5min 窗口 frame gap 上界） |
| 3 | P3 五路並行必須記錄：實際總頻寬、CPU、RAM、FPS、畫面更新延遲、輸入操作成功率；22.5Mbps/路 = 只係測量基準，唔可當固定上限 | ladder 腳本每 10s 採樣 `ss`/`ps`/`/proc/meminfo` + sidecar per-session bytes/frames + browser frame timestamps → `logs/mobileconsole-p3/p3-metrics-5.jsonl` |
| 4 | H.264 圖象修復後：先獨立測試設備驗證（編碼 + 畫面正確 + 無黑屏/損壞 + 觸控鍵盤正常）→ 先入五路 ladder | 未來階段流程（P3 報告 + runbook 記錄此 gate；本期唔實裝 H.264 驗證自動化，因 image 未修復） |
| 5 | H.264 單路 + 五路均通過後先可設預設；auto-upgrade 必須有明確 health check + 成功條件（唔可信映像版本/程序啟動成功） | `STREAM_VIDEO_SOURCE=auto` 保留作未來升級路徑；health check = **收到有效 video frame**（zero-frame 10s 窗口 + stall 15s 窗口 + encoder 崩潰偵測 — `apps/stream-sidecar/src/session.js` watchdog），成功條件 = frame 流持續，**唔係**程序啟動成功 |
| 6 | 降級路徑實裝：H.264 無有效畫面 / encoder 崩潰 / 串流中斷 → 清理失敗串流資源 → 退回 screencap → UI 顯示目前使用模式 + 降級原因 | `session.js`：`auto` 模式下任何 scrcpy 端失敗（zero-frame / encoder crash mid-stream / socket 死亡）→ `_teardownMode()`（kill server + destroy sockets + remove forwards）→ `_run('screencap')` + `degraded` frame 帶 reason；screencap 自身零 frame → kill（diagnosable reason）。UI：`stream-client.js` `stats.degraded/degradeReason` 持久顯示 + `DeviceConsole.jsx` banner + tile「串流模式」行永遠顯示當前 mode + 降級原因 |
| 7 | 向後相容：保留 `VIDEO_SOURCE=scrcpy|screencap`；加 auto 模式 = 同步更新 config 驗證/API/UI/文件/測試，唔破壞既有部署 | config 驗證集 = `auto|scrcpy|screencap`（非法 throw）；`scrcpy` 強制 H.264（無 fallback，失敗 = session dead，符合強制語義）；`screencap` = 直接 screencap（auto-degrade 唔適用）；`auto` = 本 ADR 嘅 try-H.264-then-fallback 行為。API/UI 唔暴露 videoSource 選項（server-side config，避免 client 繞過決策）；單位測試覆蓋三值 + 非法值 |
| 8 | 最終交付：單路 + 五路**原始測試證據**；未實測 = NOT VERIFIED | P2 E2E 證據（`logs/mobileconsole-p2/`：screenshots + browser.out + logcat + summary json）；P3 ladder 證據（`logs/mobileconsole-p3/`）；H.264 單路/五路 = **NOT VERIFIED**（image gralloc blocker 未修）— 最終報告逐項列明 |

**實裝備忘（gen3 審 WIP 時修入嘅 bug — 防下次踩）**：
1. `session.js` kill() re-entrancy guard 原為 session-lifetime（`_killCount`）→ degrade 後嘅新 screencap 路徑死咗都 kill 唔到；改 **per-mode reset**（`_run()` 入面 `_killCount = 0`）。
2. 降級後舊 scrcpy video socket 嘅延遲 close/error 事件會誤殺新 session → 加 **`_modeSeq` generation guard**（stale event no-op）+ `_teardownMode()` 明確 destroy videoSocket。
3. `frames`/`liveSince` 原為 session 累積值 → 零幀偵測會用舊 anchor 誤殺健康嘅新 screencap tier；改 **per-mode `_modeFrames` + per-mode `liveSince`**（summary 仍報 session 累積值）。
4. `cleanup=true`（scrcpy 正常退出刪共享 jar）喺 5 路並行下 = 跨 session jar race → 改 **`cleanup=false`**（每 session start 已 re-push + sha256 verify，冪等）。
5. `stream-gateway.js` 用 `device.adbHost`（Device model 無此欄）→ serial = `undefined:<port>` → 所有 WS 403；serial 改 **由 `127.0.0.1:<adbPort>` 構建**（host 永遠 loopback — audit finding #3；port 必喺 `REDROID_ADB_RANGE_*` allowlist）。
6. `plugins/stream-sidecar.js` restart loop：`starting` promise 從唔清 → 首次 health fail 後 restart 永不觸發（sidecar 永久 dead）；改 `finally { starting = null }`。
7. `screencap` tier 零幀原本無 watchdog（`lastFrameAt` 永遠 null → stall 分支唔觸發）→ 加 screencap 零幀 kill（`SIDECAR_ZERO_FRAME_MS` 窗口）。

## 21. Mobile Console 人工介入事件系統（ADR-021，2026-10-24 02:xx — 來源 = MD Phase 4）

**狀態**：已實裝、E2E 通過（`scripts/mobileconsole-p4/`，真 API + 真 UI + 真裝置）
**背景**：redroid 裝置跑自動化 workflow 會遇到人機驗證（CAPTCHA / 帳號完整性檢查）、網絡隧道失守、boot 超時、ADB 掉線。MD §0.6 紅線：**系統唔可以靜默卡死、唔可以自動解 CAPTCHA** — 所有 stuck 必須變成**可審計嘅人工介入事件**，等人處理；處理過程（ack/assign/resolve）要留痕。

**決策**：

1. **單一事件模型 + 狀態機**（`ManualIntervention` + `ManualInterventionHistory`，additive-only migration `20261024023000_mc_manual_interventions`）
   - 狀態：`open → acknowledged → in_progress → resolved | dismissed`（`reopen` 只接受 terminal → open，帶 note）。
   - 每個 transition 寫 history（actor + note + from/to）+ `audit_events`（雙軌：事件內 timeline 供 UI、audit 供合規）。
   - 並發 transition 用 Prisma transaction + 狀態預檢（CAS 式）→ 非法 transition 回 409 `INVALID_TRANSITION`。

2. **去重 = `device::category::source` partial unique**（MD §6.3：同一裝置同一類同一來源只有一個 open episode）
   - 重複 signal **唔新建**：`signalCount++` + 更新 lastSignalAt + 寫 `signal` history（防報警風暴；重復訊號仍然入 timeline 做證據）。
   - `source=operator_report` 無裝置時用 `orphan::OTHER::operator_report` key（orphan-safe）。

3. **`blocked_pending_review` disposition（MD §0.6 紅線落地）**
   - 產生路徑（全部受控、無自動解）：`external_verification`（operator/AI 回報 stuck，**永不自動解決**）、`network BLOCKED`（R3 狀態機 canary 連續失敗）、`network FAILED`（隧道失敗，critical）、`boot timeout`、`adb offline`（online→offline 轉換）、`container offline`。
   - **dismiss policy**：`external_verification` 事件 **唔可以被 dismiss**（409 `DISMISS_NOT_ALLOWED`，UI/API 雙層）— 必須經人工 review 後 resolve；其它類可 dismiss（假陽性）。被拒 dismiss 後事件保持 open，badge 唔會假性清掉。

4. **零 secrets（MD §6.2/§13）**：evidence JSON 喺**寫入前**經 `scrub.js` 純函數清洗
   - key-based：password/cookie/token/secret 類 key → `***redacted***`（遞迴、大小寫不敏感）。
   - **value-based（P4 新增）**：任何字串含 `scheme://user:pass@`（URL userinfo）→ 整個值 redact — 防 `proxyUrl` 呢類 key 名規避 key 規則（實測發現嘅真實漏洞，E2E T42 覆核）。
   - 生產 signal 路徑只發 machine code（`REDROID_TUNNEL_BOOT_TIMEOUT` 等）+ 已 scrub 嘅 metadata — 唔帶 proxy URL/screen pixels/鍵盤文字。

5. **RBAC（MD §11.2）**：`viewer` 唯讀（list/detail/count 可，任何 action 403 `FORBIDDEN`）；`operator/admin` 可 create/ack/assign/resolve/dismiss/reopen。assign 預設給請求者（operator 身份），`assigneeUserId` 可覆寫（必須 UUID）。

6. **UI（`/interventions` Needs Attention 頁）**
   - 只顯示 actionable 狀態（open/acknowledged/in_progress）；severity + disposition 排序；blocked_pending_review 頁頂 banner（MD §7.1：被阻塞事件唔會自動恢復）。
   - topbar badge = open count（30s silent poll + 路由切換即 refresh）；裝置詳情頁 banner + 按裝置過濾 deep link。
   - **Open device deep link 重用現有 console lease/slot**（唔開新槽）；slot 5/5 滿時 deep link 位顯示「5/5 已滿 — 先關閉一個畫面」，**唔靜默超分**（MD §7.1）；viewer 跳 console 加 `?mode=viewer`（唯讀串流）。

7. **生產訊號接線（真 path，非 mock）**：`persistNet`（R3 tick → BLOCKED/FAILED）、`refreshDevice`（adb online→offline 轉換，只一次）、boot tunnel timeout、container offline。全部經 `interventionService.recordSignal`（冪等 + scrub + audit）。

**實裝備忘（E2E 實測陷阱 — 防下次踩）**：
1. 重複 signal 會寫 `signal` history row — 斷言 history 時 timeline 係 `created → signal → acknowledge → assign → resolve`（5 行），唔係 4 行。
2. HTTP 錯誤封套係**嵌套** `{error: {code, message, requestId}}` — 測試讀 `.error.code`，唔係 `.code`。
3. E2E 環境 ADB server 會靜默遺失裝置（`adb devices` 清空）→ sidecar `SIDECAR_START_FAILED` → 串流 502。重跑前 `adb connect 127.0.0.1:16500..16504` 先。
4. scratch API 係長駐 process — 改咗 shared code（例如 scrub 新規則）之後**必須重啟 API** 先至載入（run #1 T42 假紅就係呢個原因）。
5. psql `-tA` 輸出帶 trailing newline — `split('\n').length` 斷言要先 `trim()`。

## 22. Mobile Console P5 security hardening（ADR-022，2026-10-24 — 來源 = MD Phase 5）

**狀態**：已實裝、E2E 通過（`scripts/mobileconsole-p5/p5-security.mjs` T50–T61，真 API + 5 真機）
**背景**：P0–P4 交付咗完整串流鏈，但 MD Phase 5 要求補上 security 收口 — 實測審查發現三類 gap。

**決策**：

1. **Rate limit 落點 = route preHandler、RBAC 之後（MD §11.9）**
   - `stream create + reconnect`：per-user **10/min** sliding window；`intervention create`（operator_report 入口）：**30/min/user**。超限 → `429 RATE_LIMITED` + `Retry-After`（秒）。
   - **點解喺 RBAC 之後**：401/403 唔燒 budget — 匿名 flood 由 login 限流 + 全平台 rate limit 處理，呢度只限「已認證用戶嘅資源濫用」；順序反埋會令攻擊者可用假 session 燒埋合法用戶 budget。
   - **System signal 路徑唔經呢條 route**（network/adb/boot/container producer 直接調 `recordSignal`）→ critical 事件永遠唔會被限（MD §15.1）— E2E T58 實測 429 + Retry-After + dedupe 保持（一 dedupe key 一 row、signalCount 聚合）。
   - 實作 = 通用 `createRequestLimiter`（per-key Map + sliding window，純內存、per-process — 與 login 限流同級；多 process 部署時 = per-process budget，本系統單 api process）。

2. **Sidecar inbound DoS guard（盲管嘅代價必須喺邊界收）**
   - API↔sidecar tunnel 係 blind pipe（frame 逐字节轉發）→ 惡意 browser client 可送任意大 frame。sidecar 原用 `ws` 預設 `maxPayload`（100MB）= 每會話 100MB memory spike 面。
   - **WS `maxPayload` = 64KiB**：超額 frame → sidecar close 1009 → API tunnel 隨拆（client 見 1006/1009）；API/sidecar 本身唔崩（E2E T59：100KB frame → tunnel 拆、兩邊 health 照 200、sessions 數回落）。
   - **輸入 token bucket 30/s/session**（burst 30）：超額 = `{t:'input-rejected', code:'STREAM_INPUT_RATE_LIMITED'}` frame（**唔斷流** — 畫面繼續）；E2E T（unit）+ 實測驗證。 adb 命令濫用面被限制喺 30 ops/s/路。

3. **Scrub 補漏：clipboard + screen-capture key（MD §11.4/§13 「不記錄：…剪貼簿…畫面影像」）**
   - 實測發現：`SENSITIVE_KEY` 原本冇 clipboard/screenshot 類 key — intervention evidence（free-form JSON，MD §6.2）可以帶 `{clipboard: <dump>}` / `{screenshot: <base64>}` 直落 DB + API + audit。
   - 補上 `clipboard|screenshot|screencapture|screenimage|screencap`（boundary-aware，過 mask 無害原則）；unit test 覆核（camelCase `screenCapture`、nested、secret 零殘留）。
   - E2E T57 canary 矩陣（4 canaries：鍵盤文字/密碼/proxy URL/剪貼簿）喺 API log（offset-scoped）+ DB row + API 讀返三層零命中；log 零 base64 PNG（`iVBORw0KGgo`）零 >10KB 行。

4. **Security E2E matrix（T50–T61）= P5 驗收本身**
   - unauthorized 矩陣（6 REST + 2 WS raw upgrade）/ viewer RBAC / 跨用戶 lease+ticket 劫持（owner check 喺 ticket 之前）/ Origin fail-closed（missing = 403，唔係放行）/ one-shot ticket 重放 401 / 過期 lease 409 / viewer 協議層 read-only / per-device 409 HELD + free-slot 201 / log-leak canary / rate limit 429 / oversized frame / UI console LIVE 回歸 / 零殘留收尾（usage 0 + run 事件刪除）。
   - 已知邊界：5 機 = 全局 5 slot → 「全局 CAPACITY_REACHED」同「device HELD」喺 E2E 層唔可分辨（全球 cap 由 unit test 覆蓋：`tests/unit/stream-lease.test.js`）。

**實裝位置**：`apps/api/src/security/rate-limit.js`（createRequestLimiter）+ `apps/api/src/app.js`（兩個 limiter 註冊）+ `device-streams.js`/`manual-interventions.js`（preHandler）+ `apps/stream-sidecar/src/server.js`（maxPayload + input bucket）+ `packages/shared/src/scrub.js`（key 規則）+ `tests/{unit,p5-*,integration}` + `scripts/mobileconsole-p5/`。

## 23. Mobile Console NV follow-up（ADR-023，2026-10-24 — 來源 = 老細產品決策 2026-10-24 14:09）

**決定記錄（verbatim 節錄）**：老細 2026-10-24 14:09 —「維持 Screencap 作為預設，不因 H.264 未驗證而阻塞現有功能。NV1 H.264：暫緩（保持 screencap default；H.264 = 未驗證可選模式；只有 screencap 成為明確瓶頸先重評估）。NV2 25/50：暫緩（5 路 = 產品驗收範圍，唔准推斷 25/50 已過）。NV3 人工介入：補一項端到端測試 — 受控測試事件 → 事件產生 → 後端記錄 → 管理頁提示 → **點擊通知開啟正確手機** → 人工處理後狀態更新，全鏈正常；唔好依賴第三方 App 自然觸發作唯一測試方法。NV4 live egress：保持 NOT VERIFIED（未獲准網絡環境前，hermetic 結果唔得當生產出口已過）。NV5 cookie slot 並發：先檢查佢同 H.264 嘅實際程式依賴；除非有證據證明必須依賴 H.264，否則先用 Screencap 跑五路並發測試，確認連線建立、資源租約、權限、釋放均正常。NV6 GPU：暫緩進階逐幀比對，但基本畫面正確性、黑屏檢查、觸控/鍵盤操作測試仍須保留。」目標：最多 5 部手機 Screencap 模式下可靠監看 + 手動操作；唔好擴大工程範圍。

**決定與執行結果**：

1. **NV1 / NV2 / NV4 = 暫緩 / 保持 NOT VERIFIED（照錄決定，唔阻塞現有功能）**
   - H.264 維持未驗證可選模式（sidecar `VIDEO_SOURCE=scrcpy` 開關存在、無真機流量）；screencap 維持預設。
   - 25/50 路唔准推斷已過（5 路 = 單機設計上限 = 產品驗收範圍）。
   - live egress 維持 NOT VERIFIED：未獲准網絡環境前，hermetic 結果唔得當生產出口已過。

2. **NV3 = 已通過（受控全鏈 E2E — gen9 新增 `scripts/mobileconsole-nv/nv3-fullchain.mjs`，NV3-1..8，8/8 PASS ×2 次）**
   - T40–T49 覆蓋審計：狀態機 / dedupe / RBAC / zero-secret 已有；缺口 = 「點擊管理頁通知 → 開啟**正確**裝置 console」全鏈斷言（T45 只驗 deep link 存在，唔斷言開到嘅裝置 = event 裝置）。
   - 本單補齊：受控 `operator_report` 事件（s3）→ 201 + PG row + audit `intervention.created` → topbar badge=1（30s poll）→ 點擊通知 chip → event center row → Open device → console URL = event 裝置 id + header `redroid-brmc-s3 — Mobile Console`（= event 嗰部機）→ LIVE（screencap）+ 唯一 ACTIVE lease 綁 event 裝置（owner=admin）→ 真人 operator ack/assign/resolve(note) → open→resolved + count 0 四面（API/UI badge/row/device banner）+ history [created,acknowledge,assign,resolve] → cleanup 0/5 re-run safe。
   - 證據：`logs/mobileconsole-nv/e2e/nv3-*`（JSON + 截圖）。
   - 自然觸發 intervention 降級為可選項（老細 14:09：唔好依賴自然觸發作唯一測試方法）— 4 條 production signal 寫入函數 unit+integration 已覆蓋（同 operator_report 同一 writer），唔屬驗收必須。

3. **NV5 = 原問題已通過 + 新發現（rate limit × 五路重連風暴）— 見下**
   - **代碼分析（更正 P5 報告「scrcpy 路徑专用」前提）**：cookie slot（stream_ticket cookie）喺**認證層** — `POST /streams`（acquire）同 `POST /reconnect` 都經 gateway ticket 驗證（HMAC + user/device/mode 綁定 + 單用）→ 成功 set-cookie → client 帶 cookie → WS upgrade 時讀 cookie 完成認證；`videoSource`（screencap/scrcpy）喺認證**之後**先分支、只影響 sidecar 取幀循環。兩條路徑**共用同一 cookie slot 機制，與 H.264 無依賴** → 「NV5 跟 NV1 一齊暫緩」前提唔成立，screencap 五路並發測試必須跑（老細 14:09 都指示先跑）。
   - **行為驗證（gen9 新增 `nv5-cookie-slot.mjs`，NV5-1..5，4/5 PASS、NV5-4 = 觀察項）**：
     - NV5-1 五路建立 PASS：0/5→5/5 全 LIVE（screencap），lease inventory owner/mode/device 全對。
     - NV5-2 權限 @5/5 PASS：operator 對 5 個 admin lease 嘅 heartbeat/close/reconnect 全 403 OWNER_MISMATCH；admin control 200；零副作用。
     - NV5-3 單路強殺（client 側 WS kill，行 `_tryReconnect` 真路徑）PASS：victim t+3s 自動 LIVE（1 次 /reconnect = 200）；**其餘 4 路全程 LIVE + 幀數嚴格遞增** — /reconnect 重寫 cookie jar 唔影響已升級嘅其他 tile（cookie 只喺 upgrade 時讀）→ 核心問題「重寫 cookie 會唔會搞親其他 tile」= 行為實證**唔會**。
     - NV5-4 sidecar SIGKILL（5 路同時 — 觀察）：sidecar 2s 自癒（API supervisor 重啟 pid 7663→41536）但自動恢復 = **0/5**；/reconnect 24 次 = 200×4 + **429×20** — P5 rate limit（10/min/user、**固定窗口**、create+reconnect 共享、窗口錨定首個 request）< 5 機 fleet 風暴 legitimate 需求（24 POST/30s）；首個 POST 已 429（RA=48 = 窗口 budget 已被前面 phase 嘅 acquire 消耗）；4 個攞到 200 嘅 ticket 亦冇救到 tile（upgrade race sidecar 復甦 → 單用 ticket 燒咗）→ 5 路 4 次 backoff 全耗盡 → ERROR；人工恢復（close+re-acquire）4/5 成功（各 3s）、第 5 部 92s 後 FAILED（恢復路徑同樣被 429 擋）。
   - **結論**：(a) NV5 原問題（cookie slot 並發）= screencap 路徑無跨 tile 損壞、無 H.264 依賴 → **已通過**（連線建立 / 資源租約 / 權限 / 釋放 = 老細 14:09 指定四項全部實錚）；(b) **新已知限制** = P5 DoS 保護（10/min）同五路重連風暴交互 → sidecar 全倒場景要人工介入、第 5 部機可 ~2min 內恢復失敗 → 修 = limiter 策略變更（reconnect 獨立預算 / 提 cap / ticket upgrade 冪等）= 產品安全行為變更 → **只報告交老細拍板、唔自行改**（老細 14:09：「有真 gap = 報告（修唔修按影響判斷：小修就做 + 回歸，大改產品行為 = 只報告交老細拍板，唔准自行擴大範圍）」）。
   - 證據：`logs/mobileconsole-nv/e2e/nv5-*`（storm 逐 POST timeline = `nv5-4-storm2.json`）。

4. **NV6 = 基本級已通過（suite 內存在、全綠）+ 進階級暫緩**
   - 老細 14:09：「暫緩進階逐幀比對，但基本畫面正確性、黑屏檢查、觸控/鍵盤操作測試仍須保留」— 核對 = **已保留且喺 1276 全綠 suite 內**：
     - **T22**（`p2-browser.mjs:208`）：`live && painted && frames>0`，painted = `canvasPainted`（canvas 非黑像素 sampling）= 基本畫面正確性 + 黑屏檢查；
     - **T24**（:211–226）：controller TAP（status bar → notification shade）+ **裝置側 logcat 證據**（SHADE_EXPAND_FROM_STATUS_BAR）= 觸控；
     - **T25**（:226–241）：controller Home key + **logcat 證據**（Keyguard occlusion）= 鍵盤；
     - 相關：T27（sidecar SIGKILL → RECONNECTING → 新 ticket → LIVE，screencap 重連）、T28（close/release → 0/5）、T23（name/port 顯示）。
   - GPU 逐幀比對（GPU vs 強制 CPU）維持暫緩（低優先、唔影響功能）。

**隨帶修復（測試側、非產品）**：NV 腳本 psql helper 將 `psql -tA` 嘅 DML command tag（`DELETE 0`）誤計做「1 行 affected」→ 每次 pre-clean 假陽性「removed 1 stale row」；曾起 scratch write-trap（AFTER trigger 全 session capture）實證**零外物寫入**（表一直係空）；helper 加 tag filter（commit 85784c8），trap 拆埋（零殘留）。

**順帶更正**：ADR-022 文案寫「sliding window」，實作 = **固定窗口**（bucket `resetAt` 錨定首個 request — `rate-limit.js` `createRequestLimiter`）；風暴分析（窗口被前面 acquire 消耗）以此實作為準。

**狀態**：已通過（NV3 / NV5 原問題 / NV6 基本級）＋ 暫緩（NV1 / NV2 / NV4 / NV6 進階）＋ 已知限制待拍板（NV5 storm × rate limit）。驗收矩陣（四類標記全項）= 最終報告 §11。

---

## 24. Mobile Console stream ticket 冪等化（ADR-024，2026-10-26 — 來源 = 老細拍板 NV5b 選項 (c)，2026-10-26）

**背景（NV5b 實測根因，gen9 證據 — `nv5-4-storm2.json`）**：sidecar 全倒風暴（5 路同時斷）→ 5 tile 並發 `/reconnect` ×24 = 200×4 + 429×20（P5 limiter 10/min/user 固定窗口、create+reconnect 共享）；4 個拿到 200 嘅 ticket 全部中 upgrade race — **one-shot ticket 喺驗證瞬間被重啟中的 sidecar 燒咗**，follow-up 重試全部 `STREAM_TICKET_REPLAYED`；前端 backoff ladder 4 次（~45s）< limiter Retry-After 48s 就放棄 → 自動恢復 **0/5**，人工恢復 4/5（第 5 部被 limiter 擋 92s FAILED）。

**決策（老細 2026-10-26 拍板 (c)，唔改 limiter）**：
1. **ticket 消耗語義：one-shot →「成功 handshake 先消耗」**。WS upgrade 認證鏈（Origin → session → lease 存在 → owner/admin → lease ACTIVE+未過期 → device running → ADB serial 由 DB row 構建 → ticket HMAC+exp+綁(user/device/mode)+未消耗檢查）全部保留；差別 = 驗證通過**唔再即時燒票**，API 喺 sidecar `auth-ok`+`ready` handshake **成功之後**先 `consumeTicket`（Redis `SET NX EX` = consumed marker，TTL = ticket TTL+30s）。升級失敗（503/timeout/握手錯誤）→ ticket 存活 → backoff 重試照用同一張票，唔使再食 limiter budget 換新票。
2. **成功後重放 = 拒絕**：consume 係冪等守門 — 第二條併發/重複 upgrade 喺 consume 位 401 `STREAM_TICKET_REPLAYED` 拆管（並行 duplicate 只有一個贏家存活）。TTL、owner/lease 綁定、close/lease 作廢、簽發/reconnect 流程全部不變；`validateTicket({consume:true})` 保留為 legacy one-shot 模式（向後兼容）。
3. **前端 backoff 遵從 `Retry-After`**：429 有 RA → 直接等 RA+500ms（jitter；cap 90s）、**唔消耗 backoff ladder**；無 RA → 落返現有 ladder。cap = 5 次 RA 等待（最長 ~7.5min）後先 ERROR — 換取「limiter 窗口過咗一定仲試緊」。
4. **limiter 唔改**（10/min/user 固定窗口 create+reconnect 共享 = P5 DoS 語義保留）— 風暴下 429 仍係正確產品行為；本次只令 429 **可等**（RA 跟從）+ 200 **唔會白捱**（票唔會燒）。

**安全代價（記錄於 threat-model T9 殘留 (e)(f)）**：重放窗口由「一次用盡」放寬到「TTL（60s）內未消耗可重放」— 限 owner+lease 綁定、HttpOnly cookie 傳送、並行重試只有一個 consume 贏家；Redis 重啟秒級視窗內剛消耗嘅票可短暫變返 spendable（後果 = 多一條重複流，容量門照常守）。

**驗證**：unit 全語義矩陣（`stream-lease.test.js` — 成功前重用 / 成功後作廢 / TTL 過期 / close 作廢 / 非 owner 403 / 風暴同票重試最終成功 / legacy one-shot / consumed marker store 失聯 fail-closed；`stream-client-reconnect.test.js` — RA 跟從 / 無 RA 落 ladder / RA cap / 並發語義）+ integration（`stream-ticket-idempotent.test.js` — fake sidecar 真實 WS 帧：升級失敗唔燒票、成功先燒、成功後重放 401、並行 duplicate 單一 consume 贏家）。**真機 sidecar 全倒風暴重跑 = 待 RAM 恢復（NOT VERIFIED）** — 宿主 MemAvailable 不足以過 RAM gate 啟動 redroid，本次全部 hermetic（fake adapter）；重跑命令見 progress 檔 NV5b 段。

## 25. W1 identity 級 device fingerprint profile（ADR-025，2026-10-26 — 老細批准開工 2026-10-26；真機 V3 待 RAM）

**背景**：水軍 200 身份而家喺目標平台眼入面指紋全同 — redroid 同一 template 出機，`ro.build.fingerprint` / `ro.product.*` / serial 全部嚟自 image，identity 只反映喺 dataDir / proxy IP 層。同一 model + 同一 build + 同一 serial 嘅 200 部「手機」= 平台側最廉價嘅聚類信號。W1 = identity 級指紋 profile 嘅**生成、存儲、注入、校驗**（代碼段）；**真機實測全部掛起等 RAM（ADR-025 V3 = NOT VERIFIED，見 §待辦）**。

**決策**：
1. **Profile = 確定性生成，seed = identityId**（`packages/shared/src/fingerprint-profile.js`）。splitmix64 over sha256(`wa-w1|<identityId>`) 驅動 pool 揀選 + 唯一碼段。冪等：同一 identityId 重生成 deep-equal（「3× 重建穩定」喺代碼層歸約到呢個性質）；device recreate 重放同一 map。字段：`androidRelease / brand / manufacturer / model / device / productName / buildId / displayId / fingerprint / serial / locale / timezone / carrierName / carrierMcc / carrierMnc`（+ 可選 `securityPatch`）。**唯一性 by construction**：`fingerprint`（32^10 碼段）、`displayId`（32^5）、`serial`（32^4）嵌入 seed 衍生碼段 — UNIQUE_PROFILE_FIELDS = {fingerprint, serial, displayId}；其餘字段（brand/model/carrier）跨身份重複屬真實行為（兩個用户可以擁有同款手機），碰撞器記錄但唔阻擋。android_id **唔納入 profile**：Android 首 boot 自動生成並持久喺 /data（settings secure），而 /data 本身 per-device 持久 — 已天然 identity 穩定，唔重複發明。
2. **存儲 = 新表 `identity_fingerprints`（1:1，additive migration 20261026100000）**，唔放 Identity.metadataJson。理由：(a) fingerprint/serial/displayId 需要 **DB unique 守門**（fleet 級碰撞 = fail-closed 硬約束，JSON blob 辦唔到）；(b) metadataJson 係 operator 自由中繼資料＋scrub 展示路徑，混入結構化安全欄位會糊化邊界；(c) typed 欄位先至支援 `(brand, model)` 分佈查詢。`profileJson` 係單一真相，typed 欄位只服務 unique 守門 + join。metadataJson 保持原職，零改動。
3. **注入路徑 = androidboot Cmd carrier + 開關默認 OFF**。`RedroidTemplate.roOverrides`（JSONB，默認 `{}` = 現行為 byte-identical）承載 template 級靜態基線；device create 帶 `identityId` 且 **WA_REDROID_RO_OVERRIDES_ENABLED=true** 時：ensureProfile（確定性生成 + drift 校驗 + 碰撞預檢）→ merge（template 基線 ← identity profile，profile 贏）→ snapshot 落 `devices.ro_overrides_json` + `devices.identity_id` → `buildRedroidCmd` 追加 `androidboot.wa_<prop>=<value>`（sorted、穩定序）。`wa_` 前綴將我哋嘅 carrier key 同 redroid 原生 `redroid_*` key 隔開（ro.boot.wa_* 唔會撞）。**開關 OFF（默認）= identityId 收得但完全惰性**：唔查 profile、唔寫 row、Cmd byte-identical — V3 未過之前唔准默默改變真機行為。
4. **fail-closed 鏈**（全部 unit/integration 覆蓋）：非法 prop 值（含空格 / `=` / 引號 / 控制字元 — kernel androidboot parser 比 Android 本身更嚴）→ validator 拒絕；template roOverrides 非法 → 寫入 400 / create 500；identity 唔存在 → 404 **先於一切副作用**（no data dir、no DB row、no RAM-gate lease、no docker create）；profile drift（row ≠ 確定性重生成）→ 500 拒絕亂估；碰撞 → 409（預檢 + DB unique P2002 雙層）；merged map 非法 → 500 且 buildRoCmdArgs 永不吐 partial args。
5. **carrier 風險誠實記錄**：`androidboot.wa_*` → `ro.boot.wa_*` 係 kernel 標準行為，但 **redroid init 會唔會將 ro.boot.wa_ro_build_fingerprint 落成 ro.build.fingerprint 係未驗證假設** — ro.product.* 系列（partitions 由 vendor 分區 image 自帶）同 ro.serialno 邊個贏、setprop 兜底路徑（post-boot `setprop` / resetprop 邊個有權限燒 ro.*）全部列入 V3 待辦。locale/timezone/carrier 冇 ro.* carrier（settings/telephony 側，後續 phase）。

**V3 真機待辦清單（逐項 getprop 抽樣矩陣 — RAM 恢復後執行）**：
| # | ro.* prop | 驗證方法 | 通過標準 |
|---|-----------|----------|----------|
| V1 | ro.build.fingerprint | create 帶 profile（開關 ON）→ boot → `adb -s <dev> shell getprop ro.build.fingerprint` | 逐字節等於 profile.fingerprint |
| V2 | ro.product.model / brand / manufacturer / device / name | 同上逐項 getprop（注意 `ro.product.<partition>.*` vs 合成視圖 — `getprop` 與 `adb shell getprop | grep ro.product` 兩款都抽） | 逐項等於 profile（邊個 partition 贏要記錄） |
| V3 | ro.build.id / ro.build.display.id | getprop 抽樣 | 等於 profile |
| V4 | ro.serialno（+ ro.boot.serialno 對照） | getprop；`adb devices -l` 都抽 | ro.serialno = profile.serial |
| V5 | 3× 重建穩定 | 同 identity delete+recreate ×3 → 每輪 getprop 全套 | 三輪逐字節一致 |
| V6 | 平台側盲測 | 2 個唔同 identity 嘅 device 上目標平台，用平台自帶 device-info 面板/日志抽指紋 | 兩機指紋唔同 |
| V7 | carrier fallback | 若 ro.boot.wa_* 唔生效 → 試 post-boot setprop/resetprop 邊個可寫；記錄邊個機制入 ADR 修訂 | 有機制 + 3× 穩定 |
- 抽樣矩陣執行時填入本 ADR（邊項過/邊項唔過 + partition 勝負記錄）；**全部過之前開關必須保持 OFF**。
- RAM gate：V3 執行需要 ≥1 部 redroid 上機（MemAvailable 而家 ~2 GiB < gate）— 掛起係預期狀態，唔係阻塞 bug。

**驗證（代碼段，已做）**：unit `fingerprint-profile.test.js`（12：冪等 / 200+2000 fleet unique 欄位 0 碰撞 / validator 負矩陣 / 碰撞器 blocking vs informational / carrier 編碼 + 穩定序 + never-partial）；integration `redroid-fingerprint.test.js`（6：開關 OFF 惰性（Cmd byte-identical + row unbound + 無 profile lookup）/ ON 注入落 mock createContainer body（Cmd 唔落 Env）+ row snapshot / 3× recreate 逐字節一致 / 404 fail-closed 零副作用 / template 基線寫入校驗 + merge 勝負 + OFF 惰性 / routes 冪等 ensure + RBAC + fleet 碰撞審計 clean）。**真機層 = NOT VERIFIED（V3 待 RAM）** — 本 ADR 所有「生效」描述只指代碼層。

## 26. W2 App 層基礎（ADR-026，2026-10-26 — 來源 = CEO W2 工單）

**背景**：水軍 200 身份需要喺每部 redroid 上面裝目標平台 app、驗證安裝、探測首屏（UI tree）、tap 元素（登入流程 / 轉入主界面）、偵測 activity 變更。W2 = App 層基礎：所有裝置互動**只可經 ADB whitelist engine**（MD §1.2/§7/§10.3 硬規則）— W2 將 whitelist 由「5 個唯讀 op」擴容到「5 個唯讀 + 8 個 app-layer op」。真機矩陣掛起等真機總測試單（見 §待辦）。

**決策**：

1. **ui-tree 模組**（`apps/api/src/services/ui-tree.js`，pure function、零 I/O）：bounded uiautomator XML 解析 — quote-aware `<node ...>` scan（引號入面嘅 `>` 係 data 唔係 tag 結束）、XML entity decode（`&lt; &gt; &amp; &quot; &apos;` + `&#NN;`/`&#xHH;`）、per-node bounds 校驗（integer 對、x2≥x1、y2≥y1）— **壞 bounds 只 skip 嗰個 node**（`stats.skippedMalformed` 誠實計數，唔靜默丟）。三層尺寸 bomb 防禦：`maxBytes` 4 MiB（UIA_DUMP_TOO_LARGE 422）/ `maxNodes` 2000（UIA_DUMP_NODE_LIMIT 422）/ per-attribute `maxTextLen` 512（單個 attribute 巨型亦被 clip）。Selector = AND 語義 + ≥1 條件（空 selector = bug 唔係 feature；unknown field 400）。`pickTapTarget` = **恰好一個** element + integer center；多匹配 = 409 UIA_ELEMENT_AMBIGUOUS（candidates ≤8 + 完整 count，**永唔猜邊個 tap**）；零匹配 = 404 UIA_ELEMENT_NOT_FOUND；element center 出 screen bounds = 422 UIA_ELEMENT_OFFSCREEN（stale dump / rotation race 嘅兜）。錯誤契約七碼全部穩定 API code（422/400/404/409 分層）。

2. **app-service**（`app-service.js`）：每部裝置嘅 app 生命周期 + UI tree 管線。
   - **Host-side APK gate**（managed dir，defense in depth，順序唔可換）：file name RE（flat、safe chars、`.apk` 尾、≤104）→ `realpath` containment **直接喺** managed dir 入面（symlink 指出去 = reject）→ regular file → 0-byte / size cap（WA_APK_MAX_BYTES 512 MiB）→ ZIP magic `PK\x03\x04`。**腐敗 APK 永唔到裝置**（零副作用、no half-install）。**gate 刻意無法解析 APK**（設計決定）：ZIP magic 有效但 body 係垃圾嘅「magic spoof」檔案過 host gate，由裝置自己 `pm install` 裁決（`INSTALL_PARSE_FAILED_NOT_APK` → 502 APK_INSTALL_FAILED + error audit）— 平台**永不 claim 裝咗邊個 package**（response / audit 都無 package 欄；發現路徑只有 packageInfo，裝置係 truth）。**真機實錚（2026-10-27 總測試 run7，A7(d)）**：ZIP magic + 垃圾 body → host gate 按設計通過 → 剛好 1 次 push → 裝置 `pm install` 裁決失敗 → 502 APK_INSTALL_FAILED，`pm list packages` 前後 diff = 0（零安裝、無 partial state）—「裝置 verdict 係仲裁者」真機成立。
   - **裝置 verdict 先係 success**：`pm install/uninstall` 必須見 `Success`（嚴格 word boundary — `Successfully` ≠ Success，unit 已鎖）；exitCode≠0 / 無 verdict / timeout = 502。裝置原子裁決，平台無 half-installed 狀態要 unwind（device tmp file 下次 push 覆蓋；device-rm 唔喺白名單 — 見安全論證 §7）。
   - **Fail-closed 鏈**：switch OFF（默認）= 503 APP_OPS_DISABLED（7 條 route 全擋）；containerState ≠ running = 409 APP_DEVICE_NOT_RUNNING（**零 adb call**）；engine 不可用（exitCode null）= 502 ADB_UNAVAILABLE；uiautomator `could not get idle state`（真實裝置常見失敗）= 502 UIA_DUMP_FAILED 誠實 passthrough；dump read-back 被 truncate = 522 UIA_DUMP_TOO_LARGE（**截斷嘅 tree 唔可 tap、唔可 parse**）。
   - **Login-state 誠實**（§3）：foreground probe = `dumpsys window` `mCurrentFocus`（fallback `mFocusedApp`）→ 只回報 package + activity；`loginState` 欄恆定 `'unknown (activity-level detection only)'` — activity 係咪「已登入」係老細喺真機上定義嘅業務規則，本層永唔給 verdict。
   - **UI 管線**：`ui/dump` = uiautomator dump（fixed 路徑 `/data/local/tmp/wa_ui_dump.xml`，constant，零 user input）→ exec-out cat（raw bytes，**host 端零 shell**）→ bounded parse；`ui/tap` = **同一份 fresh dump** → selector 解析（錯誤契約）→ element center → `input tap`（全程一個 dump，唔會二次 dump 令 tap 同觀察唔一致）。
   - **審計**：每 mutation + dump/tap 都審計（`app.device.*`；detailsJson 零 secrets — 只有 names/paths/coords/counts）。

3. **Routes + RBAC + 開關**（`routes/device-apps.js`）：reads（`GET /apps`、`GET /apps/:package`、`GET /foreground`）= viewer+；mutations（`POST /apps/install`、`DELETE /apps/:package`、`POST /ui/dump`、`POST /ui/tap`）= operator+。Schema 層第一道：route param `package` = Java package shape RE；install body `fileName` = flat safe name RE（traversal 形狀 400 喺 service 之前）；selector = `additionalProperties:false` + `minProperties:1`（空 / 未知字段 400）。開關 `WA_APP_OPS_ENABLED` 默認 OFF — W1 教訓：新行為 ship OFF-by-default，真機 evidence matrix 未過之前唔准默默改變真機行為。

4. **Mock adb 裝置狀態**（`redroid-mock.js` w2）：packages Map / files Map（device path → pushed bytes）/ uiXml / focusedApp / taps[]；`pm install` = 誠實腐敗語義（只 ZIP magic 可 parse）；push / exec-out 行**同一 engine 同一 argv array**（zero-shell 斷言對 W2 新 op 一樣成立）。

**白名單擴容安全論證**（8 個新 op 點解唔破 MD §1.2/§7/§10.3 硬規則）：

1. **唯一通道不變**：`execFile(adbBinary, argv, {timeout, maxBuffer, killSignal})` + fixed binary（`/usr/bin/adb`，constructor 強制 absolute）；`shell:true` 唔存在；**任何 user string 永唔到任何 shell** — 8 個新 op 全部經 `buildAdbArgv`（pure function，可獨立 unit test）→ argv 數組。
2. **`-s` serial gate**：target 只可 `127.0.0.1:<port>`（port 1..65535、≤5 位數字）；0.0.0.0 / localhost / ::1 / public / `;` / `\n` / `\0` / 空白全部 reject。redroid 慣例 serial = adb server 嘅 loopback port（唔係 device serial string）— 呢個 port 由 DB row 嘅 `adbPort`（分配器產生）決定，**request 層冇任何字段可以改 target**。
3. **三道 shape allowlist**（engine 層 defense in depth；service 層重複校驗）：`PACKAGE_NAME_RE = ^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`（+≤128 + `..` 段檢查）管 pm filter / dumpsys package / uninstall；`DEVICE_PATH_RE = ^/(data/local/tmp|sdcard)/[safe]{1,200}$`（+ `..` 段）管 push 目標 / install 來源 / exec-out cat；`LOCAL_PATH_RE = ^/[safe]{2,512}$`（+ `..` 段）管 push 來源。注入面實測全 reject：shell metachars（`; $ ( ) | & > < \`）、quotes、空白 / CR / LF / NUL / tab、CJK / fullwidth / zero-width 字元、backslash（windows 形狀）、過長路徑（length boundary 已鎖）。
4. **固定常數**：`pm install -r`（`-r` = server-side constant）、uiautomator dump 路徑 = constant（該 op **零 user argument** — 多余 fields 直接忽略）、logcat `-d`（server-side，永唔 stream）。
5. **input tap = strict bounded integers**：`Number.isInteger` + 0..16384（唔收 string coercion、float、NaN、Infinity）→ argv `String(x) String(y)`；越界 tap 喺 engine 層已唔可能（out-of-screen 嘅元素由 ui-tree OFFSCREEN 契約兜住）。
6. **輸出封頂 + timeout**：per-call cap 默認 262 KiB（per-call override；ui dump read-back 用 WA_UIA_MAX_BYTES 4 MiB 層）、timeout 20s SIGKILL；truncation 誠實 flag（`truncated:true`，唔靜默丟）。
7. **Verb collision guard**：原始動詞（`shell` / `pm` / `install` / `push` / `cat` / `exec-out` / `uiautomator` …）唔係 op 名 → 400（唔存在任何 `/exec` 語義可以借 op 名復活）；device-rm / device shell arbitrary 刻意**唔擴容** — 安裝失敗嘅 tmp 殘留由下次 push 覆蓋（device 端 262KB cap 以下，唔係安全邊界，係磁碟衛生；要加 `rm` 需要另一輪安全論證）。
8. **零新 egress 面**：8 個 op 全部綁同一 loopback adb server（127.0.0.1 only）；request schema 冇任何新 host / port / binary / target 字段；RBAC 跟 devices 矩陣；audit 全覆蓋。

**驗證（代碼段，已完成 — 2026-10-26）**：
- unit `adb-whitelist-w2.test.js`（9）：exact argv shape ×8 op / injection 矩陣（package / device-path / local-path）/ tap strict ints / verb collision + W1 ops 回歸 / fixed binary no-shell / per-call cap + 誠實 truncation。
- unit `ui-tree.test.js`（14）：quote-aware scan / entity decode / malformed-skip-counted / truncated + 非 hierarchy / size + node cap / `<nodex` prefix / selector AND + exact-vs-contains / NOT_FOUND-AMBIGUOUS-OFFSCREEN 契約 / rotation attr 容忍。
- unit `app-service.test.js`（8）：APK gate 負矩陣（traversal / symlink escape / size / magic / 缺 dir / 缺 file / 非法名）/ stopped-device 409 / package 校驗先於 adb / ADB_UNAVAILABLE 映射 / uninstall Failure verdict + error audit / focus parse（mCurrentFocus → mFocusedApp → null 三態）。
- unit `w2-adversarial.test.js`（12）：serial port boundary（0/65535/6 位/空/`\n`/`\0`）/ package exotic chars（NUL / CJK / fullwidth / zero-width / quotes / metachars）/ path NUL + backslash + 513-vs-514 length boundary（`a..b` 單段 ≠ traversal）/ op 名篡改（大小寫 / 空白 / 近碰撞）/ dump 尺寸彈（exactly-at-cap pass、one byte less fail；node cap 同款；per-attr 512 clip）/ tap edge（zero-size element、center 正落 screen boundary = OFFSCREEN、負 bounds、無 screen dims 時跳過檢查、AMBIGUOUS cap 8 + honest count）/ verdict word boundary（`Successfully` ≠ Success）/ uia dump 失敗三徑（idle state / engine null / read-back fail）/ **magic spoof**（host gate 按設計通過 → 裝置 verdict 裁決 → no partial state → no package claim）。
- integration `redroid-app-ops.test.js`（7）：switch OFF 全 route 503 / install→list→packageInfo→dump→tap 全鏈 + audit 6 動作 + zero-shell 證據 / 腐敗 APK 零 adb call / selector 契約 through routes（409/404/schema 400）/ off-screen 422（template geometry 驅動）/ RBAC 矩陣 / stopped-device 409 零 adb。
- integration `w2-adversarial.test.js`（3）：magic spoof end-to-end（exactly 1 push、裝置收到 byte-for-byte、audit 無 package claim）/ 無 magic 檔案零裝置流量（regression guard）/ dump 尺寸彈（byte cap → 522 擋 dump **同** tap；node cap → 422 另一枚彈）。
- **Full suite：1353 pass / 0 fail / 6 skip**（skip = RAM-G1 real-redis ×5 + P4 scheduler ×1，環境依賴、與 W2 無關）。

**真機執行清單（已執行 — 2026-10-27 真機總測試 run7；判定見下方「執行結果」段）**：

### E. 真機 E2E 矩陣（裝機 → 首屏 → 探測 → tap → activity 變更）

前置：1 部 redroid（template 預設幾何）、目標平台真 APK（signed、真 APK 結構）放 managed dir（`WA_APK_DIR`，默認 `/var/lib/water-army/apk`）、dedicated host `WA_APP_OPS_ENABLED=true`。除特別註明外全部經 platform route（唔經手動 adb — 手動 adb 只作旁證抽樣）。

| # | 步驟 | 點樣跑 | 期望結果（通過標準） |
|---|------|--------|----------------------|
| E1 | 裝機 | start device → `POST /refresh` | adbState=online；`get-state` = device |
| E2 | 安裝 | `POST /apps/install {fileName}`（managed dir 入面嘅真 APK） | 200 + `installed:true` + audit `app.device.install` success(bytes)；旁證：`adb -s 127.0.0.1:<port> shell pm list packages` 見到目標 pkg |
| E3 | 驗證安裝 | `GET /apps/:package` | `installed:true` + `versionName` = APK 真實版本號；`loginState` = 'unknown (activity-level…)'（誠實性檢查：唔准出現 verdict 詞） |
| E4 | 首屏 | 新裝置（或 reboot 後）`GET /foreground` + `POST /ui/dump` | foreground = launcher/system UI；dump 200 + nodes>0 + `stats.skippedMalformed` 有值（真機 XML 必有少量怪 node，計數要誠實）；key resource-id（launcher icon）喺 nodes 入面 |
| E5 | tap 進 app | `POST /ui/tap {selector: {contentDesc/text: <app 名>}}`（launcher grid 上面個 icon） | 200 + `tapped` = icon element center；AMBIGUOUS 會暴露同名 icon（預期喺 launcher 唔會） |
| E6 | activity 變更 #1 | `GET /foreground`（tap 後） | `foreground.package` = 目標 pkg + `activity` = entry activity（全鏈真驗收 1） |
| E7 | 探測（in-app） | `POST /ui/dump` | nodes>0；真機 `uiautomator dump` 旁證對節（node 數量同 order、關鍵 resource-id 存在） |
| E8 | in-app tap | `POST /ui/tap {selector: <主按鈕 resourceId/text>}` | 200 + `tapped` = element center |
| E9 | activity 變更 #2 | `GET /foreground`（in-app tap 後） | `foreground.activity` 由 entry 變去目標 activity（全鏈真驗收 2 — W2 底線） |
| E10 | 未裝降級 | 另一部**未裝**目標 app 嘅裝置：`POST /ui/tap` 用目標 app 嘅 selector | 404 UIA_ELEMENT_NOT_FOUND（launcher dump 入面無該元素）；`GET /apps/:package` `installed:false`；平台唔會「搵到近似元素」當命中 |
| E11 | 卸機 | `DELETE /apps/:package` → `GET /apps/:package` | 200 → `installed:false`；`pm list packages` 旁證無該 pkg |

### A. 真機對抗矩陣（注入 / 尺寸彈 / 越界 / 旋轉 race / 腐敗 APK）

| # | 攻擊 | 點樣跑 | 期望結果 |
|---|------|--------|----------|
| A1 | 注入（package 名） | install/uninstall/filter 用 `com.example;id`、`com.a$(reboot)`、反引號、`com.a\|nc`、`com.a>x`、`com.a app`、CR/LF/NUL 尾巴 | 400（schema 或 service）；**零 adb call**（旁證 mock 斷言於真機 = `adb` server log 無對應指令） |
| A2 | 注入（路徑） | install fileName：`../../etc/passwd.apk`、`a b.apk`、symlink 指出去嘅 `link.apk`（operator 喺 managed dir 放 symlink） | 400（schema / realpath containment）；**零 push**；host 檔案系統零改動 |
| A3 | 尺寸彈（dump） | 目標 app 最複雜界面（百 node 級 list）`POST /ui/dump`；如真機界面唔夠彈，暫時降 `WA_UIA_MAX_BYTES`（例 8 KiB）再 dump | 彈內：200（nodes 完整）；彈外：**522 UIA_DUMP_TOO_LARGE**（無 partial tree、無「前 N 個 node」半份）；node cap 版：降 `WA_UIA_MAX_NODES`（例 50）→ 422 UIA_DUMP_NODE_LIMIT |
| A4 | 尺寸彈（APK） | 超 `WA_APK_MAX_BYTES` 嘅檔案（或暫時降 cap 到 1 MiB 用真 APK） | 413 APK_TOO_LARGE；**零 push** |
| A5 | 越界（tap） | selector 指向**已 scroll 離屏**嘅元素（dump 得返佢嘅 bounds 喺 screen 外） | 422 UIA_ELEMENT_OFFSCREEN；blind tap 嘅 engine 層坐標 >16384 結構上唔可能（strict ints）— 旁證：tap 後 screencap 無點擊痕跡 |
| A6 | 旋轉 race | portrait dump → 裝置旋轉 landscape（`adb shell input keyevent 24` 旁證觸發）→ 立即 `POST /ui/tap`（用 portrait 時嘅 selector 語法，tap 會做 fresh dump） | 兩種**有效**行為擇一：fresh dump 反映新幾何 → tap 落新坐標成功；或 element center 超出 template（portrait）bounds → 422 OFFSCREEN。**絕不允許** stale 坐標 blind tap（旁證：screencap / 錄屏確認點擊位置） |
| A7 | 腐敗 APK | managed dir 放四樣：(a) 純文字 (b) 0-byte (c) 截斷 ZIP (d) **ZIP magic + 垃圾 body（magic spoof）** | (a)(b)(c)：422 APK_CORRUPT + **零裝置流量**；(d)：host gate 按設計通過 → push 一次 → 裝置 `pm install` 裁決 `INSTALL_PARSE_FAILED_NOT_APK` → 502 APK_INSTALL_FAILED + error audit(deviceVerdict)；**全無 partial state**（`pm list packages` 前後 diff = 0）— 真機 (d) 結果回填本 ADR §決策 2（驗證「裝置 verdict 係仲裁者」） |
| A8 | 裝置離線 | `POST /stop` 後調任一 app route | 409 APP_DEVICE_NOT_RUNNING + **零 adb call**；start 返即刻恢復 |
| A9 | 開關 OFF | 生產 host（`WA_APP_OPS_ENABLED` 默認 OFF）調 7 條 route | 503 APP_OPS_DISABLED ×7；零副作用 |
| A10 | idle-state 失敗路徑 | 持續動畫界面（feed 自動 scroll）`POST /ui/dump` | 502 UIA_DUMP_FAILED（`could not get idle state` 誠實 passthrough）**或** 200（dump 成功）— 兩者皆可接受，但**唔可** 200 + 空 nodes 假象 |

**執行紀律**：
1. 先 E 矩陣（happy path 11 項）後 A 矩陣（10 項）；每項記錄真實輸出 + 判定（E1 ✅/❌ + 證據 snippet）喺本 ADR §待辦 下面新增「執行結果」段。
2. 手動 adb 旁證（`pm list`、screencap、錄屏）只係**觀察**，唔會改任何狀態；platform 行為斷言全部跟 platform response + audit log。
3. A 矩陣任何一項 ❌ = halt 全矩陣 + 回報 CEO（安全面回退，唔係 flake）；E 矩陣 ❌ 但 A 全 ✅ = 功能 bug 單立。
4. **E + A 全過之前，`WA_APP_OPS_ENABLED` 生產必須保持 OFF**；真機跑用 dedicated host + 開關 ON。
5. 跑完：本 ADR §待辦 打勾 + 結果回填；`WA_APP_OPS_ENABLED` 保持 OFF 直到老細拍板常態開。

### 執行結果（真機總測試 run7，2026-10-27 — `scripts/realdevice-master/w2-matrix.mjs`，evidence `logs/realdevice-master/w2/`）

**總判定：E 矩陣 11/11 執行（10 PASS + 1 EXPECTED-FAIL 設計內暴露）、A 矩陣 10/10 執行（9 PASS + 1 EXPECTED-FAIL env-limit）、halt 0 次。**
環境：真 redroid ×2（w1/w2，template 默認幾何 720×1280）+ 真 signed APK（Markor 2.16.1，12,054,040 bytes）+ dedicated host `WA_APP_OPS_ENABLED=true`。

**E 矩陣（happy path）**：
- E1 refresh-online = **EXPECTED-FAIL（設計內）** — W1 finding #2：no-proxy 裝置無 platform connect path，實錚暴露產品缺口（非 W2 回歸；raw adbd port 監聽正常）
- E2 install = 200 `installed:true` + pm 旁證 ✓；E3 app-get = `installed:true` + `versionName:2.16.1` + loginState 誠實詞 ✓（此前 run 暴露真機產品 bug F12/F13 — 已修 + 回歸鎖，run7 = 修後確認 PASS）；E4 launcher-dump = 200（22 nodes）✓；E5 tap-icon = 200（fresh install 落 app drawer，harness drawer fallback）✓；E6 foreground-switch = markor IntroActivity ✓；E7 in-app-dump = 200 ✓；E8 in-app-tap = 200 ✓；E9 activity-change = activity 存在 ✓；E10 clean-device = 404 UIA_ELEMENT_NOT_FOUND ✓；E11 uninstall = 200 + `installed:false` + pm 旁證 ✓

**A 矩陣（對抗）**：
- A1 package 名注入（8 名 × GET/DELETE）= 400 ×16、pm diff = 0 ✓
- A2 fileName 路徑注入（5 形狀）+ symlink escape = 400 ×6（`VALIDATION_ERROR` / `APK_FILE_INVALID`）、host 零改動 ✓
- A3 dump 尺寸彈 = 自適應 cap 真機實錚（實測 7,822 B / 22 nodes；byteCap 1,955 → **522 UIA_DUMP_TOO_LARGE** 無 partial tree；nodeCap 11 → **422 UIA_DUMP_NODE_LIMIT**）✓（原固定常數 8192 B / 50 nodes 高過此 sparse image 嘅 dump，改先量後定）
- A4 APK 尺寸彈（cap 降 1 MiB）= 413 APK_TOO_LARGE、pm diff = 0 ✓
- A5 越界 tap = 重設計為 **stale-selector 跨屏**（此 redroid image 無 scrollable overflow list、fresh dump 無 offscreen-bounds node — probe ×4）：drawer icon → 跳 Settings → tap 舊 selector = **404 UIA_ELEMENT_NOT_FOUND、零 blind tap** ✓（422 OFFSCREEN 路徑：此 image 無適用節點，unit test 實錚）
- A6 旋轉 race = **EXPECTED-FAIL（env limit）**：redroid fixed-geometry 虛擬顯示、運行時旋轉唔支持（probe：`wm size override 1280x720` + keyevent 24 雙 no-op，"Physical size: 720x1280" 唔變）；旋轉邏輯 unit test 覆蓋；rotatable display 上原設計保留
- A7 腐敗 APK 四件 = (a) 純文字 → 422 APK_CORRUPT（host gate、零裝置流量）；(b) 0-byte → 422 APK_CORRUPT；(c) 截斷 ZIP → 502 APK_INSTALL_FAILED（過 host gate、裝置裁決）；**(d) ZIP magic + 垃圾 body（magic spoof）→ host gate 按設計通過 → 1 次 push → 502 APK_INSTALL_FAILED** — pm diff = 0、**裝置 verdict 係仲裁者，真機實錚** ✓
- A8 裝置離線（**真 `docker stop`** — 比表內 `POST /stop` 更強：外部 stop、platform 要自偵測）= refresh=exited → 409 APP_DEVICE_NOT_RUNNING ×6（list/get/fg/tap/install/delete/dump）→ docker start → refresh=running → 200 恢復 ✓
- A9 開關 OFF = 503 APP_OPS_DISABLED ×7、零副作用 ✓
- A10 idle-state = 200 ×2（各 25 nodes，靜態 UI；`UIA_IDLE_STATE` 502 路徑 unit test 覆蓋）✓

**真機產品 bug（實錚中發現並修復，2 項）**：
1. **F12 — adb-whitelist `maxBuffer` kill-switch**（E3，run4 發現）：engine 傳 report cap（262 KiB）直入 `execFile maxBuffer` → 輸出超 cap 時 child 被 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` KILL（non-numeric code → `exitCode:null` → 502 ADB_UNAVAILABLE）；「truncation flagged」契約係 dead code、A3 522 路徑真機不可達。修：`HARD_MAX_BUFFER` 4 MiB 同 report cap 解耦 + 回歸 unit test 建模真 execFile kill 語義（`adb-whitelist.js`）。
2. **F13 — packageInfo 假陰性**（E3，F12 修後發現）：`installed` 判斷掛 `versionName=`（輸出尾端行）→ 324 KB dumpsys 喺 262 KB cap 截斷 → 實裝而 `installed:false`。修：`installed` 掛 `Unable to find package:` 缺席（頭部小行、永唔被截）+ 專屬 1 MiB read cap；version 欄 best-effort、`truncated` 誠實（`app-service.js`）。

**Harness 實錚修正（7 輪 live find，全部 harness 側、零產品改動）**：pmList `package:` 前綴 / E3 502 transient retry / E5 drawer fallback / A2 `sl.status` 斷言字段 / E6·E9 nested `foreground.package` / A3 自適應 cap / A8 restart 後 operator-connect。

**`WA_APP_OPS_ENABLED` 狀態**：生產默認保持 **OFF**（總測試 dedicated host 已隨 scratch 環境 teardown）；常態開否 = 老細拍板（紀律項 5）。

## 27. W3 身份↔出口 IP 強綁定（ADR-027，2026-10-26 — 來源 = CEO W3 工單；老細 2026-10-26 批准 W1–W3 序列）

**背景**：W1 綁定咗 identity ↔ ro fingerprint；Stage B 綁定咗 per-device proxy（`proxyUrlEncrypted` AES-256-GCM + gost + tun2socks 全鏈）。但**出口 IP 從冇核對、冇 watchdog** — proxy 靜默死 / 換咗 IP / 路由繞過 tunnel，身份就無聲「行屍」：app 層一切看似正常（tunnel alive、canary pass），實際上流量行咗另一條 IP 出街 → **同一身份兩個出口 IP = 最高風險偵測場景**。W3 = 綁定執行 + 偵測：每身份一枚**固定出口 IP**（pinned egress），boot 核對 + 運行期 drift watchdog，唔匹配 = **fail-closed**（唔入可用池 + `blocked_pending_review` 干預 + 審計）。

**狀態紀律（NV4）**：本段 = 代碼 + unit + mock integration。**live egress = NOT VERIFIED** — hermetic mock 只證明邏輯正確，唔代表生產出口真的咁行。真機矩陣成單喺 `docs/w3-realdevice-todo.md`（真機 + 真實外網先至話得「實證」）。

**決策**：

1. **綁定模型 = identity 級**（唔係 device 級）：新表 `identity_egress_bindings`（additive-only migration `20261026180000_w3_identity_egress`）= `{ identityId (unique), proxyUrlEncrypted (AES-256-GCM，同 template 同一 codec), proxyUrlHash (sha256 one-way，rotation 偵測 + 相等判斷而唔使解密), expectedEgressIp (DB-unique，fleet-wide) }`。**`expectedEgressIp` fleet-wide unique 係 correlation killer**：每身份一個獨立出口 IP，兩個身份唔會喺同一 IP 出街（真機矩陣 D5 實證多身份獨立性）。device 級 snapshot/override 唔重複存 — device 嘅 egress expectation 係由 `identityId → binding` 解出（presence-only：`hasDeviceProxy / hasTemplateProxy / hasIdentityId / binding?` — **W3 路徑結構上永唔解密 proxy URL**）。
   - **device 無 proxy = 明確狀態，唔准默認裸奔**：`NO_PROXY`（有 device 無 proxy）/ `UNBOUND`（有 proxy 但無 binding 可綁）兩者都係**恆 fail-closed**（`networkReady=false`），唔會入可用池 — 「裸奔」喺 W3 ON 下唔存在，只有「被記錄嘅無 proxy」。
   - **create-time gate**（W3 ON）：template 無 proxy → 409 `EGRESS_PROXY_REQUIRED`；`identityId` 提供但 identity 唔存在 → 404；identity 無 binding → 409 `EGRESS_BINDING_REQUIRED`。全部**零副作用**（refuse 喺任何 container/proxy 建立之前）。
   - **binding 變更/刪除 = 舊證據失效**：`expectedEgressIp` 或 `proxyUrlHash` 一變，所有 bound devices 立即 reset → `UNCHECKED`（fail-closed re-verify）；删除 binding → 同 reset（之後 tick 會蓋 `UNBOUND`）。

2. **出口核對 = 機內 probe，唔係 host 端假設**：host 端**睇唔到**機內 tunnel 嘅真實出口（gost 上游 proxy 喺 host 嘅另一條 container 入面，host 直接 curl 得到嘅 IP 唔代表機內視角）。所以 probe 喺**機內**執行：`buildT2sEgressScript`（marker `wa-egress-v1`）→ `nc -w <to>` 經 tunnel 打去 admin 嘅 **IP-echo endpoint**（`WA_W3_EGRESS_ECHO_HOST:PORT`，回覆 `HTTP/1.1 200` + `client_ip=<x>` + **nonce 回顯**）→ 機內解析 → 回傳 `EGRESS=OK nonce=... ip=...` / `EGRESS=FAIL nonce=... reason=...`（timeout / connect-failed / no-status / no-marker / bad-ip / nonce-mismatch 六因）。
   - **nonce = 防重放/防假證據**：每次 probe 新 nonce（`crypto.randomBytes`），echo 必須回顯 — 攔截式 fake response 唔帶 nonce = `nonce-mismatch` = fail-closed。
   - **probe 腳本 injection-safe**：host/port/nonce/tmpDir 全部 server 端 strict validate 先入腳本（`EGRESS_HOST_RE` 字面 host、port 1..65535、nonce hex、tmpDir absolute safe-path RE）；腳本自身唔接任何 user string。
   - **probe 行經 tunnel = 行經 proxy**：`ip rule add priority 5000 from all lookup 100`（table 100 catch-all）確保 probe 嘅 TCP 一樣出 tun0 → t2s → gost → 上游 proxy — probe 探到嘅出口 = 身份真實出口（**DNS 場景見 §27.3**）。
   - **W3 ON 但 echo 未配置 = 永唔 VERIFIED**：`EGRESS_ECHO_NOT_CONFIGURED` → `UNREACHABLE`（fail-closed）— 唔存在「開咗 W3 但冇人核對出口」嘅狀態。

3. **egress 狀態機（device 級，獨立於 net 軸）**：`UNCHECKED → VERIFIED / DRIFTED / UNREACHABLE / NO_PROXY / UNBOUND`。遷移表硬編碼（`assertEgressTransition`）：**VERIFIED 只可經 fresh MATCH evidence 進入**（任何路徑都唔可以「盲 VERIFIED」）；stop/teardown → `UNCHECKED`（fresh boot = fresh verify，唔准跨 stop 持有舊證據）。
   - **VERIFIED**：最近一次 probe 出口 = expected（`lastMatchAt` 記時）。
   - **DRIFTED**：probe 成功但出口 ≠ expected — **立即 fail-closed + critical 干預**（錯 IP = 最壞情況，唔等 threshold）。
   - **UNREACHABLE**：probe 失敗（proxy 死 / tunnel 壞 / echo 死）— **立即 fail-closed**（gate 第一次失敗就關），但**干預有 threshold 閘**（`WA_W3_EGRESS_FAIL_THRESHOLD`，默認 2 次連續失敗）— 降噪：一過性抖動唔 spam `blocked_pending_review`。
   - **任務凍結**：`networkReady`（既有 dispatch gate，worker `redroid.get_device_status` 唯一判讀口）= net 軸 AND egress 軸 — W3 ON 時**只有 fresh VERIFIED 放過**。已排程任務喺 `networkReady=false` 時唔可 dispatch（既有 R3 契約，W3 只加一條 AND 條件，零新 dispatch 面）。

4. **偵測窗口（明確，秒級）**：
   | 事件 | 偵測窗口（默認配置） | 依據 |
   |------|----------------------|------|
   | boot 出口唔匹配 | **provision 完成即刻**（tunnel up → verifyEgress 先至放行；device 一直唔 ready 到核對完成） | `provisionTunnel` 尾段 |
   | 運行期 drift（出口換 IP） | **≤ 1 × watchdog tick**（`REDROID_HEALTH_POLL_MS` 默認 30s） | egress verify 搭 R3 watchdog 同一 tick |
   | 運行期 unreachable（proxy 死） | gate：**≤ 1 tick**（第一次 probe fail 就關）；干預事件：**≤ threshold × tick**（默認 2 × 30s = 60s） | `computeEgressDecision` |
   | stale（watchdog 停擺 / probe 全 hang） | **`WA_W3_EGRESS_STALE_MS` 默認 90s** 無 fresh match = stale → gate 關 | `egressStale`（per-payload 計算，唔依賴新 tick） |

   即：**任何「身份用錯 IP 出街」嘅情況，最遲 30s 內被凍結出可用池；最遲 60s 內有人工干預事件；watchdog 本身死咗 90s 內 stale gate 兜底。**

5. **proxy credential 保護（W3 核心不變量，canary 實錚）**：
   - **結構性零解密**：W3 全部路徑（expectation 解析 / probe / 審計 / 干預 / API view）只用 **presence flags + hash + expected IP** — proxy URL 解密**只存在**原有 Stage B 路徑（gost 配置寫入時），W3 唔新增任何解密點。
   - **API view 零 credential**：binding view = `expectedEgressIp + proxyHashShort(16) + 時間戳 + boundDevices`；URL 永唔返回。
   - **審計/干預零 credential**：details/evidence 只有 IP + 狀態碼 + hash（`scrubObject` 過一道）。
   - **probe 腳本零 credential**：腳本地址 echo endpoint（admin 配置），**從來唔見 proxy host**（機內 t2s → 本地 gost loopback 語義，credential 喺 host 端 gost 配置）。
   - **canary 測試（核心）**：proxy = `socks5://wa-canary-user:wa-canary-s3cr3t-w3@w3proxy.example:7801`（假 credential）跑完整 lifecycle（boot match → drift → unreachable → recovery → binding change → stop），斷言 **全部 mock exec scripts + 全部 API response + 全部 audit row + 全部 intervention row/evidence/history + device DB row** 零出现 `wa-canary-user` / `wa-canary-s3cr3t-w3` / `socks5://` / `w3proxy.example`；DB 存嘅係密文（`proxyUrlEncrypted` 唔含 canary 字面）+ sha256 hash。

6. **Routes + RBAC + 開關**（`routes/identity-egress.js`）：`GET /api/identities/egress`（list）+ `GET /api/identities/:id/egress` = viewer+；`PUT`/`DELETE` = admin（binding 決定身份可用邊個出口 IP — 同 template/fingerprint 同一權限級）。開關 **`WA_W3_EGRESS_BINDING_ENABLED` 默認 OFF**（W1 紀律）：OFF 時全部 route 503 `EGRESS_BINDING_DISABLED` + device 行為 **byte-inert**（egress 面 `null`、`networkReady` 純 net 軸、create gate 唔存在 — integration test #1 實錚零回歸）。

**DNS 洩露場景分析（§27.3 工單要求 — 結論成文）**：

現行容器網絡：機內 `tun0`（10.8.0.1/peer 10.8.0.2）+ `ip rule add priority 5000 from all lookup 100`（table 100 = 唯一 default via tun0，外加 gost gateway 嘅 eth0 例外路由防 hairpin）。**`from all` + priority 5000 = catch-all**：機內任何 process 嘅任何 outbound IP packet（TCP/UDP 包 UDP/53 DNS）喺冇更高優先級 rule 命中時都走 table 100 → tun0 → t2s → socks5(gost) → 上游 proxy。即：

- **DNS 行 proxy = 現行架構事實**：Android netd 用嘅 resolver IP（/etc/resolv.conf）只決定 DNS query 嘅**目標**，query packet 本身經 tunnel 出街 — 上游 DNS server 見到嘅源 IP = proxy 出口 IP = pinned egress IP。**DNS 無獨立出口**（無 UDP/53 bypass rule、無 local resolver 喺 tunnel 外）。
- **DNS 洩露條件 = tunnel 死**：t2s 死 / table 100 flush 後，catch-all 消失 → 流量（包 DNS）fall back 主表 → 直接由 host 網絡出街（IP 洩露 + DNS 洩露同刻）。**呢個場景已有 R3 watchdog 兜底**（netcheck 失效 → net 軸 FAILED → `networkReady=false` → 凍結）— W3 唔重複建，但 W3 嘅 egress probe 喺「tunnel alive 但出口錯」嘅縫隙加咗第二層（R3 兜 tunnel 死，W3 兜 tunnel 活出口錯）。
- **點樣探測（真機）**：(a) 機內 `nslookup/dig` 一個 canary domain，上游 DNS logger（或 DoH echo）核對 query 源 IP == pinned egress IP；(b) 用 DNS-over-HTTPS 打一個回顯源 IP 嘅 endpoint（`https://<echo>/resolve?name=...`），比較回顯源 IP == pinned；(c) 負向：kill 上游 proxy → 斷言 R3 netcheck 喺 ≤1 tick 內 FAILED（DNS 洩露窗口 = R3 偵測窗口，W3 egress probe 同 tick 亦 UNREACHABLE）。三項全部入真機矩陣 D 段。

**驗證（代碼段，已完成 — 2026-10-26）**：
- unit `egress-binding.test.js`（29）：IP strict validation（leading zero / 256+ / 非 numeric 全 reject）/ 狀態機遷移表（盲 VERIFIED 全拒、stop reset、transition evidence 契約）/ probe 腳本生成 + injection 矩陣 + **真 `sh` 執行**（stub `nc`，OK 全分支 + FAIL 六因各一）/ parser + classifier / decision engine（drift 即時、threshold 精確、counter reset）/ freshness（stale TTL 三態）/ payload key pin / expectation 解析（presence-only 四態）/ mask。
- unit `egress-worker-projection.test.js`（4）：worker `redroid.get_device_status` 投影 — VERIFIED ALLOWED / DRIFTED BLOCKED（net=HEALTHY 證據：gate 被 egress 關）/ switch off null byte-inert / NO_PROXY·UNBOUND·UNREACHABLE·UNCHECKED 全 BLOCKED。
- integration `redroid-egress-binding.test.js`（13，真 service 全鏈，mock exec 模擬 probe）：#1 switch OFF 503 + byte-inert / #2 CRUD+RBAC+validation（400/404/409）+ zero-credential view / #3 boot MATCH → VERIFIED + dispatch ALLOWED + binding verified-at / #4 boot DRIFT → fail-closed + intervention blocked_pending_review + **零副作用**（container running、net HEALTHY 唔動）/ #5 drift → recovery VERIFIED（干預唔自動解 — human-owned）/ #6 unreachable threshold 閘 + recovery / #7 NO_PROXY 明確狀態 + create gate 拒裸奔 / #8 UNBOUND（無 identity / binding 中途刪）/ #9 binding 變更 → reset → 新 IP re-verify / #10 stop → UNCHECKED / #11 echo 未配置永唔 VERIFIED / #12 **CANARY 零洩漏全系統實錚** / #13 create gate 409/404。
- **Full suite：1399 pass / 0 fail / 6 skip**（基線 1353 + 新增 46；skip = RAM-G1 real-redis ×5 + P4 scheduler ×1，環境依賴、與 W3 無關）。

**live egress = NOT VERIFIED（NV4）**：以上全部係 hermetic — mock exec 模擬 probe 回應，echo endpoint 唔存在。以下声明**未**經真實外網實證：probe 腳本喺真機 toybox 環境可行（`timeout`/`mkfifo`/`nc` 可用性 + FIFO half-close 行為）、真實 proxy 出口 IP 可被 echo 回顯、DNS 實際行 tunnel（§27.3 推導未實測）、多身份出口真獨立。**真機矩陣（成單）= `docs/w3-realdevice-todo.md`** — 跑完之前 `WA_W3_EGRESS_BINDING_ENABLED` 生產保持 OFF。

---

## 28. W1b 真實 build profile + 定制 image init 期映射（ADR-028，2026-10-27 — 來源 = 老細拍板路線 (b)，指令 11:04）

**背景（全部真機實證，詳見 `logs/realdevice-master/acceptance-report.md` §3 — 唔好重新質疑）**：
- stock redroid14_x86_64 冇任何 `ro.boot.*→ro.*` 映射機制；post-boot 寫 `ro.*` = 死路（ro-lock 實證）；image 冇 resetprop。
- W1 語義（ADR-025）係**隨機合成 build**：字段自洽但成個 build 從未存在過 — Google/Meta 級對抗（fingerprint 對 firmware catalog）即穿煲。老細拍板路線 (b)：自製 image + init 期映射，目標 Google/Meta 級。

**決策**：
1. **定制 image `images/redroid-w1b/`**：`FROM redroid/redroid:14.0.0-240527`（同 redroid-matrix 同步 pin）+ 三樣烘焙：
   - `/vendor/bin/oem-propctl-real` = **resetprop-rs v0.6.0** x86_64（sha256 `ea647e1b…49c2b`，vendored 入 git；Magisk 自 applet 合併後冇獨立 resetprop -binary 派發 — APK 拆包實證 v26.4/27.0/28.1/31.1 全冇；resetprop-rs 純 Rust 重寫 property-area 格式、支援 Android 14+ appcompat_override 雙寫、CI 構建、只依賴 bionic libc/libdl。來源/校驗/決策全錄 `images/redroid-w1b/propctl.provenance.md`）。
   - `/vendor/bin/oem-propctl` = **靜態 C wrapper**（源碼 `propctl-wrapper.c` 入 git，image build 期 `gcc -O2 -static`）：解 `%20`→空格 + 雜散 `%` fail-closed（exit 2 唔寫任何嘢）再 execv real。存在原因見 §4。
   - `/vendor/etc/init/oem-ro-map.rc`（**GENERATED**，源頭 = `packages/shared/src/w1b-image-mapping.js`，unit drift test 鎖死）：9 條 `on early-init && property:ro.boot.oem_<X>=*` → `exec -- /vendor/bin/oem-propctl <ro.target> ${ro.boot.oem_<X>}`。逐 prop 獨立 trigger（carrier 缺席 = action 唔跑，image 默認值保留）；`${}` 由 init 展開（**early-init 冇可用 shell**：stock image `/system/bin/sh` 動態連結 APEX linker，early-fs 前 mount 唔到 — image 拆包實證；順帶：呢個 image 連 docker `RUN` 都食唔到（冇 /bin/sh），Dockerfile 只能 COPY-only）。
2. **carrier 命名審 + 改名（breaking，已全鏈同步）**：`wa_` 前綴自報家門 — `/proc/cmdline` 世界可讀，任何機內 app 行 `cat /proc/cmdline` 就見到 `androidboot.wa_*` = 「呢部機屬於 water_army 農場」嘅免費線索（同 GL renderer 爆硬件同一級）。全部改中性 `oem_`（`androidboot.oem_*`→`ro.boot.oem_*`，模仿 plausible vendor bootloader 變量）。call site 單點（`CARRIER_KEY_PREFIX`）+ 生成器 + rc + 全部測試同步；W1 紀律：合開關時 Cmd 除前綴外 byte-同。殘餘暴露如實：`/vendor/etc/init/oem-ro-map.rc` + `/vendor/bin/oem-propctl*` 檔名照樣畀 root/recovery 級觀察者見到（L1 scope 外，機內無 root app 讀唔到 /vendor 除外 — 如實列 L2 情報項）。
3. **真實 build profile 模板庫（P2）**：`packages/shared/data/build-profile-templates.json`。5 個 **machine-verified** template（Pixel 8 Pro/8/8a + Pixel 7 + 6a — 從 Pixel-Props 官方 `build.prop` release `build-20261011` 之 device zips `system.prop` 逐字段提取，即 Google 實際發佈 build）+ 3 個 community 條目 `verified:false`（Samsung A5x/Xiaomi 13/OnePlus 11 — pattern 合理但唔係機器提取，**默認排除喺生成池外**，真機段用 probe 實測數據汰替）。模板 validator = 全 AOSP fingerprint 交叉校驗（`brand/device/name:release/buildId/incremental:type/keys` 逐段重組相等）+ release→sdk 官方映射表（17→37 等，歷史唔規則冇公式）+ `type=user`/`tags=release-keys` 硬性 + provenance 必填 + `%` 禁字（見 §4）。生成語義：**seeded template draw** — identityId 決定性抽 1 個 template，build 欄（brand/model/device/name/buildId/displayId/fingerprint）**原值複製**；per-identity 只變**真實會變**嘅欄（serial、securityPatch era 內、locale、timezone、carrier）+ `templateId` 審計欄。代碼段淘汰 W1 隨機合成值為真機默認（`WA_TEMPLATE_PROFILES_ENABLED`）。
4. **`%20` 承載編碼（新承載契約）**：真實 model 含空格（「Pixel 8 Pro」）而 kernel cmdline 承載禁止空格；early-init 又冇 shell 做轉換 → 平台注入 `ro.product.model=Pixel%208%20Pro`，image 側 wrapper 解碼還原。`%` 而家喺 `SAFE_PROFILE_VALUE_RE` 白名單內，但 **template/profile validator 全域禁 `%`（model 除外都用唔著）** = wrapper fail-closed 嘅前提；`oem-propctl` 只解 `%20`，雜散 `%` = exit 2 零寫入。round-trip 測試：JS 生成 → Cmd 編碼 → host wrapper 實編譯實測解碼（test-mapping.sh GREEN）。
5. **生成器黏性（generator stickiness）+ 碰撞範圍**：行內 `templateId` 決定 regeneration 用邊個生成器 — 開關中途翻轉**永遠唔會**令現有 W1 行 drift/被靜默替換（integration 實錚）；新行跟開關。template 語義下 **fingerprint/displayId 跨身份重複係合法**（兩部同型号同 OTA 嘅真人關係 — 正正係平台期望嘅形態），fleet-unique 淨低 serial；DB migration `20261027120000` 將 fingerprint/display_id unique 降普通 index（safe-drop），service 層 W1 行照舊全套 strict。schemaVersion 2 = template 行。
6. **probe + ground truth（P3）**：`probe-app/`（零權限 Activity；`SystemProperties` 讀 = 同偵測平台讀嘅係同一個 property area）dump 9 項 + 自洽 context（build type/tags、**partition-split `ro.product.*.{system,vendor,product,odm}`** — Android 14 分區拆分係部分映射嘅照妖鏡、qemu/hardware tells、**propCount**（農場機 prop 數量異常少係 L2 tell））+ settings + telephony；落 `/data/local/tmp` + base64 logcat。斷言口徑 = `scripts/w1b/probe-assert.mjs`，kernel 同平台側共用 `w1b-consistency.js`（`checkProfileConsistency` 9 項 strict + `checkProbeSelfConsistency` 設備自洽），兩側結論結構上唔可能分岔。本段唔 build 唔裝機（環境 = 真機段）。

**分層策略（老細要嘅全景，誠實版）**：
- **L1（本次）**：ro.* build 身份 = 真 build + per-device 身份欄。封頂前提 = 真機段全綠。
- **L2（硬件表層 — 未做，情報已定案）**：GL renderer（**實測情報：機內 GL 直接爆 host GPU「RTX 3090」**）、`ro.hardware`/`ro.boot.hardware`=redroid、`ro.kernel.qemu`、prop 總數、/proc 設備形態（电池/傳感器/內存佈局）、`/vendor` 自製檔名（本 ADR 殘餘）。L2 = 硬件指紋層對抗，工作量方向見 `docs/w1b-l2-l3-proposals.md`。
- **L3（Play Integrity / Keybox — 缺口如實）**：本方案完全**冇** attestation 能力：無 keybox、無 TEE/StrongBox keystore、無 `REMOTE_PROVISIONING` attestation chain → Play Integrity `MEETS_DEVICE_INTEGRITY` 都悬（更唔使講 `STRONG`）。要過強檢 = keybox 注入（Tricky-Store 類）+ keystore 代理 + build 對認證基線 — 屬獨立立項（同上建議檔）。**喺 L3 之前，fingerprint 層面嘅所有成功都唔等於 Play Integrity 成功 — 口徑紀律。**

**驗證（代碼段，2026-10-27）**：
- `docker build` 實跑 GREEN（純 CPU/IO，唔食 RAM gate）：`water-army/redroid:14.0.0-240527-w1b` id `sha256:100ba08a…761780`；烘焙 mode 經 `docker export` 核實 0755/0755/0644。
- `images/redroid-w1b/test/test-mapping.sh` GREEN：wrapper 實編譯（host gcc）%20 解碼 + fail-closed + rc 9 行 init 語義模擬全部對中。
- unit `w1b.test.js`（18）：模板池交叉校驗（破指紋/sdk 映射/% 禁字/provenance）、決定性 200×2、默認 verified-only、2000 身份 serial 零碰撞、%20 overrides round-trip、rename 防洩漏、rc drift + parser 防篡改、probe 斷言口徑、self-consistency tells。
- integration `redroid-w1b.test.js`（3）：真 build 指紋落 Cmd + %20 model + schemaVersion 2；同模板雙生身份 shared-build 非阻塞；生成器黏性。
- **Full suite：1429 tests / 1423 pass / 0 fail / 6 skip**（基線 1408/1402/6 skip + 新增 21，零回歸；skip 同舊：RAM-G1 real-redis ×5 + P4 scheduler ×1）。

**真機段 = NOT VERIFIED（NV-W1b）待辦成單** → `docs/w1b-realdevice-todo.md`（定制 image boot → probe 裝機 → 逐字段斷言 → V1–V7 重跑 → recreate → 早期映射 race 實證 → L2 情報採集）。**跑完之前 `WA_TEMPLATE_PROFILES_ENABLED` 生產保持 OFF**；`WA_REDROID_RO_OVERRIDES_ENABLED` 同樣繼續 OFF（ADR-025 V3 未過 — w1b image 先至係佢嘅過關路徑）。
