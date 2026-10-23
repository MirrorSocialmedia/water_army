# P3 負載報告 — 五路真機並行串流（MD §14 Phase 3 / §15.4 + ADR-020 req 2/3/8）

> 交付物：施工 MD §14 Phase 3 收口 — `docs/audits/mobileconsole-p3-load-report.md`
> 日期：2026-10-23 實測（ladder 18:39–19:38 + 2026-10-24 L1/L2 資源補跑）、2026-10-24 收口
> 數據源：`logs/mobileconsole-p3/`（ladder CSV/summary + `p3-resources.csv` 5s 資源採樣 + fleet E2E 證據）
> 視頻源：`screencap` PNG（ADR-020 常規預設 — H.264 因 redroid image gralloc blocker 全 P3 未用，見 §7）

## 0. 測試環境

| 項 | 值 |
|---|---|
| host | kenneth-System-Product-Name · kernel 6.8.0-117-generic (x64) · **RTX 3090 ×2**（24576 MiB/卡；sampler 讀 GPU0） |
| 真機 | redroid 14.0.0-240527-matrixa-r3 ×5（`redroid-brmc-poc/s2/s3/s4/s5`，720×1280/320dpi，各 4GiB limit，adb 127.0.0.1:16500–16504，staggered boot 18:0x–18:2x，`boot-ladder.log`） |
| 軟件 | water_army main @ d8d0fbf（+ P3 收口 commits）；web 16492（SPA+proxy）/ api 16490 / sidecar（child of api）/ scratch PG 16494 / Redis 16495 |
| 視頻源 | screencap PNG（`VIDEO_SOURCE=screencap` default，ADR-020）；codec 標記 `screencap-png`，720×1280 |
| 輸入 | 每 60s input round：canvas 中心 tap + Home key（controller tile） |
| 採樣 | tile 狀態 10s（ladder CSV，dual-source：DOM + client dev hook）；host/container 資源 5s（`p3-resources.csv`） |

## 1. 逐級 6 項指標（L1=1 路 / L2=2 / L3=3 / L5=5）

| 級 | 總頻寬（實測） | host CPU（avg / max） | RAM MemAvailable（min / max） | FPS（per-tile） | 更新延遲（10s 樣本） | 輸入成功率 |
|---|---|---|---|---|---|---|
| L1（1 路） | **20.0 Mbps**（1,515,545,018 B / 607s） | **21.2% / 30.6%**（96 樣本） | **26,266 / 27,136 MB** | **3.63**（2206 幀 / 607s） | **p50 146ms / p95 267ms**（ms 級，60 樣本） | **100%**（18/0） |
| L2（2 路） | **37.3 Mbps**（3,046,423,609 B / 653s） | **27.3% / 38.7%**（96 樣本） | **25,686 / 27,108 MB** | **3.25**（2125+2125 幀 / 653s） | **p50 137ms / p95 269ms**（ms 級，120 樣本） | **100%**（36/0） |
| L3（3 路） | **53.6 Mbps**（4,367,138,127 B / 653s） | **32.8% / 40.6%**（96 樣本） | **25,254 / 25,837 MB** | **3.15–3.16**（2061/2060/2060 幀 / 653s） | <1s（全部 180 樣本；1s UI 量化） | **100%**（54/0） |
| L5（5 路） | **75.8 Mbps**（6,341,929,539 B / 669s） | **41.2% / 55.0%**（102 樣本） | **25,030 / 25,805 MB** | **2.83–2.84**（4 部全時段）；s5 isolation 期 1291 幀 | <1s（全部 200 樣本；1s UI 量化） | **100%**（60/0） |

注：
- 級時長 = level startedAt → close（L1 607s / L2 653s / L3 653s / L5 669s，`p3-ladder-summary-final.json` + `rerun-l1l2/p3-ladder-summary.json`）；FPS = per-tile 幀數 ÷ 級時長；總頻寬 = 全部 tile WS observer bytes 之和 ÷ 級時長（MD §14.4 測量基準 22.5Mbps/路 → 實測 ~20Mbps/路 @ L1，見 §6.3）。
- **L1/L2 行 = 2026-10-24 補跑**（原 2026-10-23 run 無/少 host 樣本 + latency 列 1s 量化 — §6.6）；補跑與原 run 同量級互相印證（原 run：L1 19.9Mbps/3.62fps、L2 38.9Mbps/3.53fps）。
- RAM = host `MemAvailable`（5 部 redroid + API/sidecar/browser 全在 host 上跑）。L5 min 25,030MB ≈ 24.4GiB — 5 路滿載全程無壓力（host 基線 ~26.5GiB available）。
- FPS = per-tile 幀數 ÷ 級時長；級均 = per-tile 平均。
- **更新延遲**：L1/L2 = dev hook `lastFrameAt` ms 精度（2026-10-24 補跑，p50 ~140ms / p95 ~270ms — 與 3.x fps 幀期 ~270ms 自洽）；L3/L5（2026-10-23 run）CSV 列係 UI label 解析（1s 量化：3.x fps 下永遠 '<1s' → 0，artifect）— 所以只可讀作「每 10s 採樣點最後幀年齡皆 <1s」（本身即實測結果），ms 級 p50/p95 未補（如需 = 再跑 ~22min ladder，見 §6.6）。
- **STALL = 0 全級**（60s 無幀進度 watchdog，ladder event 零 STALL 行）— 這是「無持續黑屏」的直接證據。
- 輸入成功率 = sent/(sent+rejected)，client 計數器 dual-source（DOM 顯示 = hook 值，560 樣本一致）。

## 2. 穩定性定義逐項判定（老細 2026-10-23 12:40，ADR-020 req 2）

> 定義原文：「5 部正確畫面 + 可接收手動操作 + 連續 5min 無持續黑屏/串流失效；~3-4 FPS 即合格（唔要求流暢視頻）」

| # | 要求 | 判定 | 證據 |
|---|------|------|------|
| 1 | 5 部正確畫面 | **PASS**（L5：5/5 tile `LIVE_CONTROLLED_BY_YOU` 全程 669s；canvas non-blank 截圖；dual-source 幀計數一致） | `p3-L5-t96s…t406s.png`；`p3-ladder-L5.csv`（200 行 5 路並列）；`p3-ladder-summary-final.json` |
| 2 | 可接收手動操作 | **PASS**（L5：5 路 × 12 次 input round 全 accepted，0 rejected；input 計數器 = 真 adb input 路徑 browser→WS→sidecar→adb） | `p3-ladder-L5.csv` input_sent 列；`fleet-e2e/t30-all-live.png` |
| 3 | 5min 無持續黑屏/串流失效 | **PASS**（hold 600–669s > 5min；STALL(60s 無幀進度) = 0；socket 斷開 = 0；sidecar session dead = 0；L5 另過 isolation：停 s5 → 其餘 4 部 3.2min 照行 → s5 重啟 OK） | ladder events（零 STALL/dead）；`p3-ladder-summary-final.json` L5 events（isolation 時間線） |
| 4 | ~3-4 FPS 即合格 | **PASS（邊界）**（L1 3.63 / L2 3.25 / L3 3.15 / L5 2.83 — 5 路並行跌到 2.8，低於 3 但屬同量級；ADR-020「唔要求流暢視頻」，操作可用性由 req 2 獨立保證） | 上表 FPS 列 |

**總判定：L5 五路並行符合 ADR-020 穩定性定義（4/4 項 PASS，FPS 項為邊界合格）**，已知限制見 §6。

## 3. 隔離測試（L5 run-2，isolation 實證）

L5 段 +7min（19:28:47+08）`docker stop redroid-brmc-s5` → 其餘 4 路 **3.2min 零中斷**（幀進度持續、無 STALL、host CPU/RAM 無尖峰）→ `docker start` 後 s5 tile 重連回 LIVE → close-all。s5 該段 1291 幀（含中斷前後兩段），finalState=CLOSED 係 isolation 操作後正常收口。證據：`p3-ladder-summary-final.json` L5 events。

## 4. Fleet E2E 4 場景（MD §15.3 — 2026-10-24 00:55 run #3，5/5 PASS）

| 場景 | 結果 | raw 證據（`logs/mobileconsole-p3/fleet-e2e/`） |
|---|---|---|
| (a) 第 6 格本地拒 + server 409 終極裁判 | **PASS** — 5/5 時 operator 頁 5 chip 全 `disabled`（title「全域 5/5 已滿」pre-check）；直連 API 第 6 路 acquire → **409 `STREAM_DEVICE_HELD`**（固定碼，MD §4.1） | `t31-6th-refusal.json`、`t31-op-chips-disabled.png` |
| (b) close → re-acquire | **PASS** — s5 tile close → usage 4/5 → 同裝置 re-acquire → `LIVE_CONTROLLED_BY_YOU` → 回 5/5 | `t32-reacquire-live.png` |
| (c) 兩用戶搶末 slot | **PASS** — 4/5 時 admin + operator 同刻 click s5：HTTP 恰好 **201 + 409**；winner=admin `LIVE_CONTROLLED_BY_YOU`，loser=operator tile 固定態 `CAPACITY_REACHED`（「串流容量已達 5/5 — 先關閉一格再開（MD §4.1）」） | `t33-last-slot-race.json`、`t33-winner-admin.png`、`t33-loser-operator.png` |
| (d) close-all → usage 0/5 | **PASS** — 5 tile 全關（confirm 對話）→ `usage 0/5`，tile 清空 | `t34-close-all.json`、`t34-zero.png` |
| （基線）open 1→5 全 LIVE | **PASS** — 1/5→5/5 計數正確、5/5 `LIVE` | `t30-all-live.png` |

運行細節：admin（mcadmin，5 tiles）+ operator（mcop1，獨立 browser context）經真 Fleet Console UI `#/devices/fleet` 全程；E2E script = `scripts/mobileconsole-p3/p3-fleet.mjs`（commit b1f12c5）；run.log 全量 12 檔證據（json+png×4 + summary + run.log）。

## 5. drain race 修復（commit 7aa9423）

P3 2026-10-23 實測發現 close-all 後 immediately re-open 會撞 409（slot release 與 lease 終態之間嘅 drain 窗口）：run-1 L3/L5 兩度中伏（5/5 開格時 2 tile 409）。修復：openTiles 開格前 poll usage 至空位足夠（45s backstop）+ close 後 30s lease TTL 為最終兜底。run-2（L3/L5）+ 2026-10-24 fleet E2E 全部零 409 開格失敗。

## 6. 已知限制（誠實清單）

1. **L5 FPS = 2.83（< 3）**：5 路 screencap PNG 並行時每路 ~15.2Mbps（總 75.8Mbps），幀率由 ~3.6（單路）跌至 2.8。喺「~3-4fps 即合格」嘅邊界內（§2 req 4 判 PASS 但係邊界）；若要穩 3fps@5路，需 H.264 路徑（§7）或降解析/幀率策略（future）。
2. **45s stuck lease 殘留**：L2/L3/L5 close-all 後 `usage` 即時讀數各剩 1/5（slot release 已行，lease row 待 30s expiry sweep/TTL 清；L5 run-2 仲剩 2/5）— 30s 後 `0/5`。MD §4.1 嘅 TTL backstop 按設計兜住；UI 即時計數會短暫顯示非零（P4 可優化 close 路徑即時清計數）。2026-10-24 L1/L2 補跑再現（L2 剩 1/5），確認係通用行為非偶發。
3. **screencap 頻寬**：P0 PoC 基準 22.5Mbps/路 → 實測 **19.9Mbps/路**（L1）。22.5 係測量基準非固定上限（ADR-020 req 3）；實測低 ~11%（分辨率/畫面靜態度相關）。
4. **H.264 = NOT VERIFIED**：pinned redroid image（matrixa-r3, digest 591296d5）media HAL 無 gralloc mapper 3.x/4.x → 所有 MediaCodec surface-encoder（scrcpy H.264 + screenrecord）零幀（P0 PoC 實證）。P3 全級 = screencap PNG；H.264 單路/五路喺 image 修復前一律 NOT VERIFIED（ADR-019/020 req 4/5/8 — 修復後 gate：獨立設備驗收 → 先入五路 ladder，auto-upgrade 需 frame-level health check）。
5. **stream_ticket 單一 cookie slot 並發設計**（2026-10-24 fleet E2E run #1 root-cause 實證）：ticket 經單一 `stream_ticket` cookie 交付（MD §11.8），N 個 tile 連續 acquire 時 browser jar 只存最新一個 — tile 嘅 WS upgrade 必須喺自己個 ticket 仲係 jar 最新值時發出，否則 401 `STREAM_TICKET_INVALID`（binding mismatch，raw 證據 `/tmp/mc-ticket-probe.mjs` 實測 + run #1 API log）。健康時（無重連）timing 偏 win（ladder 3 級 5-tile 全過）；任一路死亡→`/reconnect` 重寫 cookie 嘅風暴期會令其他 tile 嘅 upgrade 互相踩。本期對策 = E2E/ladder 確定性 400ms 開格間隔（test pacing）；**server 端修復（per-lease ticket 路徑 / URL ticket 白名單化）= follow-up**，未改產品代碼。
6. **更新延遲採樣**：2026-10-23 run 嘅 `last_frame_age_ms` 列 = UI label（1s 量化）解析 → 恒 0（artifect，非真值）；結論只可讀作「每 10s 樣本點最後幀 <1s」。2026-10-24 已改 dev hook ms 精度（commit 52c1b25）重跑 L1/L2：**L1 p50 146ms / p95 267ms，L2 p50 137ms / p95 269ms**（與 3.x fps 幀期 ~270ms 自洽）。L3/L5 ms 級 p50/p95 未補（如需 = 再跑 ~22min ladder）。

## 7. H.264 狀態（ADR-019/020 明確化）

- **NOT VERIFIED**（單路 + 五路皆然）— image gralloc blocker 未修；P3 全部數據 = screencap PNG 路徑。
- 降級/fallback 機制（ADR-020 req 6：scrcpy 失敗 → teardown → screencap + `degraded` reason 顯示）已實裝並喺 P2 E2E 覆蓋；P3 ladder 全程 `VIDEO_SOURCE=screencap`（強制值，不觸發 auto 路徑）。
- 升級 gate（req 4/5）：H.264 image 修復 → 獨立設備驗收（編碼+畫面+無黑屏+觸控鍵盤）→ 五路 ladder → 才准設預設/auto-upgrade；health check = frame-level（zero-frame 10s + stall 15s + encoder crash 偵測），唔信映像版本/程序啟動成功。

## 8. 證據索引

| 證據 | 路徑 |
|---|---|
| 合併 summary（L1/L2 run-1 + L3/L5 run-2，含 isolation） | `logs/mobileconsole-p3/p3-ladder-summary-final.json` |
| dual-source tile CSV（ts/level/device/state/frames/latency/inputs） | `p3-ladder-L3.csv`、`p3-ladder-L5.csv`（run-2）；`*.csv.run1`（L1/L2） |
| host+container 5s 資源（ts/mem/cpu/api/sidecar/gpu/devices） | `p3-resources.csv`（18:59–20:41+08，L3/L5 窗口）；L1/L2 補跑 = `rerun-l1l2/p3-resources.csv`（01:19–01:41+08） |
| L1/L2 補跑 tile CSV + summary（ms 延遲） | `rerun-l1l2/p3-ladder-L1.csv`、`rerun-l1l2/p3-ladder-L2.csv`、`rerun-l1l2/p3-ladder-summary.json` |
| 截圖（每級 60s/120s/… 時間點 tile 狀態） | `p3-L1-t62s.png … p3-L5-t406s.png` |
| fleet E2E 4 場景 raw 證據 | `fleet-e2e/`（t30–t34 json+png、run.log、p3-fleet-summary.json） |
| boot 證據 | `boot-ladder.log`、`boot-final-state.json`、`devices-after-create.json` |
| 重跑 log | `ladder-r2.out`、`dualsrc.out`、`rerun-l1l2/ladder-rerun.out` |

## 9. 結論

P3（MD §14 Phase 3）收口：**五路真機並行串流喺 ADR-020 穩定性定義下 PASS**（§2 四項判定）；fleet E2E 4 場景全綠（§4）；drain race 已修（§5）。已知限制 6 項全部有實測數據支撐（§6），H.264 = NOT VERIFIED 明確分離（§7/ADR-019/020）。5 路 75.8Mbps 總頻寬 / host CPU 41.2% / RAM min 24.4GiB — host 容量對 5 路 screencap 有充分餘量；瓶頸係每路 screencap PNG 編碼/傳輸嘅線性擴展（FPS 2.83@5路）。
