# S4 — identity 閉合葉 limbo 修復 (WA-STEALTH-FIX2, D3 minor)

## 修前判語（docs/audits/adversarial-final/d3/VERDICT.md §…28）

> **identity 生命週期 = 1 identity 1 cycle**：run 成功 → identity COMPLETED（閉合葉，無合法回流）；
> ensureRuns 對 non-READY identity **靜默 skip** → 殘留 `RUNNING batch + PENDING membership + terminal identity`
> 的**無聲 limbo**（無 auto-skip、無 audit event）。影響：排程器 plan 的 day-2 session 若落在同一 identity
> 會永遠唔派。根因 = 設計（語義自洽）+ 缺可見性（observability gap）。
> evidence：batches-status.txt（6 個 s2 batch 滯留 RUNNING）。

（outlier 根因段同源：`IDENTITY_TRANSITIONS['COMPLETED'] = []` 閉合葉 → s2 membership 永遠 skip。）

## 修復（batch-scheduler.js `ensureRuns` fresh-membership 分支）

`identity.status === 'COMPLETED'`（唯一閉合葉）+ PENDING membership + 無 run →
**terminal drain**：membership `PENDING → SKIPPED`，
`skipReason = 'identity COMPLETED (closed leaf) — terminal drain'`，
並經 `batchSvc.recordStateEvent`（本單先 export）落 **state_events** 審計行
（entityType `identity`、`fromState PENDING → toState SKIPPED`、reason 標 D3、
details 帶 batchId + `scope:'membership'`）。

- 語義：MD §3.3 視 SKIPPED 為終態（「an approved skip」——此處由閉合葉本身批准）。
- **自動收口**：Pass 4 `evaluateBatchCompletion` 以 membership 終態為準 → 同一/下一 tick
  batch 自動 COMPLETED，唔再滯留 RUNNING。
- `tick().recovered.drained` / `ensureRuns` out 加 `drained` 計數（observability）。
- **非閉合葉唔動**：DISABLED/RECOVERING/RUNNING/FAILED_FINAL… 仍 skip-and-retry
  （FAILED_FINAL→RESERVED = 手動重試語義保留，MD §10；DISABLED→READY = admin 重新啟用）。
  只 drain 真正永遠不可派發的閉合葉 — 語義零擴散。

## Re-arm 政策（只寫文檔，唔入代碼）

1 identity = 1 cycle 係設計語義。COMPLETED identity 嘅後續工作 =
**新 identity / 新 cycle（手動）**；drain 唔會隱式重跑（BR-B6 re-arm 教訓：
RECOVERING 隔離體唔可以俾 auto path 悄悄重跑）。若将来要「同一 identity 再 run」，
要經明確 transitionIdentity（閉合葉加合法邊）+ 人手操作，唔好加 auto re-arm cron。

## 測試（hermetic，batch-scheduler.test.js +2）

1. 閉合葉 drain：cycle A 跑成功 → identity COMPLETED；cycle B 同 identity PENDING membership
   → `startBatch` 即 `drained=1/dispatched=0`、membership SKIPPED+skipReason、
   state_events 恰 1 行（reason 含 terminal drain）、下一 tick batch 自動 COMPLETED、重跑冪等 drained=0。
2. 可動狀態唔 drain：FAILED_FINAL/DISABLED/RECOVERING → drained=0、membership 照 PENDING、
   batch 唔會被自動收口。

## 殘餘風險

- drain 發生喺 `startBatch`（Pass 1）入面時，drained 計數喺 startBatch 返回值、
  唔入 `tick().recovered`（Pass 2 先至 aggregate）— 計數位置語義，非漏計。
- state_event entityType 用 `identity` + `scope:'membership'` details：stream 係描述性審計，
  fromState/toState 記嘅係 membership 狀態（reason 已註明）；要嚴格 per-entity 型號再議。
- 舊有 6 個滯留 RUNNING batch（D3 evidence 環境殘留）未追溯 drain——下一次 tick 會自然收；
  s5 核數時一併確認。
