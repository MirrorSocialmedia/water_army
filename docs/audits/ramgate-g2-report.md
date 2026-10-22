# RAM Gate G2 報告（gen1 + gen2 接力）

**日期**: 2026-10-22/23 (UTC+8) · **執行**: gen1 (session 34815942, 00:33–02:59) → gen2 接力 (gateway 1006 #25 @03:03:08 切 gen1)
**scope**: RAM Gate Phase D (gate-live 10 機 ladder) + Phase E (identity 持久化/回收 E2E + 真 batch gate-503 path) + Phase F (回歸 + 報告 + recorded teardown)
**host**: kenneth-System-Product-Name · A10 24GiB · redroid 14.0.0-240527-matrixa-r3

---

## 1. 文件清單 + commits

### Commits (origin/main)
| SHA | 內容 | gen |
|-----|------|-----|
| `9f3b853` | RAM-G2 Phase D harness: gate-live 10-device ladder (setup/ladder/teardown, pidfile-only, resumable) | gen1 |
| `1d6f547` | RAM-G2 harness fixes: health/live path, api_login default cookie, subshell API_CODE fix | gen1 |
| `fd24442` | RAM-G2 ladder fixes (gen1 tail WIP): capture create body before gate_snapshot clobbers API_BODY; jq --arg quoting; 164xx allowlist consolidated into foreign_port_redline; soak on resumed stages | gen2 (代 gen1 尾段 commit) |
| `bb25347` | RAM-G2 Phase E harness: identity marker E2E + real batch gate-503 path (gen2) | gen2 |
| `<fix-sha>` | **產品 bug fix**: worker enqueue wrapper 補傳 `delayMs`（batch auto-retry backoff 唔生效 → MAX_PARALLEL 下 3 attempts 30ms burn → FAILED_FINAL）— `apps/worker/src/worker.js` | gen2 |
| `<report-sha>` | 本報告 | gen2 |

### 新增文件
- `scripts/ramgate-g2/{setup.sh,ladder.sh,teardown.sh,common.sh}` — D 段 harness（resumable, pidfile-only, 164xx port 紅線）
- `scripts/ramgate-g2/e2e/{e2-identity.sh,e3-marker.sh,e3b-marker.sh,e4-removedata.sh,e5-batch.sh}` — E 段 harness
- `docs/audits/ramgate-g2-report.md`（本檔）
- `apps/worker/src/worker.js`（1 處 fix + 註釋）

### Raw 證據目錄
`/home/kenneth/.openclaw/workspace/logs/ramgate-g2/`（D 段）+ `logs/ramgate-g2/e2e/`（E 段）

---

## 2. 前後資源證據

| 時刻 | MemAvailable | 狀態 | 證據 |
|------|-------------|------|------|
| pre-boot (D 段 start) | **28,109 MiB** | 0 台 brb6g | `logs/waterarmy-ramgate-g2-progress.md` (gen1) |
| stage 1 up | 27,931.8 MiB | 1 台 | `gate-decisions-s1.json` (currentMiB) |
| stage 5 up | 25,227.9 MiB | 5 台 | `gate-decisions-s5.json` |
| stage 10 up (sampler min) | **20,142 MiB** | 10 台 | `ladder-samples.csv` (25 samples, min 20,142 / max 24,480 MiB) |
| E 段 run-6 attempt-1 | 20,525.1 MiB | 10 台 | `e2e/e5-attempt1-evidence.txt` (audit) |
| E 段 run-6 attempt-3 admit | ~21,5xx MiB | 9→10 台 | `e2e/e5-gate-attempt2.json` |
| CEO 核盤 (04:1x) | 21,739 MB (dec) ≈ 21,230 MiB | 10 台 orphan idle 1-2h | 任務書 |
| teardown 後 | **TBD — §8** | 0 台 | §8 |

SGLang 30000 全程 200（ladder 25/25 sample；E 段 health 抽樣全 200）— 未 stop/restart（硬界線 1）。

---

## 3. Gate 實作 + 測試證據

**實作**（G1，ref `docs/ram-gate.md` + `docs/audits/ramgate-baseline.md`）：
- 准入點：redroid create（device lease）+ batch container start（run lease），atomic Redis Lua admission+lease（`f422354`），fail-closed
- 判定層序：`MAX_PARALLEL`（maxParallel=10）→ `PROJECTED_BELOW_TARGET`（公式 projected = current − (live+1)×perBootBudget ≥ postBootTargetMiB）→ `HARD_FLOOR`（current ≥ 16384 MiB，永動紅線）
- G1 8 場景 suite：`docs/audits/ramgate-scenarios.md` + `12f5fb0`（hermetic，unit/integration 全覆蓋）

**G2 live 證據**（gate 真正擋真機）：
| 事件 | config | 結果 | 證據 |
|------|--------|------|------|
| DENY-s6 | target=18432 | 409 `RAM_GATE_DENIED (PROJECTED_BELOW_TARGET)` — MemAvailable 24,449, projected 17,248 < 18,432 | `DENY-s6.json` + `gate-decisions-deny-s6.json` |
| DENY-s6b | target=17408 | 409 同因 — projected 17,248 < 17,408（margin 僅 160 MiB） | `DENY-s6b.json` |
| **公式 double-deduct 發現** | — | 公式由 current 扣 (live+1)×1200，但 current 已含 live leases 實際消耗 → 雙重扣。9 live 時公式 floor = 8,108–9,778 MiB（遠低於 A10 實測安穩區 16,819 MiB settle）→ target 若照「公式 floor」設會永久擋真機 | `config-adjustment-log.json`（rationale 全記錄） |
| MAX_PARALLEL deny @s10 | target=7680 | 10 live 後 wouldAdmitNext DENIED (MAX_PARALLEL, projected 8,395) — 第 11 台被擋 | `gate-status-s10.summary.json` |
| E 段 run-6（batch path） | target=7680 | 2× batch-start DENY (MAX_PARALLEL, live 10) → 3rd admit（l1 stop 後） | `e2e/e5-attempt1-evidence.txt` + audit |

**config 調整全程記錄**：`config-adjustment-log.json`（18432→17408→7680，兩步 rationale + evidence 檔）+ `config-put-*.txt` + `config-after-*.json`。

---

## 4. Per-stage 表（D 段 ladder）

| Stage | device | createdAt (UTC) | boot | gate decision | currentMiB | projectedMiB | 30000 |
|-------|--------|-----------------|------|---------------|-----------|-------------|-------|
| 1 | l1 | 18:36:21 | OK | ADMIT | 27,931.8 | 26,731 | 200 |
| 2 | l2 | 18:44:05 | OK | ADMIT | 27,202.3 | 24,802 | 200 |
| 3 | l3 | 18:44:34 | OK | ADMIT | 27,327.1 | 23,727 | 200 |
| 4 | l4 | 18:45:02 | OK | ADMIT | 26,620.1 | 21,820 | 200 |
| 5 | l5 | 18:45:32 | OK | ADMIT | 25,227.9 | 19,227 | 200 |
| 6 | l6 | — (18:55:55 halt) | **DENY** (PROJECTED_BELOW_TARGET @18432, @17408) | — | — | — | 200 |
| 6′ | l6 | 18:57:43 | OK (target 7680 後) | ADMIT | — | — | 200 |
| 7 | l7 | 18:58:12 | OK | ADMIT | — | — | 200 |
| 8 | l8 | 18:58:41 | OK | ADMIT | — | — | 200 |
| 9 | l9 | 18:59:10 | OK | ADMIT | — | — | 200 |
| 10 | l10 | 18:59:39 | OK | ADMIT (MAX_PARALLEL 隨後封鎖) | 21,595.2 (s10 gate) | 8,395 | 200 |

- **boot 完成率 10/10**；sampler 25 samples：MemAvail min **20,142** / max 24,480 MiB、load1 peak 9.35、30000 **25/200**
- stage-10 300s soak：**部分**（~175s sample 至 19:02:35；gateway kill @19:03:08 中斷）→ 補償證據：10 台 orphan idle 1–2h 全 alive（gen2 STEP 0 核）
- 每 stage create 201：`create-s1..s10-http201.json`；deny：`DENY-s6/s6b.json` + `gate-decisions-*`

---

## 5. Phase E — Identity 持久化/回收 E2E（每項 raw 證據）

證據根：`/home/kenneth/.openclaw/workspace/logs/ramgate-g2/e2e/`

### E1 scratch stack（pidfile-only）— PASS
- pg `g2-scratch-pg`@16494（`water_army_g2`）· redis `g2-scratch-redis`@16495 · API `node apps/api/src/server.js`@16490（pidfile `/tmp/ramgate-g2/api.pid`）· worker@16496
- 證據：`e-scratch-api-gen2.log`、各 pidfile、`/api/health` 回應

### E2 合成 identity + 零寫入 — PASS
- identity `ace6f4a6-3aa3-449b-bf4e-4e0dc1e8294f`（raw INSERT, scratch pg）；dataPath `.g2-scratch-identity-data/<uuid>/data`
- scratch DB count：before `identities=0 devices=10 batches=0` → after `identities=1`
- **運行 stack 零寫入**：`water_army` DB before/after `devices=0 task_runs=1014` 不變 + `pg_tables` 無 identities/batches 表
- 證據：`e2-identity-before.txt` `e2-identity-after.txt` `e2-running-before.txt` `e2-running-after.txt` `e2-insert-output.txt` `e2-identity-ids.txt`

### E3/E3b marker file 真證據（l10 主 + l9 交叉）— PASS
1. stop l10（product API）→ container exited、dataDir 保留（gate 10→9 leases）— `e3-l10-stop.json` `e3-l10-stopped.json` `e3-gate-after-stop.json`
2. alpine docker 代寫 marker 入 root-owned dataDir（G1 方法）— `e3-l10-alpine-write.txt`
3. delete l10（無 removeData，200）→ dataDir **保留**（產品設計）— `e3-l10-delete.json` `e3-l10-deleted.json` `e3-l10-datadir-after-delete.json`
4. 同 identity 重新 create（201, adbPort 16409）→ 同 dataDir → boot ~30s → **`adb shell cat /data/.g2-e2e-marker-l10` 讀返 = 所寫內容**（真 filesystem 證據，mount 入 Android）— `e3-l10-recreate.json` `e3-l10-boot.log` `e3-l10-marker-read.txt` `e3-gate-after-recreate.json`
5. marker 含 identity id + timestamp（pass-1 解析 bug → pass-2 修正，`e3-l10-marker2-read.txt` = `identity ace6f4a6-… @ 2026-10-22T21:08:54Z`）
6. **交叉隔離**：l9 寫各 marker → l10 `cat` l9 marker = `No such file or directory`（兩向）— `e3-l9-marker-read.txt` `e3-l10-l9marker-read.txt` `e3-cross-summary.txt`
7. gate 全程核對：stop 10→9（wouldAdmit ADMITTED）→ recreate 9→10（wouldAdmit DENIED MAX_PARALLEL）— `e3-gate-*.json`

### E4 removeData 語義 + EACCES — PASS（含產品發現）
- stop → dataDir 保留（產品設計）
- `DELETE … {"removeData":true}` → 200 `deleted=true dataRemoved=false dataRemoveErrorCode=DATA_DIR_PERM_DENIED`（EACCES scandir root-owned `dalvik-cache`）— `e4-l9-stop.json` `e4-l9-delete.json` `e4-l9-datadir-after.json`
- **產品發現 P1**：`removeData=true` 在 EACCES **之前已部分刪除 top-level files**（marker 冇咗但 dataDir 其餘保留，`dataRemoved=false`）→ 表面「保留」實則數據已損 → 需產品決策（docker 代刪 / root sidecar / 全部-or-無原子化）

### E5 真 batch path（503 → RETRY_WAIT → pending → resume → 成功）— PASS（live，非 hermetic）
6 個合成 identity 跑 6 輪（run-1..6；run-1/2/3/5 分別暴露 config/bug，全部留檔作證據）：
- **run-1** `NETWORK_POLICY_UNAVAILABLE`（B4 egress allowlist 必須配，`QA_ENDPOINT_ALLOWLIST` 無值 = fail-closed 按設計）— `e5-batch-created-*.txt`
- **run-2** `NETWORK_TARGET_DENIED`（egress 目標係 worker→API internal URL，需 `QA_ENDPOINT_ALLOWLIST_INTERNAL`）— 同上
- **run-3** 3× `RAM_GATE_DENIED` (MAX_PARALLEL) 全 burn（**產品 bug：delayMs 唔生效** — 見 §9）— `e5-run3.log`
- **run-4** delay fix 驗證：attempts 間隔 10.15s/10.1s（exactly BATCH_RETRY_DELAY_MS）；3rd 仍在 l1 stop 前 → FAILED_FINAL（harness 反應慢，非產品問題）— `e5-run4.log` + worker5 log
- **run-6 = 完整成功路徑**（`BATCH_RETRY_DELAY_MS=30000`）：
  1. **gate 503 retryable**：attempt-1 @21:25:43.081 `ramgate.admission_denied` (MAX_PARALLEL, live 10, current 20,525.1, projected 7,325) → `batch_container.start_denied_ram`
  2. **worker RETRY_WAIT**：identity `RETRY_WAIT`、run `queued`（delayed job 30s）、batch `RUNNING` — `e5-attempt1-fast.txt` `e5-retry-window.txt`
  3. **pending 保留**：同上（identity/run/batch 全部非 terminal）
  4. **resume**：l1 stop @21:26:25（lease 9）→ attempt-2 @21:26:13 仍 503（stop 未完）→ **attempt-3 @21:26:43 ADMIT** → 真 container `wa-batch-9f980913…-a3`（alpine:3.20, port 16370, bind mount identity dataPath→`/data`）
  5. **identity volume 真證據**：`docker exec cat /data/.g2-e2e-identity-marker` = `46fb63e5-… identity-volume-marker 2026-10-22T21:25:42Z`（容器內實讀 = MATCH）— `e5-incontainer-evidence.txt`
  6. **成功收場**：60s hold → run `succeeded` (attempt 3/3, 21:27:53) → identity `COMPLETED` → container stopped (`wasRunning:true volumeRetained:true`) → lease 釋放 → l1 restart → gate 10/10 (MAX_PARALLEL) — `e5-final-evidence.txt` `e5-gate-final.json`
  7. audit 全鏈：`start_denied_ram` ×2 → `batch_container.started` → `batch_container.stopped`（含 runId/image/hostPort/identityId）

---

## 6. NOT VERIFIED list

| 項 | 原因 |
|----|------|
| **25/50 機 ladder** | host 只有 A10 24GiB — 物理上限；10 機 = 本機最大 safe fleet（A10 baseline + 本 run 雙重實證） |
| **warm-rotation**（熱替機） | G2 scope 外；需 fleet > maxParallel 先有意义（同 25/50 限制） |
| **live egress**（真實外網出口行為） | 沙箱網絡政策限制；B4 network gate 只 verified 到 fail-closed + allowlist 匹配邏輯（`NETWORK_POLICY_UNAVAILABLE` / `NETWORK_TARGET_DENIED` 實測），未打真外網 |
| **stage-10 300s soak（完整）** | gateway kill @03:03 中斷（~175s sample）；補償：10 台 orphan idle 1–2h 全 alive |
| **removeData 正常成功路徑**（root-owned 外） | 只 verified EACCES 路徑（產品當前行為）；正常刪除需 dataDir owner 可寫（未測） |
| **E5 batch adapter = redroid 真機**（batch 直接開 redroid） | 本 E2E 用 `alpine:3.20`（health none + sleep）隔離變量；redroid 作 batch container 未測（GPU/顯存交互另計） |
| **multi-worker 並發 admission** | 單 worker 實測；多 worker 並發靠 G1 hermetic 8 場景 + atomic Lua 覆蓋 |

---

## 7. 最終 config 狀態（產品決策項，唔當 bug）

```json
{ "enabled": true, "maxParallel": 10, "hardFloorMiB": 16384,
  "postBootTargetMiB": 7680, "perBootBudgetMiB": 1200,
  "metricsMaxAgeMs": 30000, "leaseTtlMs": 86400000 }
```
- `hardFloorMiB=16384` + `maxParallel=10` = 永動紅線（未動）
- `postBootTargetMiB=7680`：gen1 實測兩步調降（18432→17408→7680），rationale 全記錄 `config-adjustment-log.json`
- **開放產品決策項（二選一）**：
  1. **修公式**：projected 唔好 double-deduct（current 已含 live 消耗，公式只扣 +1×budget）→ 屆時 target 可以照實測 settle（~16,819 MiB 安穩線）設
  2. **帶 margin 設 target**：公式照舊，target = 公式 floor 帶保守 margin（現行 7680 = 已低於 pessimistic floor 8,108，屬「放行真機、靠 hard floor 兜底」策略）
- gen2 按任務指令**未靜態修正** — 只記錄 + 提供實測數據

---

## 8. Recorded teardown（每步 raw 證據）

_(teardown 執行後 append — 見 follow-up commit)_

---

## 9. G2 期間發現嘅產品 bug / 決策項

| # | 發現 | 嚴重度 | 狀態 |
|---|------|--------|------|
| P0 | **batch auto-retry `delayMs` 被 worker enqueue wrapper 棄**（`apps/worker/src/worker.js`）→ `BATCH_RETRY_DELAY_MS` 名存實亡；MAX_PARALLEL 下 3 attempts ~30ms burn → 永久 FAILED_FINAL（run-3 實測） | **高**（gate 滿負荷時 batch 全滅） | **已修**（gen2 commit，1 行 + 註釋；回歸 1142/1136/0/6 不變） |
| P1 | `removeData=true` 部分刪除：top-level files 已刪 → 碰到 root-owned subdir EACCES → `dataRemoved=false` 但數據已損（E4 實測） | 中（數據完整性假象） | 未修 — 產品決策（docker 代刪 / root sidecar / atomic all-or-none） |
| P2 | allowlist 純 image ref（`"alpine:3.20"`）無 cmd → 容器即 exit → batch 假性 `CONTAINER_UNHEALTHY` | 低（config 陷阱，非 code bug） | 文件化（allowlist entry 帶 `cmd`；api-start.sh 已示範） |
| P3 | gate 公式 double-deduct（§7） | 中（策略誤導） | 未修 — 產品決策項 |
| P4 | worker health `delayed` count 恒 0（BullMQ delayed job 存在但 health endpoint 計唔到） | 低（可觀測性） | 未修 — 記錄 |

---

## 10. 回歸

| 時點 | tests | pass | fail | skipped | todo |
|------|-------|------|------|---------|------|
| G1 基線 (`12f5fb0`) | 1142 | 1136 | 0 | 6 | 0 |
| gen2 pre-fix（E 段前） | 1142 | 1136 | 0 | 6 | 0 |
| **gen2 post-fix（worker.js delayMs fix 後）** | **1142** | **1136** | **0** | **6** | **0** |

log：`/tmp/ramgate-g2/e-regression-gen2.log`（pre）+ `e-regression-gen2-postfix.log`（post，EXIT=0）

**零新失敗** ✓（fix 屬 wiring 層，unit suite 無覆蓋 worker enqueue wrapper seam — 建議加 e2e 覆蓋）
