# RAM Admission Gate — G1 測試存證（8 場景 + 回歸 + 真機 integration）

日期：2026-10-23（GMT+8 01:00–02:00）
執行：G1 CTO（CTO agent subagent）
基線報告：`docs/audits/ramgate-baseline.md`（commit c6501de）
設計文檔：`docs/ram-gate.md`（commit f422354 + real-redis 修正）

## 0. 測試矩陣總覽

| 場景 | MD 要求 | 覆蓋層 | 結果 |
|------|---------|--------|------|
| S1 記憶體足夠 → 放行 | 8 場景 #1 | hermetic unit/integration + **真機** | ✅ PASS |
| S2 projected 啟動後不足 → 拒絕 | #2 | hermetic + **真機**（cap/floor 變體） | ✅ PASS |
| S3 多 worker 並發 → 唔超額放行 | #3 | **真 Redis**（10 並發 / cap 3） | ✅ PASS |
| S4 metrics 缺失/過期 → 拒絕 | #4 | hermetic（device + batch 兩路徑） | ✅ PASS |
| S5 boot 失敗 → 預留正確釋放 | #5 | **真機**（real docker create fail）+ hermetic | ✅ PASS |
| S6 worker 被 kill → 預留安全恢復 | #6 | **真 Redis**（TTL backstop + reconcile） | ✅ PASS |
| S7 低於准入線 → stop 新增 + 資料零刪除 | #7 | hermetic + **真機**（floor 變體）+ delete 路徑 | ✅ PASS |
| S8 API/DB/UI 狀態一致 | #8 | hermetic C8 + **真機**（status/DB/decisions 三邊對賬） | ✅ PASS |
| 回歸 | 零新失敗 | 全 test suite（78 舊 + 5 新 gate 檔） | ✅ 1135/1135 pass，0 fail |
| 真機 integration | 1 台完整 path | br-b6g-s1 @16400 真 boot + teardown | ✅ PASS |

測試檔：
- `tests/unit/ramgate-core.test.js` — 14（parseMeminfo / metrics / config / computeAdmission）
- `tests/unit/ramgate-service.test.js` — 16（createRamGate C1–C7 + disabled + reconcile + status）
- `tests/integration/ramgate-redroid.test.js` — 8（HTTP 層：create/stop/start/restart/delete/rollback 全路徑）
- `tests/integration/ramgate-batch-routes.test.js` — 9（batch start/stop/cap/floor/metrics/RBAC/config/reconcile）
- `tests/integration/ramgate-real-redis.test.js` — 5（**真 Redis**：atomicity / owner-check / TTL / crash-recovery；`RAM_GATE_REAL_REDIS_URL` 環境變量啟動，缺省 self-skip）

---

## S1 — 記憶體足夠 → 放行

**Expected**：create 成功；gate decision `ADMITTED`；liveLeases=1；reservedMiB=1200；container 真起。

**Actual（hermetic C1）**：
```
POST /api/devices/redroid → 201
status.counts.liveLeases = 1, reservedMiB = 1200
decisions: {action:'admit', entity:'redroid-g1-a', reason:'ADMITTED', source:'redroid-create'}
```

**Actual（真機）**：
```
17:09:50Z  POST /api/devices/redroid {name:'redroid-brb6g-s1'} → 201
gate decision log: {action:'admit', kind:'device', entity:'redroid-brb6g-s1',
  reason:'ADMITTED', currentMiB:28538.3, liveCount:1, projectedMiB:27338, source:'redroid-create'}
status: liveLeases=1, running=1, reservedMiB=1200, wouldAdmitNext={admitted:true, projectedMiB:25374}
docker: redroid-brb6g-s1 Up (privileged, memory=4294967296, nanocpus=2000000000, nvidia all-GPU)
```

**Verdict：PASS**（兩層均符合 expected）

---

## S2 — projected 啟動後不足 → 拒絕

**Expected**：409 `RAM_GATE_DENIED`，reason `PROJECTED_BELOW_TARGET`（或 cap/floor 按優先級）；**零副作用**（無 dataDir、無 DB row、無 docker create、無 lease）。

**Actual（hermetic C2）**：
```
先 create 1 台（201，liveLeases=1）→ state.memAvailableMiB=18000
POST create #2 → 409 RAM_GATE_DENIED，message 含 PROJECTED_BELOW_TARGET
  projected = 18000 − 2×1200 = 15600 < 18432
斷言全過：無 dataDir、無 device row、liveLeases 仍 =1、denial decision 記錄在案
```

**Actual（真機 — 兩個可逆 config 變體）**：
```
變體 A（cap 優先）：PUT /config {maxParallel:1}（s1 lease 佔住）→ create s2
  → 409 RAM_GATE_DENIED (MAX_PARALLEL) "MemAvailable 27,763 MiB, projected 25,362 MiB"
  零副作用驗證：無 s2 container、無 s2 dataDir、DB devices=1（不變）
變體 B（floor）：還原 maxParallel=10 + hardFloorMiB=999999 → create s4
  → 409 RAM_GATE_DENIED (BELOW_HARD_FLOOR) "MemAvailable 27,851 MiB"
還原 {maxParallel:10, hardFloorMiB:16384}（PUT 回包 stored 確認）
```

**Verdict：PASS**（denial 優先級 MAX_PARALLEL > BELOW_HARD_FLOOR > PROJECTED_BELOW_TARGET 與設計一致；零副作用三層驗證）

---

## S3 — 多 worker 並發 → 唔超額放行（原子性）

**Expected**：N 個并发 admit 請求，cap=K → **恰好 K 個 ADMITTED**，其餘拒絕；無超賣。

**Actual（真 Redis 7.4.5，scratch 容器 g1-gate-redis @16495）**：
```
測試 D3：10 個 setImmediate 並發 admit（cap maxParallel=3）
  → admitted = 3（精確），denied = 7（全 MAX_PARALLEL），liveLeases = 3
測試 D4：2 個「worker」（獨立 gate 實例共享同 redis）並發 admit（cap=2）
  → 各自 admitted=1，合計精確 2
```
原子性來源：admission check + lease write 喺同一個 Redis Lua script（`ADMIT_LUA`）— Redis 單線程執行 Lua = 原生原子；ioredis 用原生 `eval(script, numkeys, ...keys, ...args)` 簽名。

**Actual（hermetic）**：fake redis 對 Lua 常量做 1:1 JS 模擬（check-then-write 單一 eval 單元）— unit 層覆蓋同语义。

**Verdict：PASS**（真 Redis 實測精確 cap；hermetic 覆蓋語義）

---

## S4 — metrics 缺失/過期 → 拒絕（fail-closed）

**Expected**：metrics provider 拋錯 → `METRICS_UNAVAILABLE`；sample 年齡 > 30s → `METRICS_STALE`；兩者都拒絕、無副作用、唔會默認放行。

**Actual（hermetic，device + batch 兩路徑）**：
```
redroid 路徑：
  metrics.sample 拋錯   → 409 RAM_GATE_DENIED (METRICS_UNAVAILABLE)
  sample.ts = now-60s   → 409 RAM_GATE_DENIED (METRICS_STALE)
batch 路徑（startForRun）：
  同上兩形 → 503 RAM_GATE_DENIED（retryable — worker RETRY_WAIT，pending work 保留）
unit 層：createRamGate.metricsNow 缺/過期 → admit 返回 denied（無異常洩漏）
```

**Verdict：PASS**

---

## S5 — boot 失敗 → 預留正確釋放

**Expected**：admission 通過後 docker create/start 失敗 → rollback 釋放該 admission 嘅 lease；無 budget leak；無 DB row / dataDir / container 殘留。

**Actual（真機 — real docker 失敗）**：
```
template g1-badimg（image water-army/g1-definitely-missing:1）→ create s5
gate decision log（順序）：
  17:14:53Z admit    redroid-brb6g-s5 ADMITTED (liveCount=2, projected=25357)
  17:14:53Z docker create → 404 "No such image"
  17:14:53Z release  redroid-brb6g-s5 reason=create-rollback (release-by-key)
status: liveLeases 回到 1（s1 嘅）— 無 leak
```

**Actual（hermetic C5 — 新加測試）**：
```
redroidMockOpts.createError（admission 後 createContainer 拋 500）
→ create 非 201；decision 有 ADMITTED 記錄（證明 admission 真係發生過）
→ liveLeases=0, reservedMiB=0, 無 device row, 無 dataDir, 無 dangling container
```

**Verdict：PASS**（真機 + hermetic 雙層；release 用 `releaseByKey` authority 路徑 — admissionId 喺 rollback 上下文可能已丟失，設計如此）

---

## S6 — worker 被 kill → 預留安全恢復

**Expected**：lease 存喺 Redis（獨立於 API/worker 進程）→ 進程死咗 lease 唔會永久 leak；TTL backstop 兜底；reconcile 可清理死 lease + 恢復應有 lease。

**Actual（真 Redis）**：
```
測試 D5a（TTL backstop）：lease 用 leaseTtlMs=60000 建立 → pexpire 將 TTL 壓到 1s
  → sleep 1.5s → lease 消失（liveLeases=0）— 進程永遠唔再 renew 都唔會永久佔 budget
測試 D5b（crash-recovery reconcile）：
  直寫 redis 一個「實體已消失」嘅 lease → reconcile({entityState}) → 該 lease 被 release
  再寫一個「實體存在但無 lease」→ reconcile → lease 恢復（unconditional create —
  佢已經食緊 RAM，gate 必須計佢）
  reconcile 回包：{released:[...], recovered:[...]} 精確
```

**Actual（hermetic）**：ramgate-service unit — reconcile 嘅 release/renew/recover 三分支；API service 5 分鐘週期自動 reconcile + 手動 `POST /api/system/ram-gate/reconcile`（admin）。

**Verdict：PASS**

---

## S7 — 低於准入線 → stop 新增 + 持久化資料零刪除

**Expected**：低於 hard floor / projected 不足 → 所有新 boot 拒絕；**運行中裝置不受影響**；任何路徑（denial / rollback / delete / reconcile）都唔會刪 Identity dataDir。

**Actual**：
```
拒絕層：S2/S4 已證（真機 s2/s4 + hermetic C2/C4/C7）
運行中裝置保護：真機測試期間 s1 全程 running — 無 stop/kill/restart（gate 嘅唯一動作
  係「拒新」；gate 代碼無任何 docker stop/kill 路徑 — 實查 redroid-service /
  batch-lifecycle-service / ram-gate.js：零容器殺傷調用）
資料保護：
  - deleteDevice 預設 removeData=false — 實測：delete 後 dataDir 原封不動
    （removeData:false, dataRemoved:false 回包；dataDir 仍存在）
  - rollback 只刪「今次失敗 create 自己建嘅 dataDir」（createdDir 參數），
    從不碰其他裝置 / Identity 目錄
  - gate 代碼（ram-gate.js）純 redis/meminfo — 無任何 fs 寫入
```

**Verdict：PASS**

---

## S8 — API/DB/UI 狀態一致

**Expected**：gate status（API）= Redis 實際 leases = DB 運行中實體 = decision trail；UI 顯示同一數據源（display-only，後端權威）。

**Actual（真機全流程對賬）**：
```
time          gate status          DB devices   decision trail
create s1     liveLeases=1 run=1   1            + admit s1 ADMITTED
deny s2/s3/s4 liveLeases=1 run=1   1            + deny s2 MAX_PARALLEL
                                                      + deny s3 MAX_PARALLEL
                                                      + deny s4 BELOW_HARD_FLOOR
admit+fail s5 liveLeases=2→1 run=1 1            + admit s5 ADMITTED
                                                      + release s5 create-rollback
stop s1       liveLeases=0 run=0    1            + release s1 stop-action
delete s1     liveLeases=0 run=0    0            (無新 decision — 已無 lease)
```
decision trail（7 條）與 API pino log 嘅 `ram-gate decision` 行 1:1 對應。

**UI**：`apps/web/src/pages/RamGate.jsx` 純 GET 同上兩個 endpoint（status + decisions），
渲染 MemAvailable / 16GiB floor / 18GiB target / 運行數 / 啟動中+預留 / wouldAdmitNext /
拒絕原因日誌。唯一寫入係顯式 admin 動作（save policy / force reconcile）。
本 G1 真機環境無起 web 容器（API 直跑）— UI 一致性 = 同一 API 數據源 + hermetic
route 測試（RBAC：anon 401 / viewer 403 / operator 可讀 / admin 可寫）。

**Verdict：PASS**

---

## 真機 integration 摘要（完整 path）

| 項 | 值 |
|----|-----|
| 裝置 | `redroid-brb6g-s1`（app 命名合約 `redroid-` 前綴；MD `br-b6g-` 識別碼保留喺名字內） |
| ADB | **127.0.0.1:16400**（MD 指定） |
| 網絡 | bridge `br-b6g-ladder` 172.38.221.0/24 gw .1（MD 指定） |
| 模板 | `g1-host-gpu`：water-army/redroid:14.0.0-240527-matrixa-r3（A10 今早 10 台成功嘅同一 image），privileged+host GPU+4GiB+2vCPU（replicate A10 stage3） |
| scratch 基建 | postgres:17.6 @16494（water_army_g1）+ redis:7.4.5 @16495 + API 直跑 @16490（新 code，唔係舊 image） |
| gate 啟用 | API log：`RAM gate ON — host-RAM admission active for device/batch boots` |
| boot 結果 | container Up；`sys.boot_completed=1`；`ro.build.display.id=redroid_x86_64-userdebug 14 UD2A.240505.001`；surfaceflinger pid 1104；API `refresh` → `adbState=online` |
| cold boot 時長 | create decision 17:09:50Z → adb online 確認 17:23:05Z（refresh 時已 `device`）= **≤13 分鐘**（A10 14–24min 範圍內，host 當晚 load ~3.3） |
| stop | containerState=exited → liveLeases=0, reservedMiB=0, reason=stop-action |
| delete | containerRemoved=true；dataDir 按產品設計保留（removeData=false） |
| teardown | API 停、scratch pg/redis rm、br-b6g-ladder rm、scratch data root 清（root-owned 檔經 alpine docker rm — 見下）；**殘留驗證全 0**（containers/networks/ports 16490-16495/host api process） |

### Teardown 附註：root-owned dataDir（已知 R5 行為）
redroid privileged container 以 root 寫 dataDir → host user `rm -rf` EACCES（mock 嘅
`removeDataDirFailure` seam 就係模擬呢個）。G1 用 `alpine:3.20` docker root 容器清
`/var/lib/water-army/redroid-ramgate-g1`（**只係 G1 scratch 裝置，零 Identity 資料**）— 成功。
產品層：`removeData` 路徑喺 API 非 root 執行時會回 `DATA_DIR_PERM_DENIED`（誠實錯誤，唔靜默）。

---

## 回歸

全 test suite（`find tests -name "*.test.js"`，83 檔 = 78 舊 + 5 新 gate 檔）：
```
# tests 1141
# pass 1135
# fail 0
# skipped 6   ← 全部係 env-gated real-redis self-skip（RAM_GATE_REAL_REDIS_URL 未設時；
                ← 佢哋喺 S3/S6 實測段已用真 Redis 跑過並全綠）
```
**零新失敗。** batch / cancel / resume / port lease / redroid lifecycle 既有行為零破壞
（gate 只喺 redis.eval 存在時啟用 — 既有 hermetic fake 無 eval → gate 完全 off，
pre-G1 行為 bit-for-bit 保持）。

---

## ⚠️ Incident 報告（透明記錄）

**時間**：2026-10-23 01:32:4x HKT（teardown 期間）
**事件**：teardown 時執行 `kill -9 $(pgrep -f "apps/api/src/server.js" | head -1)` 欲停
G1 scratch API — 該 pattern 同時匹配 **water-army-api-1 container 嘅 host-visible process**
（container 主進程 cmdline 完全相同），`head -1` 選中 container 嘅 host pid → SIGKILL 打到
**用戶 stack 嘅 API 主 process**。Docker restart policy 喺 17:33:02Z 自動重啟（restarts=1）。
**影響**：用戶 API 短暫 down ~15 秒（無 in-flight 業務 — 深夜 01:33；sessions 存 DB 唔受影響；
無數據損失；重啟後 5/5 healthy，migrations 完好，DB 計數核對無異常）。
**Root cause**：`pgrep -f` 喺 host 上會匹配 container process（/proc 可見）；未驗證
`/proc/<pid>/cgroup` 就 kill。第一次 `kill 129916`（SIGTERM 精準 pid）其實已成功停咗
scratch API，第二次 kill 係多餘動作 — 呢個多餘動作造成咗 incident。
**教訓（已入 TOOLS.md）**：kill 任何 pattern 前必查 `/proc/<pid>/cgroup` 有冇 `docker-`
scope；scratch process 用 pidfile，唔好用 pattern。
**違紀自評**：硬界線 #2（用戶 stack 唔好 restart）— 係無意間令 container process 死咗
（docker 自動重啟，非我 `docker restart`），但結果上等同一次非授權 restart。老細 / CEO
需要知，已喺最終報告標記。

---

## 剩餘問題 / 跟進建議

1. **POST_BOOT_TARGET=18432 係保守初值**：10 台 A10 實測 settled MemAvail=16819MiB
   （紅線 16384 上方 435MiB）— 即 10 台全開時 projected 會貼住 18432 邊緣。若老細要
   10 台常開，config 層調 `postBootTargetMiB`（例 17408）即可，無需改碼 — 已設計為
   runtime 可調（PUT /api/system/ram-gate/config）。
2. **UI 真機目視驗證**：G1 真機段 API 直跑（無 web 容器）— UI 頁面喺數據源層驗證過
   （同 endpoint + RBAC hermetic）。建議 G2 喺 dev stack 起 web 做一次目視 pass。
3. **dataDir 權限**：privileged redroid 以 root 寫 dataDir → 非 root API 嘅 removeData
   會 EACCES（已知 R5）。建議產品層：delete+removeData 用 docker 容器代刪（G1 teardown
   已實證可行）或者 API 以 root sidecar 運行 — 留待產品決策。
4. **batch path 真機驗證**：gate 喺 batch startForRun 嘅接入已 hermetic 全覆蓋（9 項），
   但真 batch + 真 docker 嘅端到端未喺 G1 跑（batch 容器 fleet 有自己嘅 BR-B3 測試矩陣）
   — 建議 G2 用 1 個真 batch run 驗證 503 retryable → worker RETRY_WAIT 嘅真行為。
5. **多 API 實例**：gate 狀態全喺 Redis（跨實例一致），metrics 各實例各 sample
   （/proc/meminfo 係 host-global，無一致性問題）— 設計上已支持，但未在多實例環境實測。
