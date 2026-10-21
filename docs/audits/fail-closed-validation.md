# R3/R4 — Fail-closed 驗證記錄（MD §5 Phase 3 + §6 Phase 4 驗收證據）

> 交付物：施工 MD §11「必須交付的檔案」— 本檔為 MD §5.6 十項故障注入測試 +
> §6.4 狀態一致性測試的 **逐項 PASS 證據**（hermetic 測試 + live 實錚，兩軌並列）。
> 日期：2026-10-20（R3 live 於 10/20 09:12–10:18 UTC；R4 live 於 10/20 夜）
> 狀態權威：`Device.netState`（R4 盤點表：`docs/audits/r4-state-sources.md`）

## 0. 結論

MD §5 驗收標準（「當 tunnel 或 data-plane 失效時，設備不會繼續執行依賴網絡的任務；
狀態不會假成功；恢復後須重新驗證才可解除封鎖」）**達成**：

1. **狀態機**（`apps/api/src/services/redroid-health.js`，pure）：7 狀態
   `STOPPED/STARTING/VERIFYING/HEALTHY/DEGRADED/BLOCKED/FAILED`；合法轉移表；
   `HEALTHY` 唯一入口 = `VERIFYING` + **fresh 雙向 TCP canary PASS 證據**
   （`isCanaryPassEvidence` 結構性校驗 — 無證據 = 轉移拒）— **no blind HEALTHY**。
   非法轉移 = 拒 + `net_transition_refused` audit + 零寫入。
2. **watchdog**（`healthTickDevice` + `tickWatchdog`，30s sweep）：獨立於
   provision 路徑；control plane（container/process/tun0/table-100/rule-5000/
   effective route）+ data plane（nonce+sha256 雙向 canary）全查；stale（>
   `REDROID_HEALTH_STALE_MS` 60s）= 按不健康處理（`networkReady=false`）。
3. **fail-closed 降級**：definite protection loss（process dead / interface
   missing / route policy loss / proxy leg unreachable）→ **立即 BLOCKED**（不候
   threshold）；soft fail → `consecutiveFailures++` → DEGRADED(1) → BLOCKED
   (`REDROID_CANARY_FAIL_THRESHOLD` 2)。BLOCKED/FAILED 期間 worker 網絡任務 gate
   `networkReady=false` → **不派發**（`redroid.get_device_status` 工具 deterministic
   `dispatch: ALLOWED|BLOCKED`）。
4. **recovery 紀律**：DB lease 單飛 lock（跨 crash）+ 指數 backoff（persisted
   anchor，每個 attempt 含 #1 都等過錨）+ 每 episode `REDROID_RECOVERY_MAX_RETRIES`
   3 次上限 → 超限 `FAILED` + `manualIntervention=true`；stall signature
   （process alive + canary dead = R2 故障形狀）用小預算（1 次 re-provision 即
   manual door — re-provision 被 R2 實錚為無效）；manual retry door（`POST
   /proxy/retry`）重置 episode。恢復後 **必須重走 VERIFYING + 全套 canary**
   才可回 HEALTHY（transition table 無 BLOCKED→HEALTHY 直達邊）。
5. **審計**：每次 netState 轉移落 audit（deviceId/resourceId、前狀態、新狀態、
   原因、時間、觸發來源 watchdog|manual|provision、relatedTaskId）。

## 1. Hermetic 測試矩陣（MD §5.6 十項 → 測試，全綠，`npm test` 內）

| # | MD §5.6 場景 | 測試（file :: test name 前綴） | 斷言重點 |
|---|--------------|-------------------------------|----------|
| 1 | tunnel process 被正常停止 | `tests/integration/redroid-net-health.test.js` :: `r3 operator stop`（HEALTHY→STOPPED pre-claim，無 recovery，restart 重 provision 回 HEALTHY）+ `:: r3 definite loss`（process 死 = 保護損失，STOP 信號） | 明確停止 ≠ 故障（無假 BLOCKED）；process 死路徑同 §2 |
| 2 | tunnel process 被強制終止 | 同上 `:: r3 definite loss: kill t2s → BLOCKED on the very next tick` | 立即 BLOCKED（不候 threshold）；`TUNNEL_PROCESS_DEAD` |
| 3 | canary 端點不可達 | 同上 `:: r3 proxy leg: gost listener unreachable + canary dead → BLOCKED (PROXY_UNREACHABLE)` + `:: r3 soft failure path`（DEGRADED→BLOCKED→3 recovery→FAILED+manual）+ `:: r3 fail-closed: no canary target configured → can never HEALTHY` | proxy leg 死 = BLOCKED；canary 未配置 = 永遠唔可以 HEALTHY（fail-closed 底線） |
| 4 | DNS 正常但 TCP payload 失敗 | 同上 `:: r3 gVisor stall budget: process alive + canary dead → exactly ONE auto re-provision, then FAILED + manual flag` + `tests/integration/r4-state-consistency.test.js` :: `§6.4-1: process alive + TCP canary FAIL → DEGRADED then BLOCKED, never HEALTHY` | process 存活唔救：canary 死 = 不健康；stall signature 小預算 |
| 5 | TUN interface 被移除 | `tests/unit/redroid-net-checks.test.js` :: `r3 netcheck: classification — definite protection loss vs inconclusive vs intact` + `:: process=dead outranks route state` | interface missing/down = definite loss 分類（立即 BLOCKED 路徑）；read-only netcheck script（bracket trick、單 machine line） |
| 6 | 容器重啟 / Docker daemon 暫時不可用 | `tests/integration/r4-state-consistency.test.js` :: `§6.4-5: duplicate/late events + a restarted process cannot push BLOCKED→HEALTHY`（app2 = 重啟模擬）+ `tests/integration/redroid-net-health.test.js` :: `r3 recovery lock`（daemon 不可用時 tick 唔 spin）+ R3 live Phase D（§2.4，API 重啟） | 重啟後狀態由 DB 還原；重啟本身唔可以解鎖 HEALTHY |
| 7 | recovery 次數超限 | `:: r3 soft failure path: ... 3 recovery attempts → FAILED + manual` + `tests/unit/redroid-net-checks.test.js` :: `r3 recovery: decision — max retries → FAILED (manual intervention)` | 3 次（`REDROID_RECOVERY_MAX_RETRIES`）→ FAILED + manualIntervention；唔無限重試 |
| 8 | 兩個 watchdog 同時偵測同一故障 | `:: r3 recovery lock: while a lease is held by another holder, ticks do NOT start a second recovery` + `redroid-net-checks.test.js` :: `r3 recovery: decision — lock contention is a WAIT, never a second recovery` | DB lease 單飛：第二 holder = WAIT，唔第二 recovery；owner 唔被覆寫 |
| 9 | API/worker 重啟期間健康狀態正確重算 | `r4-state-consistency.test.js` :: `§6.4-5`（重啟 process 收 late/duplicate 事件）+ R3 live Phase D（§2.4 — byte-for-byte row restore + 新 pid 由 persisted anchor 觸發 recovery） | 零 in-memory 依賴：state/recoveries/manual/anchor 全由 DB 還原 |
| 10 | canary 過期時不能保留健康狀態 | `:: r3 stale health: HEALTHY whose last check is older than the TTL → stale=true, networkReady=false; a fresh tick cures it` + `redroid-net-checks.test.js` :: `r3 netpayload: STALE HEALTHY is treated as unhealthy (MD §5.5)` | `networkReady=false`（consumer gate 即關）；fresh tick 自愈 |

**補充（MD §6.4 狀態一致性四項）**：`r4-state-consistency.test.js` §6.4-1/2/3/4
逐項對應（process+canary / dns+tcp / stale expiry / live-view fixture parity +
worker/UI 一致性 + 零 secret）；`tests/unit/r4-payload-contract.test.js` 鎖
`NET_PAYLOAD_KEYS`/`NET_CHECK_KEYS` 契約（三邊界 drift = test 爆）；
`tests/unit/redroid-net-state-machine.test.js` 11 項（完整轉移矩陣、HEALTHY 入口
證據校驗、legacy 投影保守性）。

## 2. Live 實錚（真 Redroid + 真 tunnel + 真 canary 鏈 — 非 mock）

**環境**（`docs/live-evidence/r3-20261020/summary.md`）：runc host（kernel 6.8 +
RTX 3090，binderfs 已 persistent）；image `water-army/redroid:14.0.0-240527-matrixa-r3`
（repo Dockerfile 重建 — R1 pin + R2 fallback 雙落點）；真鏈
device→t2s→gost(20080)→mock socks5(16095)→canary(16090)（nonce+sha256 回顯 =
`buildT2sCanaryScript` 協議）；canaryHits 計數器實時可讀。

### 2.1 Create → HEALTHY（23s）
09:12:40 STARTING → 09:13:02 VERIFYING（tunnel-process-up）→ 09:13:03 **HEALTHY**
（verification-passed；canary PASS latency 1000ms，`networkReady=true`，
`stale=false`；binary check 經 fallback 落點 + self-heal canonical）。

### 2.2 Phase A — kill t2s（§5.6 #2 實錚）
kill 10:00:43 → **BLOCKED +2s**（`cf=2, TUNNEL_PROCESS_DEAD`，definite→immediate）
→ backoff anchor 30s → recovery 10:01:15 → **HEALTHY 10:01:19.973**（kill-to-healthy
**37s**，exactly 1 recovery attempt — API log delta 證明；legacy `proxy.state=error`
喺 BLOCKED 期間 — **無 fail-open 'running' 投影**；t2s 復活；recoveries heal-reset 0）。

### 2.3 Phase B — canary-down（§5.6 #3/#4 實錚）
canary-down（t2s 仍活）10:02:45 → **DEGRADED cf=1 CANARY_FAIL** → canary-up →
**HEALTHY 10:02:48.5**（3s 復原；failure-family 分類正確：verification fail ≠
process death → **0 re-provision**（recoveries 保持 0）— 唔亂重裝；cf reset +
lastCanary=PASS）。

### 2.4 Phase C — recovery lock 紀律（§5.6 #8 實錚）
kill → BLOCKED 10:09:20（anchor armed）→ **外部 lock 注入**（owner=r3-lock-test，
until+120s，anchor 強制 expired）→ 45s 窗口：state BLOCKED 穩定、rec=0、owner 唔被
覆寫、anchor 唔被 re-arm、cf 2→32（ticks 照行）→ 清 lock → **1.9s 內 recovery
fire（attempt=1）** → HEALTHY。另：lock lease 自然到期 → +1.3s 自動解鎖觸發
recovery（10:07:02 — 副產實錚）。

### 2.5 Phase D — API 重啟持久化（§5.6 #9 實錚）
kill → BLOCKED 10:17:19（anchor=10:17:49）→ 捕捉 pre-restart row → SIGTERM API
（pid 5041，<1s 退出）→ 新 API（pid 25772）10:17:25 起 → **row byte-for-byte 還原
（+2s，anchor 保留、無 re-arm）** → anchor expired → **新 pid 25772 喺 10:17:50.095
（expired 後 +1.1s）fire attempt=1** → re-provision → HEALTHY。
（第一輪 10:12 driver 假紅：只讀舊 log 檔 — 已修 multi-file scan，口徑記錄於
`docs/live-evidence/r3-20261020/`。）

### 2.6 Recovery episode ledger
9 個 episode 全部 **exactly-one attempt=1**（per-episode counter，heal-reset 0）—
ledger 全表喺 `docs/live-evidence/r3-20261020/summary.md`。零 spin、零 double-trigger。

### 2.7 R4 live（API/worker/UI 一致性，真 UI 文字驗證）
`docs/live-evidence/r4-20261020/`（6 張截圖 + audit-net-events.txt）：
HEALTHY（綠 + 文字）→ kill t2s → **BLOCKED（UI 文字 badge，唔係只剩顏色）** →
recovery → HEALTHY；canary-down → DEGRADED → 自愈；`audit-net-events.txt` =
DB audit row 實抽（每轉移有前/新狀態、原因、時間、source）— UI/worker/API 三邊界
對住同一 `proxy.network` schema（`NET_PAYLOAD_KEYS` 契約 test 鎖死）。

## 3. 邊界誠實項（唔喺本檔宣稱）

- **kernel 層 fail-open 殘留**（tunnel 死 → 設備可經 eth0 直連 egress）：本系統的
  fail-closed = **平台層**（netState BLOCKED/FAILED + `networkReady=false` +
  worker gate 唔派網絡任務 + UI/audit 全透明）。設備 Android app 自行開 socket
  嘅 kernel 層阻斷（iptables 兜底）**未實裝** — R7 decide-and-defer 決定 + 風險
  文檔化（README 已知限制 K12 更新 + release-gate-r7.md gate 4 註）— 另開單。
- **R2 spike 環境嘅 t2s→bare-mock-relay TCP stall** 喺本 live 鏈（經 gost）**未
  重現**（R3 live 證據 §2.1 canary PASS）— 根因未完全裁定，見
  `tcp-transport-investigation.md` R7 addendum。本系統嘅防線 = 持續 canary watchdog：
  任何 data-plane 回歸 = DEGRADED/BLOCKED（§2.3 實錚），唔會假 HEALTHY。
- live 測試端口（16054/16063/16077/16090-16095/16000 段/20080）全部已釋放
  （`ss -ltn` 核過 zero listener）；測試 device 全 teardown（0 容器殘留）。

## 4. 回滾

R3/R4 code（state machine + watchdog + UI + worker gate + audit）回滾 = revert
R3（6 commits：33d629c/08c89a4/6001983/a34baad/a23779a/c48a49f）+ R4
（7f2d666..e4db185 系列）；DB migration `20261018000000-net-health`（net_* 13 欄）
為 additive nullable — 回滾 code 後欄保留無害（principle：migration 只前向）。

---

## R8 live 驗證矩陣（2026-10-21）— fresh device + 真 fault injection + 重啟重建

R8 喺隔離 16xxx stack（r8-pg@16543 / r8-redis@16379 / API@16300 / worker@16200 /
mock-echo@16090 / mock-socks5@16095 / gost sidecar@20080 / ADB 16100）跑 fresh
device（`redroid-matrix-r8-live`，image r3 pin）全量回歸。canary 已按
tcp-transport-investigation R8 addendum 修正（真 tunnel-forcing target + FIFO probe
+ 10B mock）— 本矩陣全部 canary 係**真 tunnel 路徑**證據。

### 1. 三種 fault injection（全 audit 關聯，80 條 redroid events 存檔）

| # | 注入 | 偵測（audit） | 狀態鏈 | 恢復 | 結果 |
|---|------|---------------|--------|------|------|
| 1 | kill tun2socks（23:22:50） | +0s `TUNNEL_PROCESS_DEAD`（detail: process=dead iface=missing route=missing rule=present **effective=direct**） | HEALTHY→**BLOCKED**（definite-loss，watchdog，冇候 threshold） | 自動 recovery attempt 1 → STARTING→VERIFYING→**HEALTHY**（~36s，new canary） | ✅ 正路 |
| 2 | kill mock-socks5（proxy 死）（00:38:47） | +20s canary=FAIL `CANARY_FAIL`（re-provision 中）；+30s **FAILED** `STALL_REPROVISION_USELESS`（re-provision 救唔返死 proxy = 誠實判定） | HEALTHY→DEGRADED→**BLOCKED**→FAILED（fails=6，backoff nextRecoveryAt 排程） | 還原 proxy 後 +15s **仍 FAILED**（唔假自癒 — stall 需人工）→ 設計內 `POST /proxy/retry` → STARTING→VERIFYING→**HEALTHY**（**新 nonce f8b6bd1a**，非 stale） | ✅ 正路（fail-closed + 誠實 stall + 人工介入路徑全實錚） |
| 3 | `ip link delete tun0`（00:42:00） | +4s `TUNNEL_IFACE_MISSING`（detail: process=**alive** iface=missing route=missing rule=present **effective=direct** — fail-open 面被捉住） | HEALTHY→**BLOCKED**（definite-loss） | 自動 recovery（re-provision 重建 tun0 — 設計內可自動）→ STARTING→VERIFYING→**HEALTHY**（總 18s，new canary） | ✅ 正路 |

### 2. 重啟後狀態重建（唔沿用舊 HEALTHY）— 兩面
- **Negative**：proxy 死 → FAILED（00:46:54）→ 重啟 API（pid 25415）+ worker（pid 25718）
  → **t+2s/4s/6s 查詢全部 FAILED**（persisted 狀態重建，零 stale HEALTHY）。
- **Positive**：HEALTHY 時重啟 API → 新 process 10s 內 fresh canary（新 nonce）先保
  HEALTHY（23:38 實錚）— 重啟後嘅 HEALTHY = 重新驗證嚟，非沿用。

### 3. Device lifecycle（fresh device，operator/admin RBAC 實錚）
- create（22:30）→ boot → 手動 retry（boot 慢 + 我漏 REDROID_ADB_BINARY 之 env 修正，
  K14 範圍）→ **HEALTHY 23:17:58**（真 canary 前 — 當時 canary 係 direct 路徑，見
  tcp-transport R8-A；boot 鏈本身正路）。
- **stop**（00:49）：container Exited(137)、view containerState=exited/adbState=unknown、
  gost sidecar 照 Up（設計：sidecar 持久）。
- **start**（00:50:20）：warm boot → **HEALTHY 00:50:40（20s）**，fresh canary
  nonce=01d10d263e0e516e（≠ stop 前 4e47db11f4c81ac0）= 真重新驗證。
- **restart**（00:52:51）：立即 STARTING（唔沿用舊 HEALTHY）→ **HEALTHY 00:53:31**
  （fresh nonce b43d1e285c3da4ce）。
- **delete**（admin，`{confirm, removeData:true}`）：DB row 刪（GET→REDROID_DEVICE_NOT_FOUND）、
  container+sidecar 移除、adb port 16100 釋放、**dataDir 部分刪失敗 = 誠實回報**
  `dataRemoved:false, DATA_DIR_PERM_DENIED`（service 非 root，container 寫入 root-owned
  子目錄）→ 殘留由 root container 清（測試環境操作；生產部署若 service 有 dataDir
  權限則全自動）。**零假綠**。

### 4. 管理平台（同 stack，API/worker 真實環境，76 項 live smoke 全綠）
- auth/RBAC 13（admin/operator 登入登出、401/403 矩陣、logout 後 session 死）
- Docker 容器 25（list/detail/logs、404 錯路、NOT_MANAGED allowlist gate、managed
  五動作 start/stop/restart/pause/unpause、admin exception grant/revoke、operator 403、
  殘留核對）
- AI 任務 20（create/execute succeeded 結果紀錄、idempotency replay、slow+cancel、
  fail-auth failed 紀錄、retry 路徑）
- Scheduler 13（create、interval<10s 400、auto-fire ≥2 全 succeeded、**零 overlap
  = duplicate-trigger guard 實錚**、pause 35s 零 fire、resume、unauth 401）
- Audit 5（admin 200 84 events、operator 403、**遮罩實錚**：全 SECRET/PASSWORD/TOKEN/
  KEY/DATABASE_URL + 2 明文密碼 grep 整份 payload 零洩漏、regression actions 齊）

### 5. 已知邊界（本環境，唔係產品缺陷）
- **DNS canary（輔助）結構性無法喺本 mock 鏈 PASS**：gost `-L socks5://:1080` 無 UDP
  relay（`socks5: UDP relay is disabled` 實錚）→ device UDP ASSOCIATE（DNS）被拒。
  產品語義：DNS canary 僅輔助、唔單獨決定 HEALTHY（MD §10 要求滿足）；真 proxy（有 UDP）
  下 DNS canary 會正常。
- GPU 面：host 無 GPU → `gpuStatus=unverified` + preflight 誠實 WARN（9/10 PASS）—
  預期，唔係回歸。

### 6. Minor finding（非阻塞，落 release-gate 觀察項）
- `RUN_ID_PARAM`（GET /api/tasks/runs/:runId 等）只 minLength 8 無 pattern → 手造怪 id
  穿 Prisma → 500 INTERNAL 而唔係 404/400。auth 都有（無 security 影響）= 純
  error-hygiene。R8 唔改 code（scope 外），建議下單。
