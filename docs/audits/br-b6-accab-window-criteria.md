# BR-B6 Acceptance A+B — SGLang 低峰窗口：瓶頸分析 + 窗口判据（AB1）

> 老細決策 2026-10-22 13:34：現有主機 SGLang 低峰窗口、分階段真機驗證；暫不批准
> dedicated GPU / 另一台主機。本檔 = AB1 交付：瓶頸類型結論 + 寫死嘅窗口判据。
> 實測基線同 progress：`logs/br-b6-accAB/`（workspace，gitignored）+
> `waterarmy-br-accAB-progress.md`（CEO workspace logs）。

## 1. 基線環境（2026-10-22 13:46 實測）

| 項 | 值 |
|----|----|
| Host RAM | 91G total / 23G available / 16 cores / load1 ~3.3 |
| GPU0 RTX 3090 | 21866/24576 MiB used（free 2710），util 98% |
| GPU1 RTX 3090 | 21120/24576 MiB used（free 3456），util 98% |
| SGLang | `sglang-fixed-run`（3 days）Qwen3.8-27B-FP8, **tp-size 2, --mem-fraction-static 0.89**, context 256k, max-running-requests 8, kv fp8, hicache 12G；30000 healthy（200 @1.0s） |
| SGLang 進程 VRAM | TP0 = 21050 MiB, TP1 = 21052 MiB（baseline，creep 監測基準） |
| 殘留 | 無 `br-b*` / `wa-batch-*` 容器；user compose 5/5 healthy；164xx 全 free |

## 2. 瓶頸類型結論：**兩條獨立瓶頸，VRAM 唔係，compute 先係**

### 2.1 VRAM 容量 — 唔係瓶頸（量化）

- SGLang（sglang.launch_server）開機即按 `--mem-fraction-static 0.89` **preallocate 每卡
  ~89% VRAM**（weight + KV cache + Mamba cache）。**低峰窗口只降低運算負載，唔釋放
  VRAM** — 實證：TP0/TP1 進程 VRAM 由 13:52 至 13:59 完全 flat（21050/21052 MiB），
  而 GPU0 總 used 波動 ±450 MiB 係非歸屬 reservation（mem0/其它 python 進程遷移），
  唔係 SGLang creep。
- 即「低峰時每卡剩幾多 free VRAM」同「高峰時」**一樣**：GPU0 ~2.3–2.7G、GPU1 ~3.0–3.4G。
- 每 redroid 裝置（720×1280@30, gpu_mode=host）嘅 VRAM 增量 = **~64 MiB**（本日
  gen3 ladder S1 實測 `perDeviceVramMiB: 64`，`logs/br-b6lt-gen3/ladder-summary.json`；
  遠低於 vram-monitoring-plan.md §1 假設 150–400 MiB）。
- Redroid render 落點 = GPU0（R5 實證 SurfaceFlinger 開 `/dev/dri/renderD128` = GPU0）。
- 容量推算：GPU0 free 2313 MiB ÷ 64 ≈ **~30+ 裝置**；5 裝置 stage 只食 ~320 MiB。
- **VRAM 紅線（任一卡 free < 1500 MiB）喺 1→5 裝置規模完全冇觸發風險**，無論 SGLang
  高峰低峰。

### 2.2 GPU compute 飽和 — 先至係窗口嘅存在理由

- 高峰（本單開工時 13:46–14:00）：兩卡 util 97–98% = SGLang 運算飽和（`/v1/loads`
  num_running_reqs ≥1 持續）。Redroid SurfaceFlinger 同 SGLang 搶 GPU0 →
  render/compose 延遲、boot 慢化。R5 冷啟 ~24 min 正係 SGLang 97% 期實測 —
  **boot 唔係失敗，係慢**。
- 低峰窗口真實存在：本日 ladder 實測兩度兩卡 util **0%**（09:53 stage5 段、11:48
  gen3 stage2 end anchor）。SGLang 係 agent 共用推理服務，load 跟用家活動走。
- compute 飽和嘅實際風險排序：boot 時長拉長 > render 卡頓 > （無證據支持 boot 失敗）。

### 2.3 之前 S1/S2「boot 失敗」真因（本日 gen3 ladder 11:00–11:49 證據）

| 階段 | 結果 | 真因 | 狀態 |
|------|------|------|------|
| S1 (1) | TOOL_TIMEOUT / TOOL_UNAVAILABLE | host 無 `/usr/bin/adb` → boot-health spawn 唔存在 binary（c0dfe81 修：`REDROID_ADB_BINARY`）；worker 120s lifecycle timeout < 24min 冷啟 → API start 被截斷（b6a3613 修：= 1800s health window） | **已修 @ 2a9baad** |
| S2 (5) | TOOL_UNAVAILABLE ×5 | 同上 | **已修 @ 2a9baad** |
| S3 (10) | HALT host-ram 14.2G<16G | 36 孤兒 `wa-batch-*`（teardown 兩個 bug：表名 `batches` 錯 + 容器名嵌 RUN uuid 唔係 batch uuid）食 ~16GB | **已修 @ 2a9baad（label sweep）** |
| S4 (25) | HALT host-ram 9.8G<16G | 同上 | **已修 @ 2a9baad** |

**結論：ladder 史上零「真機 Android/GPU boot 失敗」紀錄** — 所有失敗歸因已修復嘅
tool/teardown bug。S1 量到 64 MiB per-device VRAM delta = 容器實喺 boot 緊。
AB2 嘅真正未知數只有一個：低峰窗口內單一 redroid 冷啟有冇更快/更穩。

## 3. 窗口判据（寫死 — 開窗先 boot）

| # | 判据 | 值 | 來源 |
|---|------|-----|------|
| W1 | 兩卡 GPU util | **< 20% 持續 ≥5 min**（sampler 30s 間隔，最後 10 行） | 本單（compute 飽和判定） |
| W2 | 任一卡 free VRAM | **≥ 1500 MiB** | ladder 紅線（vram-monitoring-plan §3） |
| W3 | SGLang 30000 `/health` | **200**（最後 sample） | ladder 紅線 |
| W4 | host MemAvailable | **≥ 16 GiB**（16384 MB） | ladder 紅線 |
| W5 | port band 16400–16499 | 無 listener | 本單 port 分配 |

> **策略變更（老細 2026-10-22 15:59，生效中）**：W1 降為**觀察量**（唔再阻 boot）—
> 根因實測：SGLang GPU load = agent 自己嘅推理用量（GPU 0% ↔ 冇 agent 思考）→
> 「等 W1 窗口」係自鎖。W2–W5 照硬 gate，boot 前一次 + boot 後核一次。
> 實證結果：AB2 24s / AB3 5×22s boot，操作者 agent idle 時段 GPU 實測 0%、
> 30000 零影響（全 200）— 見 `logs/br-b6-accAB/decision-report.md`。
> 工具：`BRB6ACCAB_W1_SOFT=1 bash window-check.sh`（stage1/stage2 嘅 gate 自動 set）。

判定工具：`scripts/br-b6accab/window-check.sh`（exit 0 = WINDOW OPEN）。
Sampler：`scripts/br-b6accab/sampler.sh`（30s append CSV；含 `br-b6e_count` —
C 項 egress 測試容器計數，並行可觀測性）。

## 4. Boot attempt 期間補充紅線（任一觸發 = 立即停 + 存 log + 報 CEO）

- 任一卡 free VRAM < 1500 MiB
- SGLang 進程 VRAM 漲 > 1024 MiB vs baseline（TP0 21050 / TP1 21052）
- 30000 `/health` 一次 5xx 或 timeout（>10s）
- host MemAvailable < 16 GiB 或 load1 > 40（2×cores+8）
- C 項（br-b6e-*）或 user compose 5 容器狀態受影響
- Android boot 失敗（health window 30 min 內唔 reach boot_completed/ADB handshake）
  → 存 dmesg/redroid log/worker log，**唔加資源重試、唔改配置硬過**，報 CEO

## 5. 資源需求估算（AB2/AB3）

- 1 redroid：4G RAM limit（實測 boot 中 ~0.6G 實際佔用 — gen3 stage2：5 容器
  memAvail 23.1→20.1G）、2 vCPU、~64 MiB VRAM（GPU0）
- 5 redroid（AB3）：≈ RAM 3–10G、10 vCPU、~320 MiB VRAM → 16G 紅線守得住
  （5 容器係 gen3 stage2 已實測規模；S3/S4 HALT 係孤兒事故非裝置本身）

## 6. 鐵律（本單範圍內）

- 30000 **禁 stop/restart**；health 異常 = 立即停 + 報 CEO
- 禁口 port：15532/15432/3001/3011/3100/3008/9800/30000 + ADB 15000–15999；
  本單用 **16400–16499**（br-b6r-* prefix、br-b6r-ladder bridge）
- user compose 5/5 零觸碰；C 項 br-b6e-* 零觸碰；rollback = 淨移除自己 artifacts
- nftables/iptables 如需只限自己 bridge subnet；動共享/全域規則 = 停止條件
