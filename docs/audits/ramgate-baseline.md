# RAM-G1 A2/A3 — 真基線 + SGLang 負載條件

- **Captured**: 2026-10-22 23:56–24:03 HKT（host：kenneth-System-Product-Name，up ~52 min）
- **Owner**: CTO / water_army RAM Admission Gate G1
- **Method**: `/proc/meminfo`、`/proc/stat`、`/proc/loadavg`、`nvidia-smi`、SGLang `/health` + 小型受控 completion、`ps -eo rss,comm` 樹加總（repeatable 腳本：`scripts/ramgate-g1/sglang-rss-sample.sh`）
- **Conversion**: 1 kB = 1000 B → MB(decimal) = kB/1000 → GB = MB/1000；1 MiB = 1024 kB → GiB = MiB/1024。下表 4 口徑齊備。

## 1. 主機 RAM（A2）— 兩次獨立樣本

| 指標 | raw (kB) | MB (decimal) | GB (decimal) | MiB | GiB | 樣本時間 (HKT) |
|---|---:|---:|---:|---:|---:|---|
| **MemAvailable** | 30,906,952 | 30,906.95 | **30.91** | 30,182.57 | 29.48 | 23:56:04 |
| **MemAvailable** | 31,396,516 | 31,396.52 | **31.40** | 30,660.66 | 29.94 | 23:59:37 |
| MemTotal | 96,439,452 | 96,439.45 | 96.44 | 94,179.15 | 91.98 | 23:56:04 |
| MemFree | 2,498,928 | 2,498.93 | 2.50 | 2,440.36 | 2.38 | 23:56:04 |
| MemFree | 2,983,168 | 2,983.17 | 2.98 | 2,913.25 | 2.84 | 23:59:37 |
| Buffers | 266,000 | 266.00 | 0.27 | 259.77 | 0.25 | 23:56:04 |
| Cached | 29,062,532 | 29,062.53 | 29.06 | 28,381.40 | 27.72 | 23:56:04 |
| SwapTotal | 8,388,604 | 8,388.60 | 8.39 | 8,191.99 | 8.00 | 23:56:04 |
| SwapFree | 8,333,820 | 8,333.82 | 8.33 | 8,138.50 | 7.95 | 23:56:04 |
| SwapUsed | 54,784 | 54.78 | 0.05 | 53.50 | 0.05 | 23:56:04 |

**基線判定（G1 目標：pre-test MemAvailable ≥ 30,000 MB decimal）**：
- 樣本 1 = 30,906.95 MB ≥ 30,000 ✅
- 樣本 2 = 31,396.52 MB ≥ 30,000 ✅
- **30GB 基線達成**（兩樣本均達；波幅 ~0.5 GB，係 buff/cache 回收入出）

## 2. CPU（A2）

- cores = 16
- load average (1/5/15)：3.27 / 3.26 / 3.10（23:56:04）→ 3.24 / 3.26 / 3.13（23:59:37）≈ 16 cores 嘅 ~20%
- /proc/stat 3s delta busy = **12.7%**（24:03 量）
- 狀態：外部 agent inference 進行中（GPU 98% util）— 即 redroid+SGLang 真實共存條件

## 3. GPU（兩張 RTX 3090，A2）

| GPU | VRAM used | VRAM total | VRAM free | util.gpu | util.mem |
|---|---:|---:|---:|---:|---:|
| 0 (RTX 3090) | 21,796 MiB | 24,576 MiB | 2,329 MiB | 98% | 90% |
| 1 (RTX 3090) | 21,102 MiB | 24,576 MiB | 3,023 MiB | 98% | 90% |

- SGLang 模型權重 + KV cache 佔住兩卡 ~42.9 GiB VRAM；free ≥ 2.3 GiB（A10 harness W2 紅線 1500 MiB 之上）。
- VRAM 唔入 RAM gate 計數（gate 管 host RAM）；A10 harness 層有獨立 VRAM 紅線。

## 4. SGLang（A2 health + A3 負載條件）

- `/health` = **200**（~1.0s），模型 `/models/Qwen3.8-27B-FP8`（max_model_len 256000）。
- 小型受控 completion（`max_tokens=64, temperature=0`）×3 = **全部正常回應**。

### A3 — SGLang host RSS 雙狀態（repeatable；證據：`/home/kenneth/.openclaw/workspace/logs/ramgate-g1/sglang-rss-samples.csv` + `sglang-rss-summary.json`）

樹定義（honest）：`comm ~ ^sglang::` 做 root + 其直接 parent（python launch）+ 向下閉包（收埋 torch inductor workers）。

| 狀態 | 樣本 | tree RSS (kB) | tree RSS (GiB) | MemAvailable (kB) |
|---|---|---:|---:|---:|
| idle（ambient，外部 inference 進行中） | i1/i2/i3 | 69,282,980 ×3 | **66.07** | 30,913,108 / 30,922,520 / 30,926,344 |
| infer（本腳本受控 completion in-flight） | 1/2/3 | 69,282,984 ×3 | **66.07** | 30,924,208 / 30,936,712 / 30,939,316 |
| post（settle） | 1 | 69,282,988 | 66.07 | 30,943,392 |

**A3 結論**：
1. **SGLang host RSS = 靜態**（KV cache 預分配；idle↔infer delta < 10 kB，66.07 GiB 恆定）。小型 inference 唔會顯著移動 host RAM → redroid 容量規劃可將 SGLang 當**常數開銷**（~66 GiB tree 口徑；其中 scheduler_TP0/TP1 各 ~25.6 GiB、launch 1.6、detok 1.3、inductor workers ~2.8、其餘 python 子進程 ~4.7）。
2. **共存條件**：本機 96 GiB 總 RAM，SGLang tree 66 GiB 之後剩餘可分配空間由 MemAvailable 直接反映（基線 ~30.2–30.7 GiB）。redroid fleet 嘅 gate 計數（16 GiB floor / 18 GiB target）就係喺「SGLang 常駐」條件下量度嘅 — **唔准用「停 SGLang 後空閒」當運行條件容量**（本報告全部數字均喺 SGLang 運行下取得）。
3. 對照 CEO 23:2x 手測（~55GB 大戶清單）：差額係樹閉包計法收埋全部 python 子進程（inductor 之外嘅 scheduler 子進程等）；兩者口徑都係「SGLang 常駐常數開銷」，結論一致。

## 5. 釋放候選 profile（top RSS，**只記錄、唔執行**）

| RSS (kB) | RSS (GiB) | process | 備註 |
|---:|---:|---|---|
| 26,844,776 + 26,829,960 | 25.6 + 25.6 | sglang::schedul TP0/TP1 | **禁動**（SGLang 樹） |
| 1,771,416 | 1.69 | openclaw-gateway | OpenClaw 運行時本身 — 禁動 |
| 1,658,740 | 1.58 | python3 (SGLang launch) | 禁動（SGLang 樹） |
| 1,395,656 | 1.33 | sglang::detok | 禁動（SGLang 樹） |
| 937,564 | 0.89 | python (SGLang 子) | 禁動 |
| 594,240 / 594,072 | 1.13 合計 | python3 (SGLang 子) | 禁動 |
| 581,032 | 0.55 | Telegram | 桌面前端 — 唔屬本項目釋放範圍 |
| 373,320 / 368,236 / 358,216 | ~1.0 合計 | WebKitWebProcess / node / gnome-shell | 桌面環境 — 唔屬本項目釋放範圍 |

**結論**：host 上除咗 SGLang 樹（禁動）同 desktop/openclaw 自身，**冇可安全釋放嘅大戶**。基線已達標，無需任何釋放行動。

## 6. 對 gate 常數嘅影響（供 Phase B 參照）

- pre-test MemAvailable ≈ 30.2–30.7 GiB → `HARD_FLOOR=16384 MiB` 上方 ~14 GiB 緩衝；`POST_BOOT_TARGET=18432 MiB` 可行。
- A10 實測對照（今早 10 台）：10 台 settled MemAvail = 16,819 MiB → fleet 實際消耗 ≈ 14.1 GiB（~1,408 MiB/台全 fleet 平均，含 cache 效應；per-device settled ≈934 MiB、5→10 incremental ≈1093 MiB）→ `PER_BOOT_BUDGET=1200 MiB` 係 MD 指定嘅保守整數（934/1093 之間偏上）；全 fleet 口徑（1,408）高於 budget 係已知差異 — 由 `POST_BOOT_TARGET` 18GiB（理想）同 `HARD_FLOOR` 16GiB（硬底）兜住，config 可調。
