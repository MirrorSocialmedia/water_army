# P2 CYCLE 1 — redroid-rdfa-r1/r2/r3（batch-e2e-rerun-r1）

- batch cycle bb2a049b-51ba-4a5a-a33a-8d8d4c7107d8 / batch 3a0f383a-1334-486d-8bf6-89e26e3e0b99
- create 2026-10-29T03:22:20Z（p2-02）→ 3/3 SUCCEEDED 03:26:13Z（attempt=2）
- 容器：wa-batch-10a7dfbf-a1 (r1, port 16370) / wa-batch-26113067-a1 (r2, 16371) / wa-batch-46be4bb4-a1 (r3, 16372)

## 時間線（worker log + audit + dockerd 三方交叉）
| 時間 (Z) | 事件 |
|---|---|
| 03:22:21.5 | 3 run rows created (queued→running) |
| 03:22:22.7 | attempt 1: 3× batch_container.started（create+start+CNXN probe ok，~1.2s — adbd 早期 init 即應答）|
| 03:22:37.7 | attempt 1 hold re-probe 第 1 輪（15s poll）→ 3× probe ~3s 後 unhealthy |
| 03:22:51.1 | 3× CONTAINER_UNHEALTHY → run failed RETRYABLE → docker stop（10s SIGTERM→SIGKILL=137）→ RAM lease release |
| 03:23:01–02.4 | RAM gate 3× ADMIT（liveLeases 2→4）→ attempt 2：adopt 同 3 容器（adopted=true，容器 id 不變）restart → probe ok（1.2s）|
| 03:23:17–03:26:02 | attempt 2 hold 180s，re-probe 每 15s 全部 healthy（03:23:17/32/47/…）|
| 03:26:13 | 3× stop（volume retained）→ 3× SUCCEEDED → identity COMPLETED |

## 判定
- **F-RDFA-2/3 修復生效**：CNXN probe（bridge IP L2）真握手成功 6 次（attempt 1×3 + attempt 2×3）；360s lifecycle window 無 worker 端超時（v8 嘅 304 double-fail 形狀未再出現）。
- **RAM gate**：attempt 1 release（stop-for-run）→ attempt 2 3× ADMIT（liveLeases 基線 1 + 3 = 4，projected 42.7GB < 47.5GB available）→ 全部 stop 後 release。
- **port lease**：16370/16371/16372 經產品路徑 acquire/release（無殘留 — P3 驗證）。
- **數據卷**：3× volume retained（/var/lib/water-army/redroid/redroid-rdfa-r{1,2,3}）— P3 purge 清理。

## 發現 F-1（結構性 — hold re-probe vs fast-boot ADB transient）
- attempt 1 三機全部：容器**存活**（dockerd log 無 death/OOM 事件，03:22:37–50 窗口唯一事件係 03:22:50 我哋自己嘅 forced kill）但 **ADB 端點瞬斷**（t+15s，boot 進行中 — oemprop 快速 boot 形態：adbd t+1.2s 即起，boot_completed 未到，boot 期 adbd 波動重啟窗口同 15s re-probe 撞正）。
- 產品行為（by design）：unhealthy probe（API answered）→ run failed RETRYABLE → engine 自動 retry（backoff 10s）→ attempt 2 adopt+restart 成功。3/3 最終 SUCCEEDED。
- 代價：fast-boot image 嘅批次 attempt 1 boot 白耗（double boot）；maxAttempts=1 時批次會假紅。
- 建議（跟進 ticket，唔係本單範圍）：hold re-probe 加 start-relative grace 或 N-strikes（boot_completed 前寬容），同 B6 gen3 嘅 PROBE_GRACE（transport failure 寬容）同構。
- 本單處理：記錄 + cycle 2 繼續驗證（產品 retry 路徑本身係 AC 一部分 — 「3 機 run 到完」經產品自身 resilience 達成）。

## 侷限（honest）
- getprop 12/12 live 捕獲**未遂**：monitor 腳本 bash set -u brace bug（`"$TAG[$ID]"` 行 28 即死）→ attempt 2 嘅 180s hold window 冇捕到 getprop。容器已 stop（data 卷保留，但 getprop 需要 live 容器）。
- intervention 場景未執行（批次已先完成）→ cycle 2 補。
