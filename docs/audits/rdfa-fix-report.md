# WA-RDFA-FIX — F-RDFA-1/2/3 修復報告（WA-REALDEVICE-FINAL 真機 finding 收口）

> 工單：`logs/waterarmy-rdfa-fix-workorder.md`（workspace）。基線 = `db60c07`
> （WA-REALDEVICE-FINAL 收口，全套 1612 = 1606 pass / 0 fail / 6 skip）。
> 本單 5 段執行序：S1 create-time 校驗 → S2 probe 修復 → S3 window 合理化 + C4 撤
> → S4 真機 mini-驗證 → S5 報告 + release-status + 全套零回歸。
> 紀律：mock 唔當真機 PASS；admin 密碼零入 repo；RAM gate 4G/5400 現狀保留；
> 禁碰集 {rdev-f1, redroid-mc-dogfood-2, rdev-e1-gost} 零觸碰。

## 0. 總覽（commits / 測試 / 狀態）

| Subtask | Finding | Commit(s) | 狀態 |
|---|---|---|---|
| S1 | F-RDFA-1 | `991ddfa`（+ `51f32cd` S1-consistency） | DONE |
| S2 | F-RDFA-2 | `4291f71` | DONE |
| S3 | F-RDFA-3 | `39ddeae`（+ `858bed4` self-attach 修復） | DONE |
| S4 | 真機 mini-驗證 | `92f3757`（證據入倉 `docs/audits/rdfa-fix-s4-live-evidence.txt`） | DONE |
| S5 | 報告 + 收口 | 本 commit | DONE |

全套（本單收口後實跑）：**1658 tests = 1652 pass / 0 fail / 6 skip**
（baseline 1612/1606/0/6 + 46 新測試；skip 6 = 環境門控，非跳過失敗）。
`bash scripts/release-status-provenance.sh --check` = 綠（見 release-status.md §1）。

三個 finding 嘅關係：F-RDFA-1 令 malformed batch 逃過 create-time 校驗（409 喺
dispatch 先爆）；F-RDFA-2 令 probe 對真機**結構性**不可達（netns + 協議兩層）；
F-RDFA-3 令 window 係 mock-calibrated（api 60s < 真 boot 115-125s；worker 120s <
3 並發 boot）。三者疊加 = WA-REALDEVICE-FINAL P2 批次 v4–v9 六連敗嘅全部根因
（失敗總表：`docs/audits/realdevice-final-report.md` §0/§3.5）。

---

## 1. F-RDFA-1 — create-time 校驗缺失（medium）

**Root cause**：`POST /api/batches` 對 `config.adapter` 只驗 `type:'object'`
（`apps/api/src/routes/batches.js`）；而 worker 側 `createCycle`
（`packages/shared/src/batch-service.js`）只調 `validateCapacityInput`、
**從不調** `validateBatchConfig` → malformed adapter（未知 type、壞 shape）喺
create 時 201 放行、到 dispatch 先 409。`validateBatchConfig` 此前係生產 dead
code（只有 def + 單測引用）。

**修復**（`991ddfa`）：
- `createCycle` 加入 `validateBatchConfig(input?.config)` → malformed = 400 at
  create，zero rows persisted（fail-fast，唔再留殘骸行）。
- 更正 stale 註釋（原稱「validated at API boundary AND re-checked by worker」
  但 worker 邊個 re-check 都無）。
- `51f32cd`（S1-consistency）：engine/scheduler 測試 fixtures 由 string seam
  （`'container'`/`'noop'`）轉 live object 形狀 `{ type: ... }`；
  `config.adapter = null` 語義 = absent（→ ADAPTER_NOT_CONFIGURED at dispatch）；
  unknown-adapter string case 斷言 400-at-create。

**證據**：
- 新增 `tests/unit/batch-config-validation.test.js`（9 例：unknown type / 壞
  health shape / 邊界值 / null-semantics）。
- `tests/integration/batches-api.test.js` +3 真 HTTP boundary 例（malformed
  adapter 200/201 唔再可能：400 + zero rows）。
- v7 string payload 回歸：`"container"` 字串照樣 400 at create（S1 權威行為
  保留）。

**真機驗證**：F-RDFA-1 係代碼層校驗（無真機表面）——hermetic + 真 HTTP
boundary 層驗證（mock-hermetic 證據級）；真機相關性 = 實測 v4–v9 嗰啲
malformed 201→dispatch 409 嘅殘骸行唔會再產生。

---

## 2. F-RDFA-2 — ADB health probe 對真機結構性不可達（high，本單核心）

**Root cause（雙層坐實，`docs/audits/realdevice-final/p2/p2-55`、`p2-56`）**：
- **2a netns**：probe 喺 api 容器 netns 探 `127.0.0.1:<hostPort>`（host-published
  口），但 ADB binding 喺 host loopback → 容器 loopback 睇唔到 → **ECONNREFUSED**
  （p2-55 EXP C 原始 byte 實錚；Docker inter-bridge 隔離令 device 容器
  172.38.200.x 都唔係 api 容器 default netns 可達）。
- **2b protocol**：probe 發 bare `000chost:version` SYNC frame（**無 A_CNXN
  握手**）→ 真 adbd（AOSP `platform/packages/modules/adb`）收唔到有效 CNXN 前
  **零回應**（p2-55 EXP A：同刻真 adb client 完全服務、bare 包零字節；原始
  byte 落檔）。v9 窗口 300s 都一樣死 = 結構性、配置改唔到 → v10 ABORT 判定。

**修復**（`4291f71`）：
1. **`packages/shared/src/adb-protocol.js`**（pure wire protocol，新）：24-byte
   LE header（command/arg0/arg1/data_length/data_check/magic）、
   `magic = command ^ 0xffffffff`、`data_check` = payload u32 byte-sum、
   `buildAdbCnxnPacket`（client CNXN：`A_CNXN=0x4e584e43`、
   `A_VERSION=0x01000001`）、`parseAdbPacket` / `parseAdbBanner`。
   真 wire 事實（p2-55 捕獲 + AOSP 源雙向核對）：真 command 係 **CNXN**
   （wire bytes `43 4e 58 4e`），工單舊假設 `0x434e5801`「CNX」= 錯。
2. **`apps/api/src/services/adb-cnxn-probe.js`**（真 CNXN 握手 probe，新）：
   healthy = 回覆 A_CNXN + valid magic + device-side banner（`device::` 等，
   `version: adb-<type>@0x<arg0>`）；negative paths 全部 actionable detail
   （ECONNREFUSED / no-reply timeout / 短路 / bad magic / A_AUTH / A_STLS /
   oversized reply / unrecognized banner）。計時 = **plain setTimeout hard
   overall budget**（實測：socket inactivity timer 喺 data 流入後 peer FIN
   唔再 fire — 陷阱已記 TOOLS.md）；`s.on('data')` 多 chunk reassembly +
   `settled` guard + 65536B cap；`setNoDelay(true)`。
3. **probe 目標**：`waitHealthy`/`healthForRun` 由 `127.0.0.1:hostPort` 改
   **device container bridge IP @ water-army-devices**（container-side port
   5555）；host publish 保留畀 human/adb-CLI。running 但無 device-network
   endpoint → **fast fail**（structural，唔 poll）。
4. **api boot self-attach** 到 device network（idempotent、live、self-healing；
   fail = logged + probe fail closed）— 免改 compose（compose recreate 會 drop
   手動 attach）。

**S3 首次 live boot 揪出嘅 self-attach 真機 bug**（`858bed4`）：
own-container match 讀 `listContainers` summary 嘅 `Config.Hostname` — 但
Docker API list shape **無 Config 欄** → 結構性永遠 mismatch（「could not
locate own container」）→ api 開機唔 attach → L2 probe 對真 run 全部 fail
closed。修復 = 逐 running candidate 做 full inspect 匹配（bounded、boot-only）；
fake docker client 補 `Config.Hostname` 建模 + `getNetwork().connect()`
recording；+3 回歸測試（attach-at-boot / idempotent no-op / fail-closed）。
**呢個 bug 恰好證明呢條紀律：mock 綠 ≠ 真機行得通 — S2 嘅 hermetic 套件全綠，
live boot 第一下就紅。**

**證據**：
- unit：`tests/unit/adb-protocol.test.js` 18 例（header 編碼、magic、checksum
  u32 wrap、banner 解析）。
- hermetic：`tests/integration/adb-cnxn-probe-hermetic.test.js` 11 例（真協議
  fake adbd：no-auth CNXN、recovery banner、split-across-chunks、ECONNREFUSED、
  silent timeout、garbage/bad magic、A_AUTH、A_STLS、unrecognized banner、
  oversized reply、hostile flood）。
- lifecycle：`tests/integration/batch-lifecycle-service.test.js` 44/44（真
  local CNXN fake adbd 行晒 healthForRun 全路徑 + no-endpoint fast-fail +
  self-attach 3 例）。
- 全套零回歸：1650/1644/0/6（S2 收口時點）→ 1658/1652/0/6（S5 收口）。

**真機驗證（live，雙路徑）**：
- **S2 live**（production probe code 行喺 `water-army/api:local` image、真
  device network、真 redroid-rdfa-s2 @172.38.200.3）：
  - `:5555` → `{"healthy":true,"version":"adb-device@0x1000001"}`
  - `:5599` → `ECONNREFUSED` unhealthy（真 negative）
  - `.254:5555` → no-reply 3s timeout unhealthy（真 negative）
- **S4 live**（golden standard，redroid-rdfa-vx @172.38.200.4，
  `docs/audits/rdfa-fix-s4-live-evidence.txt`）：
  - **真 healthy**：production `adb-cnxn-probe.js` 喺 water-army-api-1、300s
    S3 window → attempt 1 = `{"healthy":true,"version":"adb-device@0x1000001"}`
    （container start 19:48:00Z → adbd 答 ≤~90s，300s window 內）
  - **真 unhealthy**：`docker stop` 後 →
    `{"healthy":false,"detail":"no ADB reply within 3000ms (adbd not answering)"}`
  - **self-attach live 驗證**：新 api 容器（`858bed4` image）自己 boot 時
    attach 到 water-army-devices @172.38.200.3（log 行已捕）— 唔再靠手動
    `docker network connect`。

---

## 3. F-RDFA-3 — boot-health window mock-calibrated（medium）

**Root cause**：api `batchContainerHealthTimeoutMs` default **60s**、worker
`CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS` default **120s** — 全部 mock-calibrated。
真機實測（`docs/audits/realdevice-final/p2/p2-43`、`p2-48`、compose 實測註）：
- v6：單台 MTG cold boot ≈**115–125s** → 60s window boot 途中到期 →
  HEALTH_TIMEOUT → attempt-2 adopt 活容器 → **304 already-started** 雙敗。
- v8（p2-43）：**3 並發** MTG boot 拖過 120s → **worker** 120s client 先斷
  （TOOL_TIMEOUT @ t+120s）→ adopt 仲在 boot 嘅容器 → 304 ×3 FAILED_FINAL。
  根因 = worker client 比 api window 先死（關係無任何約束）。

**修復**（`39ddeae`）：
- **單點常量 + 結構性約束**（`packages/shared/src/batch-constants.js`）：
  `BATCH_BOOT_HEALTH_WINDOW_MS = 300_000`（api window）；
  `BATCH_LIFECYCLE_CLIENT_TIMEOUT_MS = BATCH_BOOT_HEALTH_WINDOW_MS + 60_000
  = 360_000`（worker client = **派生自** api window + 60s margin — 關係用代碼
  結構鎖死，唔會 silent regress）。api config.js / waitHealthy fallback 改讀
  300s；worker container-adapter 改讀 360s（clamp 15000..1800000 保留，admin
  override 照舊）。300s = 2.4× 單台實測（併發/慢機 margin）+ 就係 WA-
  REALDEVICE-FINAL 期間 env 300s 治標實測能過嘅值。
- **C4 env 撤除（治理歸位）**：compose `BATCH_CONTAINER_HEALTH_TIMEOUT_MS=
  "300000"` + `CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS="300000"` 兩行除 —
  code default 已合理化並結構性約束，env override 冗餘（且 360s > 300s =
  修正）。C1/C2/C3 照工單保留。
- **文檔**：ADR-036（`docs/architecture-decisions.md` §36：window 關係 + 實測
  依據 + C4 治理歸位）；`.env.example` 60000→300000 + 關係註；stale 60s/120s
  註更新。

**證據**：
- 新增 `tests/unit/batch-window-constants.test.js` 5 例（雙 default ≥180s、
  worker ≥ api+30s margin、calibrated 300s/360s、api loadConfig default +
  env override、worker adapter default 經真實 client seam 觀察 360s）。
- `tests/unit/container-adapter.test.js` start/stop 斷言 120s→360s。

**C4 撤除 before/after（live，api/worker 容器 recreate 後實讀）**：
- BEFORE（2026-10-28T19:27:44Z，old image created 14:47Z/15:39Z）：
  api `BATCH_CONTAINER_HEALTH_TIMEOUT_MS=300000`；worker
  `CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS=300000`；api 手動 attach @.4。
- AFTER（recreate 後）：兩行 env **ABSENT**；api 現行 env 只剩 C3
  `BATCH_CONTAINER_DATA_ROOT`；api **self-attach** @172.38.200.3（858bed4
  修復後嘅 boot 自癒）；worker 300s→360s（修正）、api 300s 不變。
- 落檔：`/tmp/wa-s3-c4-before.txt` / `/tmp/wa-s3-c4-after.txt`（執行機；
  摘要喺 ADR-036 + 呢度）。

**真機驗證**：S4 live — 300s window 對真 MTG boot healthy（attempt 1、≤~90s
答覆）；RAM gate admission 實跑（見 §4）；全套零回歸 1658/1652/0/6。

---

## 4. S4 — 真機 mini-驗證（golden standard，零 mock）

設備 `redroid-rdfa-vx`（自己 redroid-rdfa-* 前綴；production
`createAndStart` body 鏡像：MTG image `water-army/redroid:
14.0.0-240527-gms-mtg`、4G、2CPU、privileged、device network、data-root
`/data` bind；id=1390dce3；started 2026-10-28T19:48:00Z；@172.38.200.4）。
完整 raw 證據：`docs/audits/rdfa-fix-s4-live-evidence.txt`。

| 驗收項 | 結果 | 證據 |
|---|---|---|
| RAM gate 准入（4G floor 現狀） | **ADMITTED**（live policy：maxParallel=10、hardFloor 4096、target 5400、budget 1200；liveLeases=2、projected 35141 MiB ≥ 5400） | live `GET /api/system/ram-gate`（before/after JSON 落檔） |
| probe 真 healthy | **HEALTHY within 300s window**，attempt 1，`version=adb-device@0x1000001`（真 A_CNXN device banner） | production probe 代碼喺 water-army-api-1 實跑 |
| probe 真 unhealthy | **UNHEALTHY**（stop 後 `no ADB reply within 3000ms (adbd not answering)`） | 同上（negative 路徑真跑） |
| network gate C1/C2 全通 | C1 `["http://api:3000"]` + C2 MTG allowlist（privileged/4G/2CPU）實讀全通；api→device bridge 可達（healthy probe 本身即證明） | live AppSetting 實讀 + probe 雙路徑 |
| teardown + lease 歸 baseline | container + data root（root-owned 內容經 root container 清）+ S2 殘留 s2（container+data+stale RAM lease）全清；ramgate live set 只剩 DO-NOT-TOUCH dogfood-2 自己個 lease；port leases 0；MemAvailable 41.3G 恢復 | `docs/audits/rdfa-fix-s4-live-evidence.txt` §6 |
| 禁碰集零觸碰 | rdev-f1 / redroid-mc-dogfood-2 / rdev-e1-gost：teardown 後 id + startedAt 與 pre-check 快照**完全一致** | 同上 §0/§6 |

---

## 5. 邊界誠實（唔可推斷）

- **批次 × 真機端到端一條龍（UI 建批次 → N 台真機 run 跑完）= NOT VERIFIED**。
  本單修齊咗三個根因並且 probe 雙路徑 + network gate + RAM gate 都喺真機
  實跑過（S4），舊嘅結構性 blocker（F-RDFA-2）已除 — **升級評估可行**，但
  本單 S4 係 mini-驗證（單台 probe 雙路徑），**未跑完整批次 e2e**，唔可
  推斷批次喺真機可用。下一步 = 獨立單：全批次真機複驗（N 台並發、完整
  run 生命周期）。
- 300s/360s window = 本 host + MTG image + 並發 3 台嘅標定值，唔係物理下限
  （換更重 image / 更高並發可經 env 調高，clamp 上限 30min）。
- F-RDFA-1 修復嘅真機相關性 = 殘骸行唔再產生（校驗本身係代碼層，mock-
  hermetic 證據級）。
- C1/C2/C3 管理員測試配置**照舊保留**（老細授權期間現狀）；oem-propctl 未動
  （另單 WA-OEMPROP 跟）。

## 6. 收口檢查

- 全套零回歸：**1658 = 1652 pass / 0 fail / 0 cancelled / 6 skip**（四欄分列；
  baseline 1612/1606/0/6 + 46 新）。
- `bash scripts/release-status-provenance.sh --check` = 綠（release-status.md
  §1 實跑口徑同步）。
- sensitive scan：本單全部新/改檔對 admin 密碼 pattern 零命中（逐 commit diff
  scan + repo-wide grep；admin 密碼只曾喺 S4 admin session 嘅 shell 命令行
  短暫出現，零入 repo / 零入 log 檔）。
- release-status.md 同步：F-RDFA 項狀態更新（§1/§3.2/§4/§5），批次 e2e 維持
  NOT VERIFIED（未推斷）。
- 每段 commit+push：991ddfa / 4291f71 / 39ddeae / 858bed4 / 92f3757 / 本 commit。
- Kairo `mvse36fn30lq1` s1–s5 全部 done。
