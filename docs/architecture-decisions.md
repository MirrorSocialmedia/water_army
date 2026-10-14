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
