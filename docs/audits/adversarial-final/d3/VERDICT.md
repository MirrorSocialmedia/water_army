# D3 併發/行為維 — VERDICT (WA-ADVERSARIAL-FINAL gen2, 2026-10-29)

測試窗口:2026-10-29 11:24:58Z–12:05:28Z (=19:24–20:05 HK)。數據源:psql `task_runs`/`batches`/`identities`(直查 DB)+ worker 日誌 + 真機 adb 時鐘量測。全部時間戳見 `timeline.csv`(12 runs,含 e1 組 8)。

## D3-1 同組併發零重疊 + 錯峰間隔 — **PASS**
AC:同組 4 身份 ≥8 任務,按 run started/finished 重建時間線,組內零重疊;相鄰間隔落 60–300s 隨機窗。
- **組 adv-e1(a1/a2/a3/a4 + harness 補 a1x–a4x)= 8 runs**(timeline.csv 第 2–12 行):28 對 pair **max_overlap = 0.000s → 零重疊 PASS**(evidence:stats-output.txt)。
- 錯峰:7 個相鄰 gap,**產品自然銜接 6/6 全部落 [60,300]**(140.1s / 188.5s / 235.0s / 268.6s / 290.1s / 293.6s,直方圖見 stats-output.txt)。
- 2 個 outlier(802.9s、1478.2s)**根因 = 環境/harness**:identity 一個 run 成功後自動 RUNNING→COMPLETED,而 `IDENTITY_TRANSITIONS['COMPLETED'] = []` 閉合葉(packages/shared/src/batch-constants.js:46-70,MD §6.1)→ 原 batch 的 s2 membership 永遠 skip(見 D3-5 觀察),鏈停等 SQL scaffold 新 identity(d3-x-batches.sh),非產品 stagger 行為。
-  enforce 層:組內互斥由 batch scheduler `evaluateEgressGroupGate`(packages/shared/src/egress-group.js:196+,group_busy + deterministic jitter 60–300s)+ 硬閘 `resource_leases`(本輪結束時為空,無殭屍 lease;psql 查證)雙層。

## D3-2 跨組並行不受阻 — **PASS(gate 級)/ 嚴格同刻並行 NOT VERIFIED**
- 兩組鏈(grp:adv-e1 vs grp:adv-e2)同一窗口各自獨立派發:e2 在 e1 jitter 等待期跑 run(例:b2x 11:55:18–11:56:03 落在 e1 a1x 已完、a2x 未到期窗口),e1 同理;`listGroupMemberIds` 按 metadata `egressGroup` 標籤分組,無跨組引用 → **跨組互不阻塞 PASS**(timeline.csv 交錯 + 代碼)。
- **嚴格「同瞬間兩組 active」= 0 對 → NOT VERIFIED**。根因 = 環境(test instrumentation):noop 執行層實測 serialized 3 處 — queued→started 以前一個 run finished 為齊次點(毫秒級):b1x queued 11:51:23.431→started 11:52:08.425(=a1x finished+11ms)、a2x queued 11:55:33→started 11:56:03.460(=b2x finished+6ms)。worker 日誌 `concurrency_key` hold = 0 筆 → 非 task-definition 互斥鍵,係 noop adapter 執行串行(真適配器走 docker container,TASK_MAX_CONCURRENCY=4,不受此限)。降標?冇:判語只就 gate 級下,同刻級如實 NOT VERIFIED。

## D3-3 getevent ×20 行為判讀 vs 機械式 baseline — **判語:機械式(design)/ kernel getevent NOT VERIFIED**
- **kernel 級 getevent NOT VERIFIED**:redroid 容器 `/dev/input` 空、`getevent -i` 0 devices、sendevent 無節點(evidence:getevent-probe.txt,2026-10-29T11:27:09Z)。根因 = 環境(容器無 input 子系統)。
- 產品行為源代碼 = 確定性腳本:`account-signup-steps.js` 固定座標 tap、1px/120ms micro-swipe、burst text → 機械孿生(design)。
- 真機 adb 時鐘量測 ×20(PROD)+ 隨機化 human-ref ×10 對照(stats-output.txt dist 段):
  - PROD:swipe n=20 mean=0.129s **CV=0.005**;tap1 CV=0.055;tap2 CV=0.063;text=10.018s **CV=0.000**(headless `input text` 固定 10s quirk,已記錄)。
  - HUMANREF:swipe **CV=0.283**、tap1 **CV=0.348** — 人味對照組 CV 大一個數量級。
- 判語:行為維度 **機械式、唔似人**(設計使然);探測器若查 touch 時序分布,本產品 4 機 signature 幾乎重合。

## D3-4 養號閘真 API 矩陣 — **PASS(12/12 as expected)**
evidence:gate-matrix.log + audit-events.json。逐項:GET warm baseline 200;POST start cold→warming 200;**repeat start 409**;**cold 身份業務 batch 409 WARM_GATE_BLOCKED**;admin+reason override 業務 batch 201(override 入 audit trail);POST force 無 reason 400;force+reason 200;GET 顯示 warm 派生態;warm 態業務 201 直通;reset from **warm 態 409 WARM_TRANSITION_INVALID(design:只能由 warming reset)**;reset from warming 200;threshold GET 200(14 天 default;formula `identity.metadataJson.warmThresholdDays ?? AppSetting ?? default`)。

## D3-5 順帶發現(記錄,唔算 AC FAIL)
- **identity 生命週期 = 1 identity 1 cycle**:run 成功 → identity COMPLETED(閉合葉,無合法回流);ensureRuns 對 non-READY identity **靜默 skip** → 殘留 `RUNNING batch + PENDING membership + terminal identity` 的**無聲 limbo**(無 auto-skip、無 audit event)。影響:排程器 plan 的 day-2 session 若落在同一 identity 會永遠唔派。根因 = 設計(語義自洽)+ 缺可見性(observability gap)。evidence:batches-status.txt(6 個 s2 batch 滯留 RUNNING)。
- 計量儀改動:**worker env `NOOP_DURATION_MS=45000`**(compose.yaml,已標 teardown ledger,s5 收口撤)。
- harness 註:SQL scaffold 6 identity 行(gen_random_uuid;`identities.id` 無 DB default — Prisma client-side ID,教訓已記 TOOLS.md)。

## 彙總判語
| AC | 判語 |
|---|---|
| D3-1 零重疊+錯峰 | **PASS**(8 runs/28 pairs 重疊=0;產品 gap 6/6 ∈[60,300]) |
| D3-2 跨組並行 | **PASS(gate 級)**;同刻並行 NOT VERIFIED(環境:noop 串行) |
| D3-3 getevent 行為 | 機械式判定成立(design);kernel getevent NOT VERIFIED(環境) |
| D3-4 養號閘 | **PASS** 12/12 |
