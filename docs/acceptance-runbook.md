# 驗收 Runbook — 從零開始逐步驗證（T6，J0–J9）

**老細口徑（2026-10-27 14:20/14:23/14:36）**：驗收 = 喺純淨環境**由零逐步行**，確保**每個使用流程都順利**，模擬真實使用。使用面定調：**FB / IG / Threads = Chrome 瀏覽器操作；Gmail = App 長期登入錨點（日後其他平台用 Google 帳號登入）；WhatsApp 出局**。

**驗收通過定義（唯一口径）**：J0–J9 **全部判定 `passed`** 先算產品驗收過。任何一個 J 係 `implemented-unverified`／`known limitation`／`deferred` ⇒ 驗收未過，須照判定分類如實記錄（誠實紀律：唔准將 mock/代碼層實證當真機 passed）。

## 判定分類（每個 J 結尾必填，四類之一）

| 判定 | 意義 |
|------|------|
| `passed` | 喺本 runbook 指定環境真行真驗，證據齊（logs/acceptance/<J>/ 有物）|
| `implemented-unverified` | 代碼＋mock/CI 層已驗證，但真機／真環境未行過 |
| `known limitation` | 已實施但有已知限制，限制本身被接受並記錄 |
| `deferred` | 本期唔做，明確擱置 |

## 總覽

| 段 | 名稱 | 自動化腳本 | 人工成分 |
|----|------|-----------|---------|
| J0 | 純淨環境 | `scripts/acceptance/j0-reset.sh` | 合併 image ref 拍板 |
| J1 | Provisioning 10 身份 | `j1-provision.sh` | 無 |
| J2 | 開機 + 指紋 probe 逐字段斷言 | `j2-boot-probe.sh` | probe.apk 真機段 |
| J3 | GMS(MTG) + Gmail App 人工登入（錨點） | `j3-gmail-anchor.sh`（核驗端） | 人工登入 |
| J4 | Chrome 裝機 + FB/IG/Threads 人工登入 | `j4-chrome-login.sh`（核驗端） | 人工登入 |
| J5 | 一日自動化任務日 | `j5-task-day.sh` | 介入處置照單 |
| J6 | 出口斷言（每身份獨立 IP，W3） | `j6-egress-assert.sh` | 真機 canary 段 |
| J7 | 容器回收＋重建＋登入態/數據保留 | `j7-rebuild-retention.sh` | 目視 App 態（真機）|
| J8 | 24h 浸泡（損耗/風控訊號） | `j8-soak.sh` | 觀察記錄表 |
| J9 | Teardown 零殘留 | `j9-teardown.sh` | 無 |

**Mock dry-run（CI 可跑、唔使真機）**：`tests/integration/acceptance-journey-mock.test.js` 用 fake db + mock redroid adapter 將 J1（provisioning 冪等+fingerprint）、J5（device 生命週期+stream lease+人工介入+task run 流轉）、J7（回收重建+claim/dataDir 保留語義）全套狀態流轉跑通 — 呢啲係**代碼層證據**，J 段真機判定唔可以靠佢升 `passed`。

## 通用紀律（所有腳本）

- **環境**：`WA_API_URL`（默認 `http://127.0.0.1:3000`）、`WA_ACCEPT_ADMIN_USER` / `WA_ACCEPT_ADMIN_PASS`、`WA_ACCEPT_OP_USER` / `WA_ACCEPT_OP_PASS`（env 传入，**secrets 禁令：唔准寫入 repo/腳本/evidence**）。
- **證據位置**：每步 evidence 自動落 repo `logs/acceptance/<Jn>/`（timestamped JSON + `verdict.txt`）；失敗自動收集診斷包 `diagnostics/`（docker ps、health、audit events、相關 GET dump）。
- **冪等**：所有腳本可重複跑；provisioning/device create/batch 全部用 idempotencyKey；斷言用「目標態」而非「一次性副作用」。
- **防假紅**：先 warm（`/health/live` 輪詢就緒 + ready check + 首个請求預熱）先開始斷言；所有等待有界（超時 = FAIL + 診斷包，唔會無限 hang）。
- **用戶 stack 零動**：接受測試資源全部用固定前綴 — device/identity 名 `redroid-acc-*`（匹配 provisioning 名字正則 `^redroid-[a-z0-9][a-z0-9_-]{0,39}$`）；腳本只操作呢個前綴，杜絕碰 `rdev-*`／scratch／用戶容器。
- **串行**：一次只跑一個 J 段（同 Kairo 串行紀律）；J8 浸泡除外（佢本身就係長駐觀察）。

---

## J0 — 純淨環境（from-zero gate）

**前置**
- GMS PoC（MTG 變體）**已通過**（老細拍板 2026-10-27：合併 image 前組件 PoC 全過先准行 J 段；OG 線永久 skip）。PoC 證據 = `docs/` GMS 報告 + workspace `logs/waterarmy-t3-gms-*`。
- 最終合併 artifact image ref 已拍板（pinned tag，非 latest）。
- 全新 DB + fleet：docker compose project `water-army` 可完全重建（本機其他 stack — SGLang、rdev-* 等 — 唔准受影響）。

**操作**
```bash
export WA_IMAGE_REF=<合併後 pinned image ref>   # 例 redroid/wa-merged:<tag>
scripts/acceptance/j0-reset.sh
```
腳本做：① `docker compose -p water-army down --remove-orphans`（project-scoped，唔係全局）；② 清 project volume（`docker volume rm` 只限 project label 嘅 volume）；③ `up -d` + migrate；④ 驗證 DB 係空（identity/device count = 0）；⑤ image ref fail-fast（未 export / 無 tag = 400 級拒絕，唔准默默用舊 image）；⑥ host preflight（runbook §9.3 權威面）+ RAM-G1 `wouldAdmitNext` 檢查。

**期望**
- `/health/ready` = 200（db/redis up）；`GET /api/identities?pageSize=1` total=0；`GET /api/redroid/preflight` 無 FAIL item；`GET /api/system/ram-gate` `wouldAdmitNext.admitted=true`。
- 用戶 stack 驗證：腳本結尾 dump `docker ps` 確認 SGLang/rdev-* 容器狀態同 reset 前一致（before/after 對比落 evidence）。

**證據**：`logs/acceptance/j0/`（pre-snapshot、reset log、post-verify JSON）。

**判定**：真機環境行過 → `passed`；淨 CI/mock → `implemented-unverified`。

---

## J1 — Provisioning 10 身份（冪等）

**前置**：J0 passed。

**操作**
```bash
scripts/acceptance/j1-provision.sh            # 建 redroid-acc-01..10
scripts/acceptance/j1-provision.sh            # 再跑一次 = 全部 replayed（冪等實證）
```
腳本做：admin session → `POST /api/identities/provision {names:[redroid-acc-01..10], identityType: qa_device, egressIps?}`（egress IP 可選；真機段每身份一條獨立出口 IP，格式 `203.0.113.x` 測試段或實際 IP）→ 斷言 10 條 `created`（第二輪 = 10 條 `replayed`、`created=0`）→ 逐身份 `GET /api/identities/:id/fingerprint` 斷言 determinstic profile 已 auto-ensure（ADR-028 鏈）→ `GET /api/identities/fingerprints/collisions` 斷言 `blocking:false`。

**期望**
- 10 身份全部存在、`suggestedDeviceName` = name（1:1 可推導口徑）；loginState 初始 = `PENDING_LOGIN`（`GET /api/identities/:id/login`）。
- 重複 provision 零重複建行（冪等）。

**證據**：`logs/acceptance/j1/`（provision 回應、逐身份 login/fingerprint GET dump、collisions report）。

**判定**：mock 層已有 CI 證據（acceptance-journey-mock + t2-login-provision）；真機 DB 行過 → `passed`。

---

## J2 — 開機 + 指紋 probe 逐字段斷言

**前置**：J1 passed；合併 image（含 GMS/MTG 變體）已 pull 到 host；template 已建（腳本會建 `wa-acc-tpl`，admin）。**RAM gate**：10 台 boot 前照 `GET /api/system/ram-gate` 檢查，不足則分批 start（腳本逐台 start + `RAM_GATE_DENIED` 時 wait & retry bounded）。

**操作**
```bash
scripts/acceptance/j2-boot-probe.sh
```
腳本做：① 建/複用 template（image = `$WA_IMAGE_REF` pinned）；② 逐身份 `POST /api/devices/redroid {name: <suggestedDeviceName>, templateName, identityId, idempotencyKey}`（帶 identityId → dataDir claim 生效）；③ `POST /:id/start` 循環等到 `adbState=online`（有界超時；boot ~24min 實測常態，超時上限用 `REDROID_TUNNEL_BOOT_TIMEOUT` 語義 40min）；④ 裝 probe-app（`probe-app/build.sh` 產物 `probe.apk`）→ `am instrument` dump → 拉返 dump JSON；⑤ `GET /api/identities/:id/fingerprint` 攞 expected profile → 復用 **W1b probe-assert 鏈**（`scripts/w1b/probe-assert.mjs`，斷言 kernel = `packages/shared/src/w1b-consistency.js`）逐字段斷言，exit code 直接入 verdict；⑥ 指紋跨身份唯一性 ground-truth：10 份 dump 互相比對（同 machine-id/serial 等唯一位唔准撞）。

**期望**
- 每台 device `GET /api/devices/redroid/:id`：running + adbState=online + dataDir 存在。
- probe-assert VERDICT = PASS（strict 字段全過；L2 NOTE 層照記錄唔阻斷 — L2 收口屬 W1b 軸）。
- 零跨身份指紋碰撞。

**證據**：`logs/acceptance/j2/<device>/`（dump JSON、expected profile、probe-assert 完整輸出）+ `j2/verdict.txt`。

**判定**：probe 鏈代碼層 `passed`（W1b 已有真機證據）；**合併 image 上**逐字段 PASS = 本段目標 — 行過先 `passed`，否則 `implemented-unverified`。

---

## J3 — GMS(MTG) + Gmail App 人工登入（長期錨點）

**語義**：Gmail = **App** 長期登入錨點（老細 14:36 拍板；日後其他平台用 Google 帳號登入 — 錨點斷 = 全組風險訊號）。本段係 **login_state 人工確認流**嘅首次真機實測：寫入路徑只係 operator session（probe/worker/AI 永遠唔准斷言登入真相）。

**前置**：J2 passed；每台已開機設備 GMS 可用（Play 可入 — J0 PoC 前置嘅延续）；每身份 Gmail 憑證準備好（凭證輸入走人工面，**零 secrets 入系統**：evidence 欄位唔准寫 credential 形狀字樣，服務層 400 守門）。

**人工操作（人做，照清單逐台）**
1. 經 Stream Console（`POST /api/devices/redroid/:id/streams {mode:controller}` → WS 串流）以 controller 進入設備。
2. 打開 Gmail **App** → 用該身份 Google 帳號完成登入（含 CAPTCHA/2FA 人工處理）。
3. 確認收件箱可用、App 唔要求重登入。

**核驗端（腳本核結果）**
```bash
scripts/acceptance/j3-gmail-anchor.sh            # 斷言：操作已完成 + 狀態流正確
scripts/acceptance/j3-gmail-anchor.sh --mark     # 人工確認後执行转移（operator session）
```
斷言鏈：初始 `PENDING_LOGIN` → `--mark` POST `/api/identities/:id/login/transition {to:CONFIRMED_LOGGED_IN, evidence:"J3 manual Gmail app login <date>"}` → 200；`GET .../login/audit` 有 fromState/toState/actorUserId 審計行；**非法轉移拒**：對同一身份重複 `CONFIRMED_LOGGED_IN→CONFIRMED_LOGGED_IN` 斷言 409 `INVALID_LOGIN_TRANSITION`（self-transition = bug 語義）；evidence 帶 credential 形狀字樣斷言 400。

**期望**：10 身份全部 `CONFIRMED_LOGGED_IN`、審計齊、409/400 契約真機重現。

**證據**：`logs/acceptance/j3/`（逐身份 transition/audit dump、人工檢查清單 sign-off）。

**判定**：人工登入 + 串流真機行過 → `passed`；login_state 狀態機本身 mock 已釘死（t2 測試）。

---

## J4 — Chrome 裝機 + FB/IG/Threads 人工登入（瀏覽器 = 日常操作面）

**語義**：FB/IG/Threads 全部經 **Chrome 瀏覽器**操作（老細定調；WhatsApp 出局）。Web session 數據 = dataDir 內資產（J7 保留實證嘅對象之一）。

**前置**：J3 passed；合併 image 內有 Chrome（無 → 經人工 sideload APK，記錄來源 version 入 evidence，唔入 secrets）。

**人工操作（每身份逐台）**
1. Console controller 開 Chrome。
2. FB：用該身份帳號登入（可先用 J3 Gmail 錨點走 Google 登入路徑）→ 確認 feed 可刷。
3. IG：`instagram.com` 瀏覽器登入 → 確認 timeline。
4. Threads：`threads.net` 登入（IG 帳號連動）→ 確認可貼文/睇 timeline。
5. 每台每平台截圖或目視確認登入態（session 落 dataDir）。

**核驗端**
```bash
scripts/acceptance/j4-chrome-login.sh            # 核：設備 online、adb 層檢查 Chrome package 存在 + cookie 檔存在
scripts/acceptance/j4-chrome-login.sh --signoff <identity> --platform fb|ig|threads
```
`--signoff` 將人工確認寫入 evidence（本地 sign-off 檔 + 可選 handoff 到 manual-intervention `operator_report` closed 記錄 — 用 category `acceptance`，**唔該事件做登入斷言**，登入斷言靠人工 sign-off + adb 層 package/cookies 檢查）。

**期望**：10 身份 × 3 平台 sign-off 齊；adb 層斷言 Chrome package 存在、`/data/data/com.android.chrome/app_chrome/Default/Cookies`（或等義路徑）非零（真機校準：路徑以實際 image 為準，校準結果回填呢度）。

**證據**：`logs/acceptance/j4/`（sign-off matrix、adb probe dump）。

**判定**：真機行過 → `passed`；Cookies 路徑探測若因 image 變體未能釘死 → `known limitation`（記錄實際路徑）。

---

## J5 — 一日自動化任務日（tasks / leases / console 串流 / 人工介入全部真路徑）

**語義**：模擬真實使用 = 一日入面自動化任務照跑、真人隨時可以落場。全部行**真路徑**（真 worker、真 BullMQ、真 Redis lease、真 stream 串流）。

**前置**：J4 passed；worker 運行；AI provider 已配（真 provider 或受控 mock — provider 選擇寫入 evidence；mock provider = 本段自動化面只計 `implemented-unverified`，真 provider + 真設備操作先 `passed`）。

**操作**
```bash
scripts/acceptance/j5-task-day.sh
```
腳本做（全部真 API 路徑）：
1. **排程 + 任務**：`POST /api/task-definitions`（若 seed 已有可用 definition 則複用）→ `POST /api/schedules {scheduleType:"interval", intervalMs:10m, overlapPolicy:"skip_if_running"}` → `POST /api/schedules/:id/run-now`（帶 Idempotency-Key）→ 輪詢 run 至 terminal（有界）→ `GET /api/tasks/runs/:id/events` 事件流落盤。
2. **Lease/容器流轉**（batch lane）：建 acceptance batch（`POST /api/batches`，10 身份、`idempotencyKey`）→ preview 斷言與 create 一致 → start → `GET /api/batch-containers` 觀察 active lease → `containers/stop`（可逆）→ 再 start → `containers/remove`（volume-retention 語義）→ reconcile `fix=true` 斷言零 orphan。
3. **Console 串流抽檢**：任揀 3 台 `POST /api/devices/redroid/:id/streams {mode:"viewer"}` → GET lease → heartbeat → DELETE（viewer read-only 契約：input frame → `STREAM_READ_ONLY` — 真機 WS 段照 runbook §串流驗證手動補）。斷言 capacity 計數返回正常。
4. **人工介入真路徑**：`POST /api/manual-interventions {source:"operator_report", category:"acceptance", title, deviceId}` → acknowledge → assign → resolve（帶 note）→ 審計行齊；重複 signal = `created:false signalCount++`（dedupe 實證）。
5. **日終盤點**：`GET /api/dashboard/summary` + `GET /api/batches/metrics` 快照（alert 清單入 evidence — 有 critical = 本段 FAIL）。

**期望**：所有 run 最終 terminal 且零 `failed`（同一次輸入重試成功計 retry，最終態話事）；lease 全部釋放無殭屍；介入工單閉環；metrics 無 critical alert；`network_health_failures_total` 增量有解釋（每筆對到介入單/episode）。

**證據**：`logs/acceptance/j5/`（run 事件流、batch 狀態快照、lease 列表、介入單 timeline、metrics 快照）。

**判定**：真 worker+真設備行過一日 → `passed`；淨 mock adapter（CI dry-run 覆蓋嘅流轉部分）→ `implemented-unverified`。

---

## J6 — 出口斷言（每身份獨立 IP，W3 語義）

**語義（W3/ADR-027）**：每身份一條 **pinned 出口 + 唯一 exit IP**；binding 係 fleet 級 DB unique；零 credential 海面（回應只有 expected IP + hash prefix）。

**前置**：J2 passed；template/device 帶 proxy（socks5 pinned，每身份一條獨立出口）；`WA_W3_EGRESS_BINDING_ENABLED=true`（未開 = 503 `EGRESS_BINDING_DISABLED` fail-closed，本段唔准默默跳過）。

**操作**
```bash
scripts/acceptance/j6-egress-assert.sh
```
腳本做：① `GET /api/identities/egress` fleet 列表：10 條 binding、`expectedEgressIp` 兩兩唔同（獨立性代碼層斷言）；② 逐 device `GET /api/devices/redroid/:id`：`proxy.network.state=HEALTHY` + `networkReady:true` + `stale:false`（權威投射，唔准自行推算）；③ **data-plane 真出口**（真機段）：經 Stream Console/adb 喺設備內行 netcheck（復用 `scripts/br-b6-egress/common.sh` 嘅 EXACT 平台 netcheck script `buildT2sNetcheckScript` 鏈）→ canary 見到的 src IP = 該身份 binding 嘅 expectedEgressIp（逐身份比對表）；④ fail-closed 抽檢：殺一台 tunnel（`proxy/retry` 前嘅 BLOCKED 窗口）→ netcheck 應見零直連（`--internal` 網絡語義，BR-B6 C4 方法）→ `POST /:id/proxy/retry` 恢復 → 斷言回 HEALTHY 經 VERIFYING（從無盲信）。

**期望**：10/10 身份：binding 唯一 + networkReady + 實測出口 IP == expected；故障窗口零洩漏；恢復路徑合法。

**證據**：`logs/acceptance/j6/`（binding 表、netcheck per-identity 結果、故障窗口 canary log、audit 轉移鏈）。

**判定**：真機 data-plane 行過 → `passed`；淨代碼層（binding 唯一性 + state machine 有 CI 釘死）→ `implemented-unverified`；nft per-counter 變體需 root = 照 BR-B6 口徑 `known limitation`（服務帳號冇 CAP_NET_ADMIN）。

---

## J7 — 容器回收 + 重建 + 登入態/數據保留實證

**語義（T2/ADR-029 claim 契約）**：預設 delete 保 dataDir + claim；同身份 re-claim 放行（stop→remove→rebuild 保留 /data 正正係契約用途）；他身份同 dir = 409 `DATA_DIR_CLAIM_CONFLICT`；`removeData=true` 先 release。

**前置**：J5 完（設備有使用痕跡：Chrome cookies / Gmail 登入態）。

**操作**（抽 3 台：A=保留重建、B=跨身份衝突、C=removeData）
```bash
scripts/acceptance/j7-rebuild-retention.sh
```
腳本做：
- **A（保留重建）**：device A stop → DELETE（預設，斷言 `dataRemoved:false, claimReleased:false`）→ 同 identityId recreate 同名 → 201 + claim re-claim 放行 → 開機後人工核：Gmail App 仍登入、Chrome FB/IG/Threads session 仍在（登入態 = dataDir 資產實證 — 呢步係「模擬真實使用」嘅核心證據）。
- **B（衝突）**：device B DELETE（保留 dir）→ 用**另一個 identity** 建同名 device → 409 `DATA_DIR_CLAIM_CONFLICT`（跨身份 /data 繼承 = 污染，fail-closed 實證）→ 原身份 recreate 放行。
- **C（徹底清除）**：device C DELETE `removeData=true` → 斷言 `dataRemoved:true, claimReleased:true` → data dir 唔喺 → 任何身份重建 = 全新環境（人工核：Gmail 未登入）。
- 全程 host 層斷言 dataDir 路徑存在/消失（path = API `device.dataDir`，realpath-scoped）。

**期望**：三條路徑語義全部如契約；登入態保留/清除同預期一致（人工 sign-off + adb 層 Cookies 檔案存在性雙重證據）。

**證據**：`logs/acceptance/j7/`（delete/recreate 回應、claim 狀態、人工 sign-off、dir 存在性探測）。

**判定**：真機行過 → `passed`；claim 契約代碼層已有 CI（t2 場景 3）+ mock dry-run → `implemented-unverified`。

---

## J8 — 24h 浸泡（損耗/風控訊號記錄表）

**前置**：J7 passed；10 台保持運行 + 排程照跑（J5 嘅 interval schedule 唔好停）。

**操作**
```bash
nohup scripts/acceptance/j8-soak.sh --hours 24 --interval-min 15 &
```
腳本做：每 `interval-min` 採一次快照 → `batches/metrics`、`dashboard/summary`、`manual-interventions?status=open`、逐 device `proxy.network` 摘要 + `adbState`、RAM gate 狀態；自動生成 `soak-table.md`（時間 × device 健康矩陣）+ 訊號汇总（network episode 計數、adb offline 事件、RAM deny、alert fire/clear）。

**人工觀察記錄表（逐日手填，模板自動生成到 `logs/acceptance/j8/observations.md`）**：

| 身份 | 平台 | 風控訊號（capcha/驗證/限流/異常彈窗） | 損耗（帳號 DEAD/降權） | 處置 | 結果 |
|------|------|------------------------------------|----------------------|------|------|

**期望（通過線）**：24h 內：無未解釋嘅 terminal FAILED network episode；adb offline 有界且可恢復；零 RAM gate deny（或每筆有容量解釋）；風控訊號有記錄（有訊號唔等於 FAIL — **未記錄先係 FAIL**；損耗率紀律：每個帳號死亡必帶 failureCode + 審計鏈，缺碼 = 記錄缺損 = 驗收未夠）。

**證據**：`logs/acceptance/j8/`（snapshots/、soak-table.md、observations.md）。

**判定**：24h 真跑 + 記錄表齊 → `passed`；短浸泡（<24h）只能 `known limitation` 如實記錄。

---

## J9 — Teardown 零殘留

**前置**：J8 記錄表歸檔完成（先 copy 去 `logs/acceptance/j9/archive/`）。

**操作**
```bash
scripts/acceptance/j9-teardown.sh
```
腳本做（只碰 `redroid-acc-*` 前綴 + project `water-army`）：① 停/刪 acceptance devices（逐個 DELETE admin，需保數據嘅照流程先 archive 表）；② purge（dryRun 先行，confirm token = identity id）抹 acceptance identity data dir；③ schedule/batch/task-def 清理（pause→delete）；④ `batch-containers/reconcile fix=true` 零 orphan；⑤ 殘留斷言：`GET /api/identities` 零 `redroid-acc-*`、device list 零、`docker ps -a` 零 `wa-acc-*`/project 內 acceptance 容器、dataRoot 目錄零；⑥ 用戶 stack 對比：SGLang/rdev-*/用戶容器同 J0 pre-snapshot 一致。

**期望**：零殘留 + 用戶 stack 零動（前後對比證據）。要彻底還原裸 host：最後一步 `docker compose -p water-army down --remove-orphans -v`（自選，記錄喺 evidence）。

**證據**：`logs/acceptance/j9/`。

**判定**：行過 → `passed`。

---

## 附 A — Mock dry-run（CI，唔使真機）

`tests/integration/acceptance-journey-mock.test.js`（入 full suite）：
- **J1**：provision 10 身份冪等 + fingerprint auto-ensure + login 初始態；
- **J5**：device 生命週期（create→start→stop→remove volume-retention）+ stream lease create/heartbeat/close + manual-intervention 閉環（acknowledge→assign→resolve + dedupe signalCount）+ task-run 流轉；
- **J7**：三條路徑（保留重建 re-claim / 跨身份 409 / removeData release）全語義。

口徑：mock dry-run 保「代碼契約未漂移」，**唔產生 J 段 `passed` 資格**。

## 附 B — 真機段排程

真機執行 = 併入 qwen27B 真機批最後一關（組件 PoC 全過 → 合併 image → J0–J9 一舊過）。本 runbook + 腳本 = 代碼段交付；真機段照單執行並回填判定。
