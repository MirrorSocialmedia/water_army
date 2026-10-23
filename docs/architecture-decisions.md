# Architecture Decisions — Docker + AI 任務管理平台

- 版本：P0（2026-10-14 14:45 HKT），trace `water-army-20261014`
- 依據：施工 MD §0–§19（762 行全份已讀）
- 結構：§1 repo 現況聲明 → §2 技術選型 → §3 MD §2 十條反制 → §4 環境現況 → §5 版本相容核實（實跑輸出）→ §6 尚待驗證項 → §7 已決/未決

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
