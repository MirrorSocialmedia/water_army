# Repository Audit — water_army（P0 實錄）

- 審計時間：2026-10-14 14:35 HKT
- 審計者：Kairo CTO subagent（trace `water-army-20261014`）
- 依據：施工 MD §0 規則 1（先檢查既有 repository、`package.json`、Docker Compose、環境變數、現有 API、資料庫遷移和測試）與 §17 Phase 0（檢查既有程式、記錄現況與風險）

---

## 1. Repository 現況（空 repo 實錄）

Repo 路徑：`/home/kenneth/.openclaw/workspace/water_army`

實跑命令與輸出（2026-10-14 14:35 HKT）：

```text
$ git branch -a
（無輸出 — 當前 branch main 為 unborn，尚無任何 commit）

$ git log --oneline -5
fatal: your current branch 'main' does not have any commits yet

$ git status --porcelain=v1
（無輸出 — 工作樹乾淨）

$ git ls-files
（無輸出 — 零 tracked 檔案）

$ git remote -v
origin  https://github.com/MirrorSocialmedia/water_army.git (fetch)
origin  https://github.com/MirrorSocialmedia/water_army.git (push)

$ git ls-remote origin
（無輸出 — origin 上尚無任何 ref）
```

實測結論：

| 項目 | 狀態 |
|---|---|
| 程式碼 | 無（零 tracked 檔案） |
| `package.json` / lockfile | 無 |
| Docker Compose / Dockerfile | 無 |
| 資料庫 schema / migrations | 無 |
| 環境變數檔（.env*） | 無 |
| 測試 | 無 |
| git history | main 零 commit；origin 零 ref |
| 可執行/可部署物 | 無 |

**判定：全新空 repo，MD §0 規則 1 適用「若 repository 是空的，才按本文建立新專案」→ P1 由零建立。** 無既有 API、無可衝突的 migration、無需保留的 legacy 行為。P0 本 commit 將成為 `origin/main` 的第一個 ref。

## 2. Host 環境實測（2026-10-14 14:35 HKT）

```text
$ grep -E '^(PRETTY_NAME|VERSION_ID)' /etc/os-release
PRETTY_NAME="Ubuntu 24.04.4 LTS"
VERSION_ID="24.04"

$ uname -r
6.8.0-117-generic

$ node --version && npm --version
v22.22.2
10.9.7

$ sg docker -c 'docker version'   # 摘錄
Client: Version 29.1.3, API version 1.52, go1.24.4, 29.1.3-0ubuntu3~24.04.2
Server: Engine 29.1.3 (API 1.52, minimum 1.44), containerd 2.2.1, runc 1.3.4-0ubuntu1~24.04.1, docker-init 0.19.0
```

| 項目 | 實測值 | 對施工的影響 |
|---|---|---|
| OS | Ubuntu 24.04.4 LTS (Noble) | 與 MD 預設環境一致 |
| Kernel | 6.8.0-117-generic | 新於 5.18；但 binder device 未建立（見 §3） |
| Host Node | v22.22.2（Jod LTS） | 本地 dev 可用；MD §3 要求 Node 24 LTS → compose image 用 `node:24`（已核 Docker Hub tag 存在，last_updated 2026-10-06）；P1 lock/CI 以 Node 24 為準 |
| npm | 10.9.7 | 正常 |
| Docker Engine | 29.1.3（client=server，API 1.52 / min 1.44） | dockerode 5.0.1 相容；containerd 2.2.1 + runc 1.3.4 |
| Docker 存取 | 本 session 需 `sg docker -c 'docker ...'` wrapper | kenneth 已屬 docker group，但現行 session 嘅 supplementary group 係舊 snapshot；**唔好 `chmod 666 /var/run/docker.sock`**（MD §15 明文禁止）；新 login session 應可直接用 |
| GPU | 2× NVIDIA GeForce RTX 3090（各 24576MiB），driver 580.178.04，CUDA 13.0 | 有 GPU 但不代表 Redroid 可用 GPU 渲染（MD §2-4）；**audit 時兩卡 97% util（外部 workloads 運行中，疑為 30000 model service — 嚴禁 touch）**，GPU 真機驗證要另揀安靜窗口 |
| RAM | 91Gi total，audit 時 29Gi available | 足夠 |
| 磁碟 | `/`（/dev/nvme0n1p2）1.9T total，1.2T free（36% used） | 足夠；Redroid data volume 規劃時保留 ≥100G/設備 |

## 3. Redroid 可行性實測（本機）

實跑檢查（2026-10-14 14:35 HKT）：

```text
$ lsmod | grep -iE 'binder|ashmem'
（無輸出）

$ grep -iE 'binder|ashmem' /proc/modules
（無輸出）

$ ls -la /dev/binder*
ls: cannot access '/dev/binder*': No such file or directory
```

對照 Redroid 官方文件（`redroid-doc` README，2026-10-14 實抓核對）：

- 「install required kernel modules」一節：`modprobe binder_linux devices="binder,hwbinder,vndbinder"` 及 `modprobe ashmem_linux`；
- 啟動參數表列有 `androidboot.use_memfd`（以 memfd 取代已棄用嘅 ashmem，計劃預設啟用）；
- 常見問題一節：「make sure the required kernel modules are installed; run `dmesg -T` for detailed logs」。

**判定：本機 kernel module 與 device node 全缺 → 本機起唔到真 Redroid 設備。** 按工單與 MD §17 Phase 5 規則：P5 用 adapter/mock 測試 API 路徑，真機啟動、ADB、持久化、GPU 驗證明確列為未完成/待驗證（見 `architecture-decisions.md` §6 待驗證項 V1–V4）。P0/P1 唔會喺 App 啟動時自行 `modprobe` 或安裝 kernel module（MD §10.1 要求 preflight 只報告、附手動修正建議與文件連結）。

## 4. 風險與紀律記錄

1. **origin 空**：本 commit 之後 `origin/main` 先有內容；P1 起先有 branch 可比對。
2. **工單 / progress 檔位置**：`logs/waterarmy-workorder-p0.md` 與本檔喺 repo 之外（`workspace/logs/`），**唔可以 commit 入 repo**；P0 commit 範圍只有 `docs/` 四份文件。
3. **GPU 正忙**：audit 時刻 2×3090 各 97% util、各 ~21GiB 記憶體使用中 — 係運行中 workload（30000 model service 等，MD/工單明令禁 touch）。任何 GPU 相關實測（Redroid `redroid_gpu_mode=host` 驗證）必須喺確認 workload 窗口後先做，唔好為驗證而動既有用戶。
4. **Docker socket 權限**：本 session 要靠 `sg docker` wrapper 先係 session 層面嘅事，唔係 host 配置缺陷；P1 起容器化 api service 掛 socket 時用 dedicated docker group 用戶，禁 666。
5. **Host Node 22 vs MD 要求 24**：唔影響 P0；P1 落 `package.json` 時加 `"engines": { "node": ">=24" }` 與 `.nvmrc`（24），compose image `node:24`，本地 dev 建議 nvm 切 24。
6. **3-strike 狀態**：P0 全程零 tool 失敗，無循環。

## 5. 尚待驗證項（由 P0 實測產生，跟進 phase 見 ADR §6）

| # | 待驗證項 | 阻塞原因 | 跟進 |
|---|---|---|---|
| V1 | Redroid 真設備啟動 | 本機無 binder_linux/ashmem_linux module 同 `/dev/binder*` | P5：preflight 報告 + mock 驗證 API；真機需手動載入 module 後另排窗口 |
| V2 | Redroid GPU 渲染（`gpu_mode=host`） | 有 3090 但 busy；且需真設備先可以入機驗證 | P5：GPU 狀態機五態，未驗證顯示 `configured_unverified`/`未驗證` |
| V3 | `ro.*` property override 喺選定映像有冇效 | 須實測（MD §2-1 禁止假設） | P5：選定映像上逐項實測先入 Template |
| V4 | Redroid 映像版本選擇（pin dated tag + digest） | Docker Hub 見 16.0.0-250627 / 15.0.0-250627 / 14.0.0-240527 / 10.0.0-250907 等 | P5：揀一個 dated tag，實測啟動/ADB/持久化後寫入設定 |
| V5 | ADB 127.0.0.1 binding 外部不可達 | 需起機後 `ss -ltnp` + 防火牆/網路驗證 | P5 驗收條件 |
| V6 | Prisma 8 正式 stable 時點 | 現行 latest dist-tag 係 8.0.0-rc.22（RC），stable 最新 = 7.10.0 | P1 落 lock 前再查一次；若仍無 stable 8.x 就用 7.10.0 |
| V7 | BullMQ 6.x 與 PostgreSQL backend | 6.3.15 dist 內有 postgres-queue-backend，但 MD §3 指定 Redis | 維持 Redis（按 MD）；PG backend 只係備註，唔擴需求 |
