# WA-REALDEVICE-FINAL — Final Report（真機收口總報告）

- **工單**：`logs/waterarmy-realdevice-final-workorder.md`（workspace）
- **Kairo**：`mvs2iknd60sig`（subtasks p0/p1/p2/p3 全 done）
- **執行**：gen1（run `551e1e98`，20:07–22:55 HKT，22:55:57 run-crash）+ **gen2 接力**（23:09 接手 → 2026-10-29 00:35 HKT 收口）
- **範圍**：P0 環境基線 → P1 單機全流程（MTG 真機）→ P2 批次真機（3 容器 + ground truth + 介入流 + 報告導出）→ P3 拆除 + 報告 + release-status 同步
- **證據約定**：`docs/audits/realdevice-final/p{0,1,2,3}/`（repo 內，git 追蹤）；執行機原檔 `logs/realdevice-final/p{0,1,2,3}/`（gitignored，向 CEO 索取）。**全部真機/真輸出，零 mock 混入**；mock 跡跡（如 hermetic probe seam）只出現於 finding 分析段。

## 0. 總判定

| Phase | 判定 | 一句話 |
|---|---|---|
| P0 環境基線 | **PASS** | 7 PASS + 2 記錄限制（api 無 adb = runbook §270 已知設計；W3 switch off = 503 fail-closed by design）+ 2 拓撲事實。`p0/p0-summary.md` |
| P1 單機全流程 | **PASS**（2 項 KNOWN LIMITATION 照實） | redroid-rdfa-01（MTG 真容器）建機→健康→指紋→egress→APK→live view→gate 八步全真跑；指紋 = KL（MTG 缺 oem-propctl 解碼器）、live view = 結構性受限（api 無 adb 無幀源） |
| P2 批次真機 | **COMPLETE + 決定性產品 finding** | 交付物全出（3 容器真起、GT、介入流練到產品 bug 邊界、報告 JSON/CSV + secret scan + 5 分鐘穩定）；「run 完成→resolve」半環喺現 build 對真機**結構性不可達** = **F-RDFA-2**（probe netns + wire protocol 雙重失敗），v4–v9 六連敗全根因坐實，v10 判定 = 重複撞同一面牆（循環），ABORT batch 路線 |
| P3 拆除/收口 | **PASS** | redroid-rdfa-* 容器/行/data 全清、wa-batch 殘留 3 台清、gate leases 回預 ticket baseline（1）、禁碰集零觸碰、report + release-status 同步 + 全套件零回歸 + secret scan |

**Findings（產品級，移交開發單）**：

| ID | 嚴重度 | 內容 | 證據 |
|---|---|---|---|
| **F-RDFA-1** | high | `POST /api/batches` 對 `config.adapter` 只驗 `type:'object'` 不驗形狀；`createCycle` **從不調用** `validateBatchConfig`（生產路徑零調用點，shared constants 註釋「validated at API boundary AND re-checked by worker」= stale）→ malformed spec（字串 `"container"`）create 201 放行、dispatch 時 `adapterSpecForRun`（batch-lifecycle-service.js:344）409 `RUN_STATE_INVALID` → 全批 attempt-1 即 FAILED_FINAL | p2-35、DB task_runs error_message、源碼批次註釋 |
| **F-RDFA-2** | high（blocking） | batch `adb-tcp` health probe 喺 as-deployed topology 對真 redroid **永遠過唔到**，雙重根因：**2a netns** — probe 喺 api 容器（bridge netns `water-army-platform`）探 `127.0.0.1:<hostport>`，但 ADB port binding 發布喺 **host loopback** → 實測 ECONNREFUSED（EXP C：host 同端口 TCP 通、api netns 拒連）；**2b protocol** — probe 發 bare `000chost:version`（batch-lifecycle.js:308）無 ADB wire protocol 強制嘅 CNX 首包 → 真 adbd **零字節回應**（EXP A），同刻同端口真 adb client（CNX 握手）完全服務。hermetic probe seam（app.js:220 註釋自認「no container in the test host」）→ 測試套件全數 canned probe，真 probe 從無真機驗證 = mock/real 分歧完美案例 | p2-55（EXP A/C/D 原始 byte 記錄）、p2-43、p2-52 |
| **F-RDFA-3** | medium | health window / client timeout 嘅 code default 係 mock-calibrated（api `batchContainerHealthTimeoutMs` default 60s；worker `CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS` default 120s < api window → v8 304 double-fail 形態）。本單已用 env 300s/300s 治標（管理員配置清單，P3 留原狀待老細）。F-RDFA-2 修復後窗口建議 ≥180s 且 worker client ≥ api window | p2-43（120s TOOL_TIMEOUT 實測）、p2-29、p2-48 |

**照實保留（唔升 PASS）**：指紋 ro.* 定製（MTG 缺 oem-propctl = KL）、live view（api 無 adb 無幀源 = 結構性）、UI Batch Planner 無 adapter/template 配置入口（gap，container batch 只可走 API）。

---

## 1. P0 環境基線（2026-10-28 20:07–20:27 HKT，gen1）

| 步 | 操作 | 真輸出 | 斷言 | 結果 | 證據 |
|---|---|---|---|---|---|
| P0.1 | RAM gate 基線 | available≈43G；hardFloor 4096/target 5400；liveLeases=1；admitted=true（projected 42351MiB） | MemAvailable≥hardFloor；gate enabled；wouldAdmitNext=true | **PASS** | p0/p01-ram-gate.txt |
| P0.2 | MTG image 核 | `water-army/redroid:14.0.0-240527-gms-mtg` sha256:02ab56…4ecee（3.69GB） | image 在 + SHA 記錄 | **PASS** | p0/p02-image-dataroot.txt |
| P0.3 | data root 核 | /var/lib/water-army uid=1000 drwxr-x--- | uid/perm 符合 | **PASS** | p0/p02-image-dataroot.txt |
| P0.4 | gost 18443 出口 | ipinfo.io 200，egress=103.194.185.206（Netsec HK） | 過 gost 出口 IP 記錄 | **PASS** | p0/p03-gost.txt |
| P0.5 | 宿主真直連出口 | `env -i` 排除 shell `http_proxy=7897` 陷阱後 = 27.45.51.73 ≠ gost 出口 | 真直連 IP 記錄且 ≠ gost（IP 判據 P1 可用） | **PASS** | p0/p03-gost.txt（CORRECTION 段） |
| P0.6 | 基線容器 | 水軍 5 容器 healthy；redroid-rdfa-* = 0；禁碰集 {rdev-f1, redroid-mc-dogfood-2, rdev-e1-gost} 在檔 | 基線乾淨 + 禁碰機記錄 | **PASS** | p0/p04-docker-baseline.txt |
| P0.7 | ADB 基線 | platform-tools 37.0.1 / adb 1.0.41；devices 空 = 基線；PATH 無 adb 已記錄 | host canonical adb 可用 | **PASS** | p0/p05-adb.txt |
| P0.8 | 拓撲限制① | api 容器無 adb binary | runbook §270 已知設計 → 真驗證用 host adb | **記錄限制** | p0/p06-topology.txt |
| P0.9 | 拓撲限制② | `WA_W3_EGRESS_BINDING_ENABLED` 未設（default false） | fail-closed by design → W3 表面 503；egress 機制以文檔化手動路徑真機驗 | **記錄限制** | p0/p06-topology.txt |

判定：**環境基線成立，可進 P1。**（另有 2 拓撲事實：W1 ro override ACTIVE since 10-27；MTG 模板 + identity 1 READY。）

---

## 2. P1 單機全流程（redroid-rdfa-01，MTG，20:33–20:55 HKT，gen1）

| 步 | 操作 | 真輸出 | 斷言 | 結果 | 證據 |
|---|---|---|---|---|---|
| P1.1 | API 建機（identityId 綁定 + roOverrides 12 項） | 容器 redroid-rdfa-01 Up；identity 綁定落庫 | 建機成功 + identity 綁定 | **PASS** | p1/（28 件） |
| P1.2/3 | 健康 + boot | host adb `boot_completed=1` @~10s；平台 adb 面 = ADB_UNAVAILABLE（拓撲限制①） | boot 真完成 | **PASS**（平台面照實記錄） | p1/p1-07* |
| P1.4 | 指紋核（host adb 12 項 + in-app wa-probe 12 項） | 12/12 不符（host）+ 0/12（in-app）；根因精準：carrier 22/22 送達 + ro.boot.oem_* mapping OK，**MTG 影像缺 oem-propctl 解碼器**；display 1080x2400@420 真生效 | 指紋注入生效 | **FAIL = KNOWN LIMITATION**（照實，唔升 PASS） | p1/（wa-probe dump） |
| P1.5 | egress 機制 | 機內 → gost 出口 = 103.194.185.206；GMS proxy 設定 OK；平台面 503（拓撲限制② by design） | 出口經 gost 鏈 | **PASS**（機制）+ 平台面照實 | p1/ |
| P1.6 | APK 安裝/執行（host 面） | 兩 probe 均 Install Success 真跑：wa-probe 591 props dump；wa-attest 55s 全跑（GMS ok / safety task_error / integrity -12 Google server error）；平台面 503 APP_OPS_DISABLED by design | APK 真裝真跑 | **PASS**（機制）+ 平台面照實 | p1/ |
| P1.7 | live view | STREAM_TICKET_SECRET 未設 → 503 + api 無 adb 無幀源；UI fail-closed（非白屏）；真幀 host screencap 補 | 真幀呈現 | **FAIL = 結構性受限**（照實，唔升 PASS） | p1/（screencap 補償幀） |
| P1.8 | RAM gate after | liveLeases 1→2；memAvail -1.8G；wouldAdmitNext 仍 true | gate 計數正確 | **PASS** | p1/ |

判定：**P1 完成**（commit 8dc921c，Kairo p1 done）。

---

## 3. P2 批次真機（21:06 起，gen1+gen2；全部 batch 失敗照實入表）

### 3.1 前置 + v1–v3（gen1，3 連敗停手）

| 步 | 操作 | 真輸出 | 斷言 | 結果 | 證據 |
|---|---|---|---|---|---|
| P2.0 | recon | task=adapter（container 真起 wa-batch- 前綴/16370-16419/gate/allowlist fail-closed）；**UI Batch Planner 無 adapter/template 入口**（control.create 只傳 identities/batchSize/maxActive/failurePolicy）= 真 UI gap；worker 永不觸 ADB（T1 threat model）→ GT 由 host adb 獨立做 | 路徑坐實 | **記錄**（planner gap 照實保留） | p2-status.md §recon |
| P2.1 | 管理員配置：batch image allowlist（初 = 字串形）+ 3 身份 provision（02/03/04） | AppSetting 插入；3 identity READY | 前置就位 | **PASS** | p2-00、p2-01 |
| P2.2 | v1 batch（42d33723） | 3 run `NETWORK_POLICY_UNAVAILABLE` = worker network gate fail-closed（無 allowlist 配置）→ 管理員插 `network.qaEndpointAllowlistInternal=http://api:3000` | 建 batch 201 + plan 3 members | create **PASS**；run **FAIL（安全門真攔截）** | p2-04、p2-05 |
| P2.3 | v2 batch（02b20e2e） | 3 run `NETWORK_BLOCKED_IP` = docker 子網 172.38/16 非 RFC1918（IANA=public）→ internal zone 要求 private → entry 移入 public zone `network.qaEndpointAllowlist` | 同上 | create **PASS**；run **FAIL（IP 類區校驗真攔截）** | p2-08、p2-10 |
| P2.4 | v3 batch（2cbb2ce4） | 3 run `VOLUME_PATH_INVALID` = `IDENTITY_DATA_ROOT_DEFAULT`（/data/water_army/identities）**未掛載進 api 容器**（api mounts 只有 docker.sock + /var/lib/water-army）→ dataPath escape | 同上 | create **PASS**；run **FAIL（volume 校驗真攔截）** | p2-11 |
| P2.4b | **3 連敗停手回報**（老總硬紀律） | 三次失敗 = 三個不同根因（非循環）→ 停手，22:02/22:09 老總授權續航（「做」= 批准部署變更） | 紀律合規 | **STAND-DOWN → AUTHORIZED** | progress gen1 21:36 段 |

**v1–v3 副產（全真）**：3 身份 provision ✓、UI planner 面截圖 ✓（含 gap 記錄）、**3 個 fail-closed 安全門真機驗證**（honest error codes + worker audit `network_policy_deny`）、介入流前段（open→badge 0→1→console ack→resolve→badge 0，UI 真 click）、FAILED_FINAL re-arm 合法 edge 鏈（FAILED_FINAL→RESERVED→CANCELLED→READY）首驗、管理員配置動作 before/after 全落檔。

### 3.2 部署變更 + v4–v7（gen1 尾 + gen2 接手核）

| 步 | 操作 | 真輸出 | 斷言 | 結果 | 證據 |
|---|---|---|---|---|---|
| P2.5 | 管理員配置：api env `BATCH_CONTAINER_DATA_ROOT=/var/lib/water-army/redroid` + api 重啟（10–20s 中斷，已授權） | before/after 落檔；api Up healthy | volume 根掛載到位 | **PASS** | p2-20/21 |
| P2.6 | v4 batch（2f3b93e8，`rdfa-p2-final-v4 #1`） | 3 容器**真起**（wa-batch-…-a1、Exited(0) 殘留）→ boot 即 exit(0) = allowlist entry 字串形無 `privileged`（redroid 需要）→ waitHealthy 見 exited fast-fail ×2 attempt | 3 容器真起 | 容器起 **PASS**；run **FAIL ×3（FAILED_FINAL，根因坐實）** | p2-23/24/26（allowlist 物件化修復 p2-24 後段） |
| P2.7 | v5 batch | docker create **400**：`nanoCpus: 2e9` 單位錯（被當 CPU count ×1e9 = 2000 CPU > 16 核上限） | 同上 | run **FAIL ×3（docker 400，根因坐實）** | p2-25/26/27（nanoCpus:2 修復） |
| P2.8 | v6 batch | attempt-1 **HEALTH_TIMEOUT @ 60s** 預設窗 < 真 boot ~115s（容器留活）→ attempt-2 sweep adopt 活容器 → engine start **304 already-started** → 2 attempt 耗盡。管理員修：`BATCH_CONTAINER_HEALTH_TIMEOUT_MS=300000` + api 重啟 | 同上 | run **FAIL ×3（304 double-fail，根因坐實）** | p2-28/29/31/32 |
| P2.9 | v7 batch | 3 run **409 RUN_STATE_INVALID @ dispatch**：create payload `config.adapter` = 字串 `"container"`（v4–v6 = 物件）→ joi 只驗 object → `createCycle` 無 `validateBatchConfig` → dispatch `adapterSpecForRun` 拒。**F-RDFA-1 坐實**（gen1 假說「re-arm 邊界問題」否定） | 同上 | run **FAIL ×3（create 放行/dispatch 全死 = 產品 finding）** | p2-35、DB error_message |
| P2.10 | **v7 RUN_STATE_INVALID 根因確認 + re-arm r7**（gen2 接手核點） | state machine 源碼核（batch-constants IDENTITY_TRANSITIONS、transitionIdentity CAS、container-adapter hold 1.5s）；3 identity FAILED_FINAL→RESERVED→CANCELLED→READY 全 CAS UPDATE 1 + state_events 9 行 | 合法 edge 鏈清場（唔直接 UPDATE DB 狀態 = 唔繞狀態機） | **PASS** | p2-40/41 |

### 3.3 v8（gen2，3 容器真起 + worker 300s 修復）

| 步 | 操作 | 真輸出 | 斷言 | 結果 | 證據 |
|---|---|---|---|---|---|
| P2.11 | v8 batch（91dc97f4，23:33:02 起） | 3 容器真起、gate liveCount 2→5 ✓、run↔container↔identity 綁定 ✓；attempt-1 **TOOL_TIMEOUT @ t+120s 整**（worker 三 run 同刻，delayMs=10000 auto-retry）→ attempt-2 adopt 仍 boot 中容器 → engine start **304 already-started** → 3× FAILED_FINAL、產品 cleanup force-remove 容器。根因 = worker `CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS` default 120s < 3 台並發真 boot（ADB 握手 >120s）；api 端 300s 已對但 worker client 先斷 = **F-RDFA-3 實證** | 3 容器真起 + GT + 介入 | 容器起 **PASS**；run **FAIL ×3（120s client timeout，根因坐實）** | p2-42/43 |
| P2.12 | 管理員配置：worker env `CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS=300000`（compose repo+deploy 同步、test-config 註釋、P3 還原清單）+ worker recreate | before/after 落檔；worker Up healthy、queue ai-tasks 重連、boot reconciliation 0 殘留 | worker client ≥ api window | **PASS** | p2-48 |
| P2.13 | IV8（v8 02 介入）照實 resolve | orchestrator 首秒死 = shell 引號 bug（`-F \$'\t'` 變 4 字面、`retry_wait` 非 TaskRunStatus、set -u 空值）→ 介入流 open→badge 0→1→ack 三段真跑、**stop 未觸發** = 照實入報告（唔聲稱全環） | 介入流 | **半環（到 ack 止，照實）** | p2-44/49 |

### 3.4 v9（gen2，決定性：F-RDFA-2 鎖定）

| 步 | 操作 | 真輸出 | 斷言 | 結果 | 證據 |
|---|---|---|---|---|---|
| P2.14 | re-arm r8（3× FAILED_FINAL→READY，9/9 CAS + state_events）→ v9 batch（26885119 / cycle d19b13d8，15:44:06 起，300s window） | create 201；3 容器真起 | 同上 | **PASS**（前置） | p2-50/54 |
| P2.15 | v9 跑窗 | 15:44:06 容器起 → attempt-1 waitHealthy **300s window 全空（probe 從未答）** → 15:49:06 HEALTH_TIMEOUT → 10s backoff → attempt-2 adopt+start → **304 already-started** → 15:49:17 全 FAILED_FINAL → 15:49:21 batch COMPLETED_WITH_ERRORS。**反證**：15:49:00（failure 前 17s）host `adb connect` 三端口全成功（TCP 層）；GT 03/04 都捕到 | run 完成 | run **FAIL ×3（300s 內 probe 0 字節 → 非 timing，係結構性）** | p2-52（GT 03/04：egress 103.194.185.206、boot_completed=1 @容器 t+~38s、570 行 getprop；02 = connect-level partial，照實標註） |
| P2.16 | **diag 容器實驗**（wa-rdfa-diag-probe，真 MTG，boot_completed=1，用完即拆 16:11Z） | **EXP C（決定性）**：api 容器內 `127.0.0.1:16395` → **ECONNREFUSED**，host 同端口 TCP 通 → **F-RDFA-2a**（probe 喺 api bridge netns，port binding 喺 host loopback，api netns 永遠睇唔到）；**EXP A**：host 層產品 probe 原 bytes（bare `host:version` 無 CNX）→ 真 adbd **零字節回應** 5s，同刻真 adb client（CNX 握手）完全服務（get-state=device、570 行 getprop）→ **F-RDFA-2b**；**EXP D**：api → devices-network IP:5555 = TIMEOUT（api 唔喺 devices net）→ 跨 bridge 唔通 | probe 過唔到嘅根因定位 | **F-RDFA-2 雙重根因鎖定**（netns + protocol；單一 2a 已完整解釋全部 HEALTH_TIMEOUT；2b 修後仍需 2a 修，兩邊都要） | p2-55（原始 byte 記錄） |
| P2.17 | 勘誤（照實） | 之前「MTG adbd wire boot 後 ~5min 先可用」= 誤讀 v9 `adb connect` 嘅 "connected to"（TCP 層，docker-proxy accept，非 wire 層）；P1 實證 wire boot 後 ~10s 已服務（p1-07），diag 再證實 → **adbd 時延唔係因子**，真因子淨係 2a/2b | 誤記更正 | **CORRECTED** | p2-55、p1-07 |
| P2.18 | IV9（v9 02 介入）練到產品 bug 邊界 | open→badge 0→1→ack 200→**真卡點（300s probe 空轉 = 真卡）**→engine retry attempt-2（真 304）→FAILED_FINAL→resolve 200（16:06:06Z）。orchestrator bug #4（`$CTR[02]` 無 bracket → set -u fatal）令 stop 未執行 = 照實標註「flow 練到 ack+真卡點+retry+terminal，stop/retry-resume 未練」 | 介入流全環 | **到產品 bug 邊界（照實）** | p2-53/57 |
| P2.19 | 報告導出 + secret scan + 穩定 | v9 cycle 報告 JSON 200（2357B）+ CSV 200（1168B）；3 機真實數據核（egress/props/GT 路徑）；secret scan **0 命中**；5 分鐘穩定窗：wa-batch running=0、liveLeases 2（=1 baseline + rdfa-01）、0 new errors | 報告 + 穩定 | **PASS** | p2-58/59 |
| P2.20 | 判定 + Kairo | **P2 交付物全出**；「run 完成→resolve」半環喺現 build 對真機結構性不可達（F-RDFA-2a+2b 雙重阻塞，唔係 orchestrator/mock/配置問題）；**v10 = 重複撞同一面牆（netns=topology 決定、protocol=代碼決定，本單配置改唔到）= 循環 → ABORT batch 路線**（3 連敗紀律 + 根因修復要求）。Kairo p2 subtask done；commit 738b6ff pushed（30 件，P2 證據 mirror 入 docs/） | — | **P2 COMPLETE** | progress gen2 段 |

### 3.5 v1–v9 失敗總表（每次失敗照實）

| Batch | 時刻（UTC） | 失敗 | 根因（坐實） | 分類 |
|---|---|---|---|---|
| v1 42d33723 | 13:2x | NETWORK_POLICY_UNAVAILABLE ×3 | network allowlist 零配置 → gate fail-closed | 配置（安全門正確行為） |
| v2 02b20e2e | 13:3x | NETWORK_BLOCKED_IP ×3 | 172.38/16 非 RFC1918，internal zone 要求 private | 配置（安全門正確行為） |
| v3 2cbb2ce4 | 13:5x | VOLUME_PATH_INVALID ×3 | identity data root 未掛載進 api 容器 | 部署缺口 |
| v4 2f3b93e8 | 14:1x | boot exit(0) ×3（快 fail） | allowlist entry 字串形無 privileged | 配置（安全門正確行為） |
| v5 | 14:2x | docker create 400 ×3 | nanoCpus 2e9 單位錯（2000 CPU > 上限） | 配置 |
| v6 | 14:5x | HEALTH_TIMEOUT 60s + 304 ×3 | 預設 window 60s < boot ~115s → adopt 304 | **F-RDFA-3**（mock-calibrated default） |
| v7 | 15:0x | 409 RUN_STATE_INVALID ×3 @dispatch | adapter spec 字串形 create 放行（無 validate）→ dispatch 拒 | **F-RDFA-1**（產品 validation 缺口） |
| v8 91dc97f4 | 15:3x | TOOL_TIMEOUT 120s + 304 ×3 | worker client timeout 120s < 並發真 boot | **F-RDFA-3**（worker 側） |
| v9 26885119 | 15:4x | HEALTH_TIMEOUT 300s + 304 ×3 | probe 喺 300s 內 0 字節（netns 拒連 + 無 CNX）= 結構性 | **F-RDFA-2**（blocking，双重根因） |

---

## 4. P3 拆除 + 收口（2026-10-28 16:20Z–16:3xZ = 2026-10-29 00:20 HKT 起，gen2）

| 步 | 操作 | 真輸出 | 斷言 | 結果 | 證據 |
|---|---|---|---|---|---|
| P3.0 | 拆除前快照 | devices = mc-dogfood-1/2 + rdfa-01；容器 = rdfa-01 Up + 3 wa-batch Exited；data root 13 entries（本單 5：rdfa-01..04 + rdfa-test-td）；gate liveLeases=2 | 拆除目標全盤點在檔 | **PASS** | p3-00-snapshot.txt |
| P3.1 | API DELETE redroid-rdfa-01（admin，confirm+removeData=true；雙重前綴確認，唔喺禁碰集） | HTTP 200 `{deleted:true, containerRemoved:true, removeData:true, dataRemoved:false, dataRemoveErrorCode:"DATA_DIR_PERM_DENIED"（EACCES scandir dalvik-cache）}`；device 行消失（剩 mc-dogfood-1/2） | 容器 + 行清除 | **PASS（行+容器）+ data 面照實**：api 容器 uid 無法刪 root-owned 內部文件（紅roid 機內 root 寫入）→ fail-closed 誠實報錯（產品行為正確）→ 轉 P3.2 root 技術 | p3-01-delete-01.txt |
| P3.2 | data root 清理（5 目錄，全部本單前綴紅牌確認） | docker-mount root rm：內容全刪（dir link 49→2）；bind mount point 本體 busy（技術限制）→ rmdir 空殼 ×5 全 OK | 本單 data 零殘留 | **PASS**（redroid-rdfa-01..04、rdfa-test-td 全 gone；其他 ticket 6 目錄原封未動） | p3-02-data-root-cleanup.txt |
| P3.3 | wa-batch 殘留 3 台（v4 遺留 Exited） | 雙重前綴 + label（com.mirrorsocialmedia.water-army.* managed=true）+ batch=2f3b93e8（rdfa-p2-final-v4 #1）+ 引用 run 全 terminal（failed）確認 → docker rm ×3 | 殘留清除（先核後刪） | **PASS**（wa-batch 殘留 = 0） | p3-03-cleanup-verified.txt |
| P3.4 | gate leases 歸零核 | liveLeases = **1** = P0 預 ticket baseline（P0 證據 p01：liveLeases=1；本單峰值 = 1+01+3 = 5 @v9 跑窗；v9 後 = 2；01 刪後 = 1）| 本單 leases 全釋放 | **PASS**（1→5→1 全鏈在檔） | p3-03、p0/p01 |
| P3.5 | 禁碰集核 | rdev-f1 Up 8h、redroid-mc-dogfood-2 Up 12h、rdev-e1-gost Up 26h（零觸碰） | 禁碰集 intact | **PASS** | p3-03 |
| P3.6 | 全套件零回歸 | `npm test` @738b6ff：**1612 = 1606 pass / 0 fail / 6 skip**（= §1 基線，skip 全 integration 環境門控非跳過失敗） | 零回歸 | **PASS** | 本報告 §5 |
| P3.7 | 報告 + release-status 同步 + provenance --check + secret scan | 見 §5 | 收口 | 見 §5 | 本報告 §5 |

**管理員配置清單（本單測試配置，留原狀，還原等老總拍板）** — 4 項（工單列 3 項 + gen2 新增 1 項）：

| # | 配置 | 值 | 落點 | 還原法 |
|---|---|---|---|---|
| C1 | `network.qaEndpointAllowlist` | `["http://api:3000"]` | AppSetting（DB） | `DELETE FROM "AppSetting" WHERE key='network.qaEndpointAllowlist'`（`network.qaEndpointAllowlistInternal` 已喺 P2 還原，p2-10） |
| C2 | `batch.container_image_allowlist` | `[{image: water-army/redroid:14.0.0-240527-gms-mtg, privileged:true, nanoCpus:2, memBytes:4294967296}]` | AppSetting（DB） | DELETE 該行（batch 功能恢復 fail-closed 空 allowlist 基線） |
| C3 | `BATCH_CONTAINER_DATA_ROOT` | `/var/lib/water-army/redroid` | api 容器 env（/tmp/wa-head/compose.yaml） | 刪 env 行 + api recreate |
| C4 | `BATCH_CONTAINER_HEALTH_TIMEOUT_MS`（api 300000）+ **`CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS`（worker 300000，gen2 新增）** | 300s | compose env | 刪 env 行 + api/worker recreate（code default 恢復 60s/120s = F-RDFA-3 待產品修 default） |

> C2/C3/C4 嘅 compose 行已帶 `# WA-REALDEVICE-FINAL test config — restore pending boss sign-off` 註釋；C1/C2 係 DB 行（無法加註釋）→ 以本清單為準。

---

## 5. 收口核（P3.7）

| 項 | 結果 |
|---|---|
| final report | 本檔（`docs/audits/realdevice-final-report.md`），commit SHA 見 git log（P3 commit） |
| release-status.md 同步 | 真機項升 `PASS(real-device)` 連本報告 SHA（batch 容器起機半環、gate、介入流到 bug 邊界、報告導出）；**batch × 真機端到端一條龍 = FAIL（F-RDFA-2，v4–v9 實測，根因坐實）**；指紋 KL / live view 結構性 / UI planner gap **照實保留**（唔升） |
| provenance --check | `bash scripts/release-status-provenance.sh --check` = 綠（§1 vs 實跑零漂移） |
| 全套件 | 1612 = 1606 pass / 0 fail / 6 skip @738b6ff（= §1 基線） |
| sensitive scan | 新增證據/報告檔 grep secret pattern（token/key/JWT/password 字面）= **0 命中**（P2 報告導出 scan 0 命中已在 p2-59；P3 檔同法複掃） |

## 6. 移交事項（開發單，非本單範圍）

1. **F-RDFA-2 修復**（blocking，高）：probe target 改 host 視角（host 上跑 probe / api 掛 host network / 獨立 prober sidecar 掛 host netns）+ probe 實作真 ADB CNX 握手（或用真 adb client binary）+ 解除 hermetic probe seam 嘅真機驗證缺口（probe 層加 env-gated 真機 e2e）。
2. **F-RDFA-1 修復**（高）：`createCycle` 補 `validateBatchConfig`（或 API boundary 驗 adapter 形狀），409 前移 create 時刻。
3. **F-RDFA-3 修復**（中）：health window / client timeout default 真機校準（window ≥180s、worker client ≥ api window）或配置強制。
4. **UI Batch Planner adapter/template 入口**（gap）：現 container batch 只可走 API。
5. **指紋 KL**：MTG 影像缺 oem-propctl 解碼器（自製 image + init 映射路線，`docs/w1b-realdevice-todo.md`）。
6. **live view**：STREAM_TICKET_SECRET + api adb/幀源拓撲（api 容器無 adb = runbook §270 已知設計；真幀現靠 host screencap）。
7. **管理員配置 C1–C4 還原**：等老總拍板（本單留原狀）。

## 7. 證據索引

- P0：`docs/audits/realdevice-final/p0/`（p01–p06 + summary，11 件）
- P1：`docs/audits/realdevice-final/p1/`（28 件，含 wa-probe/wa-attest dump、screencap 補償幀）
- P2：`docs/audits/realdevice-final/p2/`（p2-00…p2-59，含 v1–v9 全部 create/window/intervention 記錄、GT 03/04 原始 dump、p2-55 diag 實驗 byte 記錄、報告 JSON/CSV、secret scan）
- P3：`docs/audits/realdevice-final/p3/`（p3-00…p3-03：快照、DELETE 01、data root 清理、驗證）
- 執行機原檔（gitignored）：`logs/realdevice-final/p{0,1,2,3}/`
- Kairo：`mvs2iknd60sig`（p0/p1/p2/p3 全 done）；git 鏈：`4e86122`（P0）→ `8dc921c`（P1）→ `033f87d`（3-strike halt）→ `738b6ff`（P2 final）→ P3 commit（本報告）
