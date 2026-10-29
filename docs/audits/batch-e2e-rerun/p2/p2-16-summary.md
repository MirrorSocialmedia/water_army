# P2 — 批次 × 真機端到端（WA-BATCH-E2E-RERUN）

日期：2026-10-29（UTC）｜repo HEAD：d276328（P0 後 2667f75）
結論：**PASS（3/3 機 × 3 個 cycle 全 SUCCEEDED；getprop 12/12 真機捕獲 ×4 窗口；intervention 全循環；export JSON+CSV 零 secret）**

## 口徑（同 realdevice-final P2 v8/v9）
- 批次建立：`POST /api/batches`（identities ×3、batchSize 3、maxActiveContainers 3、continue_and_report、container adapter、**新 tag** `water-army/redroid:14.0.0-240527-gms-mtg-oemprop`、health adb-tcp:5555、timeoutSeconds 900）
- 指紋注入：allowlist `cmd`（5 geometry + 12 P1 carrier args，image ENTRYPOINT 之後 append）— 全 9 機同一 P1 profile（同 serial MOTO-616277-P6V8，workorder「same P1 profile」口徑；serial 碰撞在本驗證批次屬預期）
- hold：`CONTAINER_ADAPTER_HOLD_MS=180000`（.env，compose 加行，P3 還原）
- mock provider：worker env `AI_MOCK_SCRIPT=default`（P0 已驗證）— 批次 run 無真 LLM 調用；真機證據（getprop/boot/intervention）全真
- 真機範圍：只 `redroid-rdfa-r*` 前綴（r1–r9）；禁碰集 {rdev-f1, redroid-mc-dogfood-2, rdev-e1-gost} 零接觸

## 三個 cycle
| cycle | batch | 機 | 結果 | 備註 |
|---|---|---|---|---|
| 1 | bb2a049b… | r1/r2/r3 | 3/3 succeeded (a2) | probe/lease/gate/retry 路徑驗證；getprop 窗口遺失（monitor bash bug — p2-11 記錄）|
| 2 | 055bea17… | r4/r5/r6 | 3/3 succeeded (a2) | 同上；FSM COMPLETED closed-leaf → cycle 3 用新身份（p2-01b 記錄）|
| 3 | 2f574ec4… | r7/r8/r9 | 3/3 succeeded（r8 = a3）| **完整證據 cycle**：getprop 12/12 ×4 窗口 + intervention 全循環 |

## 真機 getprop（P2.3）— 全部經 host ADB（產品 probe 同 channel：127.0.0.1:<hostport>）
| 檔 | 機/attempt | 12/12 | baseline 13 props | boot_completed |
|---|---|---|---|---|
| p2-12-gt-r7-a2.txt | r7 a2 | **12/12** | 13/13 unchanged | 1 |
| p2-12-gt-r8-a2.txt | r8 a2（intervention 前）| **12/12** | 13/13 unchanged | 1（~2s）|
| p2-12-gt-r8-a3.txt | r8 a3（intervention 後 resume）| **12/12** | 13/13 unchanged | 1（~6s）|
| p2-12-gt-r9-a2.txt | r9 a2 | **12/12** | 13/13 unchanged | 1（~2s）|

每檔含：RUN id、containerId、host port、DB run window（capture 時點 status=running）、adb connect 記錄、完整 getprop dump（-props-adb.txt / -props-exec.txt 雙 channel 交叉）、12/12 對照（P1 profile 12 項）、13 項非指紋 ro.* baseline 抽樣。

## 手動介入（P2.4）— r8，v9 口徑全循環
時間線（p2-13/13b/13c）：
1. 03:53:41 `POST /api/manual-interventions`（operator_report / DEVICE_OFFLINE / high / blocked_pending_review）→ 201，badge **0→1**（needs-attention-count + UI「Needs Attention 1」截圖 p2-10-…-1-badge.png）
2. 03:54:02 `POST /:id/acknowledge` → 200，badge **1→0**（ack 清 attention）
3. 03:54:02 **REAL STUCK EVENT：`docker stop -t 2` r8 容器 → exit 137**
4. 03:54:14 engine 自動 retry：r8 queued attempt=3（backoff ~10s）→ 03:54:24 running a3（adopt 同容器 restart）
5. a3 getprop 再捕獲 12/12（p2-12-gt-r8-a3.txt）
6. 03:57:34 r8 succeeded（a3，191642ms）
7. 03:57:35 `POST /:id/resolve`（summary 必填）→ 200 status=resolved，badge 0
UI 證據：badge=1（p2-10-…-1-badge.png）、詳情面板 Acknowledged + evidence JSON（p2-10-…-2-r8-detail.png）、resolved 後清單（p2-10-…-3-resolved.png）

## 導出（P2.5）
- `GET /api/batch-reports/:cycleId?format=json|csv`（operator）× 3 cycle 全 200：p2-14-report-cycle{1,2,3}.{json,csv}
- JSON = `water-army/batch-cycle-report/v1`（cycle3：successRate=1、retries=3、peakActiveContainers=3）
- CSV = 16 欄 header + 3 行/cycle
- **zero-secret scan（p2-15-export-scan.txt）**：export + getprop dump + intervention/monitor 檔 → 16 hits 全部 = `persist.netd.stable_secret`（Android netd 系統屬性，per-boot 瞬時 token，非 operator 憑證/零 PII/容器已毀）→ **真實 secret = 0**；admin 密碼/token 零入 repo（用 product builtin e2e bootstrap session，opaque token 6h TTL）

## 發現（跟進項）
- **F-1（結構性）：hold re-probe vs fast-boot ADB transient** — 3 cycle 全 9 機 attempt 1 同一形狀：adbd t+~1.2s 即應答 CNXN（start ok），t+~15s boot 期 ADB 瞬斷 → 15s re-probe 捕到 unhealthy → run failed RETRYABLE → 自動 retry 成功。容器全程存活（dockerd 無 death/OOM）。影響：fast-boot image 批次多耗 1 次 boot；maxAttempts=1 會假紅。建議：hold re-probe 加 start-relative grace / N-strikes（同 B6 PROBE_GRACE 同構）。獨立 ticket 處理，唔影響本單 AC（產品 retry 路徑本身達標）。

## 資源歸位（P2 後即時狀態）
- ramgate:live = {redroid-mc-dogfood-2}（baseline 1 lease，batch lease 全 release）
- wa-batch 容器：0 個 running（9 個 exited，data 卷保留 → P3 purge）
- 禁碰集 3 容器：未受影響（P3 再驗證）

## 侷限（honest）
- cycle 1/2 冇 getprop 窗口（monitor 事故 ×2，p2-11 記錄）— cycle 3 補齊完整證據；release-status 升 PASS 嘅依據 = cycle 3（完整）+ cycle 1/2（3/3 成功交叉驗證）。
- identity 層 fingerprint（UI/profile）與容器層指紋注入（allowlist cmd）係兩條路徑 — 本單驗證對象係容器層（真 getprop）；identity profile 行係產品記錄。此產品差異記錄入 final report。
