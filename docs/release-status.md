# Water Army — Release Status（單一狀態頁）

> 本頁 = 項目**現況的單一事實來源**（single source of truth）。README 頂部只導向本頁，不再作現況摘要。
> 審計規則：每個 `PASS` 必連可檢查 evidence；**mock / fake ADB / hermetic / build-green 一律不得標真機 PASS**。
> 本頁測試數字一律**實跑生成**（見 §0 生成命令）；歷史快照數字只准出現在 §2 快照表並帶日期+範圍。

## 0. 元數據

| 項 | 值 |
|---|---|
| 測試實跑基準 commit | `92f3757`（生成時 HEAD；工作樹 clean；WA-RDFA-FIX S4 收口後重跑，全套零回歸 = 同數） |
| 生成日期 | 2026-10-29 03:5x HKT（Asia/Hong_Kong） |
| 工作樹狀態 | 最終 commit 後重跑 `--check` = clean 校驗（見 §5.3） |
| 生成命令 | `bash scripts/release-status-provenance.sh`（填 §1 實跑數字）；事實欄由 docs/audits/*、docs/*.md、HEARTBEAT 逐條盤點 |
| 重複核對 | `bash scripts/release-status-provenance.sh --check`（比對本檔 §1 vs 實跑，漂移即 exit 1） |

**Evidence 位置約定**：`docs/...` / `scripts/...` = repo 內（clone 後可核）；`logs/...`、`HEARTBEAT.md`、`secrets/` = 執行機 workspace（**不在 repo**：`logs/` gitignored；外部審計者向 CEO 索取）。

### 狀態詞（只用呢五個）

| 狀態詞 | 定義 |
|---|---|
| `PASS(real-device)` | 喺真 redroid 容器 / 真機出口鏈 / 真外部平台（Google、Meta 生產服務）上實測通過 |
| `PASS(live-stack)` | 真部署（真容器、真 Postgres/Redis、真 API/worker、真瀏覽器）但測試主體/上游為受控測試件（自建 canary、mock provider）——**唔等同真外部依賴** |
| `PASS(mock-hermetic)` | hermetic 套件（fake db/redis/docker/provider）綠 = 邏輯正確性證據，非環境可用性證據 |
| `FAIL` | 實測失敗（附檔留底） |
| `NOT VERIFIED` | 未驗證——必列原因 / 下一步 / 不可推斷的結論 |
| `KNOWN LIMITATION` | 已實測確認嘅結構性限制 / 天花板（非缺陷或屬設計接受） |
| `DEFERRED` | 未排期 / 待拍板 / 待料 |

> 代碼完成 + mock 測試綠 ≠ 真機可用。讀者**唔可以由「已實裝」推「真機 PASS」**。

---

## 1. 測試基線（實跑口徑）

**計法**：`npm test` = `node --test tests/unit/*.test.js tests/integration/*.test.js`（全 hermetic：fake db/redis/docker，零外部依賴）。分層 = 按目錄劃分實跑。E2E harness 係獨立腳本（Playwright / node mjs），**唔計入 npm test 總數**。

> **口徑澄清**：過往記錄（工單、HEARTBEAT）偶見「1606 tests（1600 pass + 6 skip）」— 實測基準下 **1606 = pass 數**，全套 tests 總數 = **1612 = 1606 pass + 6 skip**；引用時請以「tests / pass / fail / skip」四欄分列，避免 pass-vs-total 混用。
>
> 實跑快照：`bash scripts/release-status-provenance.sh` @`273c65c`（2026-10-29 15:2x HKT，WA-VMSTEALTH）輸出 = `suite total=1693 pass=1687 fail=0 skip=6；unit 1232/1232/0/0；integration 461/455/0/6`。（上一快照 @`37c2e37` = 1672/1666/0/6。）

| 層 | 命令 | 測試數 | 結果 |
|---|---|---|---|
| 全套 npm test | `npm test` | 1693 | 1687 pass / 0 fail / 6 skip（skip 全部在 integration 層 = 環境門控：real-redis gated、真機窗口 gated；**非跳過失敗**） |
| unit | `npm run test:unit`（91 files） | 1232 | 1232 pass / 0 fail / 0 skip |
| integration | `npm run test:integration`（47 files） | 461 | 455 pass / 0 fail / 6 skip |
| web build | `npm run build` | vite | 綠（build green ≠ 功能 PASS，只證可打包） |

**E2E harness（獨立於 npm test，全部對真 web/API 部署打）**：

| Harness | 步驟/斷言 | 狀態 | Evidence |
|---|---|---|---|
| P6 Playwright E2E | 14/14（真 headless Chrome + 真 worker） | PASS(live-stack) @2026-10-19 | `docs/evidence/p6-e2e/` |
| P6 clean-install | `down -v` → README 由零起 → 5/5 healthy → 首 admin → 登入 200 | PASS(live-stack) @2026-10-19 | `docs/evidence/p6-cleaninstall/` |
| MC P2 單機 console E2E | 10/10（LIVE 實幀 + 輸入 + sidecar SIGKILL 重連 + viewer 唯讀） | PASS(real-device) @2026-10-24 | `docs/audits/mobileconsole-final-report.md` §2.2–2.3、`logs/mobileconsole-p2/`（workspace） |
| MC P3 5 路 ladder | 4/4 穩定性場景 + fleet E2E 5/5（T30–T34） | PASS(real-device) @2026-10-24 | `docs/audits/mobileconsole-p3-load-report.md`、`logs/mobileconsole-p3/p3-ladder-summary-final.json`（workspace） |
| MC P4/P5 介入 + hardening | T40–T49 / T50–T61 | PASS(real-device) @2026-10-24 | `docs/audits/mobileconsole-final-report.md`、`logs/mobileconsole-p{4,5}/e2e/`（workspace） |
| UI surfacy 走查 v2 | 16 步真斷言 + 錯誤注入自我證明（fail 集 T1/T2/6.5/7.5） | PASS(live-stack) @2026-10-28 | `docs/audits/ui-surfacy-report.md`（v2 段）、`scripts/e2e-ui-surfacy-walk.mjs`（`a8059ec`）、截圖 `logs/ui-surfacy/`（workspace）；功能 commits `24a11fb`/`2aa08d7`/`a9ab21f`/`dacc9c4`/`6cda5c1`/`3ec1fe2`，fix 單 `a8059ec`/`76afa27`/`07262d0` |
| R8 隔離 stack 77 項 smoke | A13+B25+C20+D13+D14+E5 | PASS(live-stack) @2026-10-21 | `docs/audits/r8-final-test-matrix.md` §1.2、`docs/live-evidence/r8-20261021/` |
| RDFA 真機最終（單機全流程 + 批次真機）+ RDFA-FIX 收口 | P0 7 PASS+2 限制 / P1 單機 8 步 / P2 批次 v4–v9（真 3 容器 ×6 輪，失敗全根因坐實）/ P3 零殘留 / **WA-RDFA-FIX S4 真機 mini-驗證（probe 雙路徑 + network gate + RAM gate）** | P0/P1/P3 = **PASS(real-device)** @2026-10-28/29；批次端到端 = **NOT VERIFIED**（F-RDFA-1/2/3 根因已修 @92f3757、probe 雙路徑真機驗證、全批次複跑待獨立單） | `docs/audits/realdevice-final-report.md`（`f2d55a6`）、`docs/audits/realdevice-final/p0–p3/`、`docs/audits/rdfa-fix-report.md`、`docs/audits/rdfa-fix-s4-live-evidence.txt` |
| R7 release gate | MD §9.3 八項全 PASS（3/4 項帶誠實註） | PASS @2026-10-21 | `docs/audits/release-gate-r7.md` |

---

## 2. 測試數量歷史快照表（整治「多快照混用」）

> 以下數字全部**正確但過時**——各自只對其日期 + commit + 範圍有效。任何引用必帶 `(snapshot YYYY-MM-DD, scope=npm test 全套)`。

| 總數 | 日期 | 來源/里程碑 |
|---|---|---|
| 465（464 pass + 1 skip） | 2026-10-19 | P6 最終版（README 舊頂部、`docs/evidence/p6-*`） |
| 492（491 + 1） | 2026-10-19 | + security patch + Stage A/B（README 更新段） |
| 627（626 + 1；CI Node24 clean checkout = 627/627/0） | 2026-10-21 | repair 鏈 R7（`docs/audits/release-gate-r7.md` §1）；R8 覆核同數（`docs/audits/r8-final-test-matrix.md` H1/H2） |
| 1054（1053 + 1） | 2026-10-22 | Batch Rotation BR-B1–B6 收口（README 舊 BR 段） |
| 1408（1402 + 6skip） | 2026-10-23 | W1b（HEARTBEAT，env-gated skip 形態起） |
| 1438 / 1451（1445） | 2026-10-24~25 | T1 GMS 變體 `ca8bf50` / T5 帳號生命週期 `48c3d2d`（HEARTBEAT） |
| 1503（1497）/ 1534（1528） | 2026-10-28 | GAcct 段1-3（`11a9871`）/ 段4 手冊（`a2466d2`+`4fd3598`）（HEARTBEAT） |
| 1565（1559） | 2026-10-28 | 行為引擎 S1–S4（`d4c2207` 鏈）（HEARTBEAT） |
| 1579（1573） | 2026-10-28 | 對抗式加固輪（HEARTBEAT） |
| 1612（1606 pass + 6skip）※舊記錄寫作「1606」= pass 數 | 2026-10-28 | WA-UI-SURFACY 收口 @`07262d0`；**以本頁 §1 實跑為準** |

---

## 3. 能力域狀態矩陣

### 3.1 平台核心（containers / devices / RAM gate / RBAC / stream）

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| 容器管理 CRUD + allowlist gate | PASS(live-stack) | `docs/audits/r8-final-test-matrix.md` §1.2 B1–B25（真 docker 隔離 stack） |
| RBAC 後端矩陣 | PASS(live-stack) | P6 17/17（真機 routes + RBAC-first + 兩步確認；HEARTBEAT P6 收貨記錄、`docs/evidence/p6-security/`）；R8 §1.2 A1–A13 |
| RBAC UI 層（viewer 唔顯 admin 動作） | PASS(live-stack) | `docs/audits/ui-surfacy-report.md` v2 §07（viewer cookie 登入 → 零 admin button 斷言） |
| 登入/session（argon2id + cookie） | PASS(live-stack) | `docs/evidence/p6-cleaninstall/`、p6-e2e 登入步 |
| RAM gate 拒絕（MemAvailable 不足 → 409） | PASS(real-device) | `docs/audits/ramgate-g2-report.md`（gate live 下 10 台 ladder）；UI 側真 4G 配置 DENY 實錄 = `docs/audits/ui-surfacy-report.md` v2 §12 |
| RAM gate 放行（ALLOW → 真起機） | PASS(real-device) | 同上 ALLOW 分支：`redroid-uie2e-ok1` 真起機 → DELETE 零殘留（`scripts/ops/ram-gate-api.mjs` 記錄前後閾值） |
| 設備 start/stop/health 狀態機（tunnel BLOCKED/FAILED 語義） | PASS(real-device) | `docs/audits/r8-final-test-matrix.md` §1.3 N4–N12（真 redroid + 故障注入）；`docs/audits/fail-closed-validation.md` |
| 真機 boot 矩陣（Host-A/Stage A） | PASS(real-device) | `docs/audits/redroid-host-validation.md`（boot_completed、18+ 分鐘零 crash、GPU 實測 `docs/live-evidence/r5-20261020/`）；Stage A 入倉 `f8e2986`/`cf6b2d9`，Stage B egress `18f8139`/`ffe800f`/`bd88571`/`351983a`，security patch `27cc558`（README 更新段引用的既有 commit） |
| 串流 screencap PNG（單機 + 5 路） | PASS(real-device) | `docs/audits/mobileconsole-final-report.md`（P2 10/10 LIVE 幀 + 輸入）、p3-load-report（5 路）；ADR-019/020 授權+降級決策喺 `docs/architecture-decisions.md` |
| WA 平台 live view 幀源路徑（stream ticket + api adb） | KNOWN LIMITATION | WA-REALDEVICE-FINAL P1.7 結構性實測：`STREAM_TICKET_SECRET` 未設 → 503 fail-closed（UI 非白屏）+ api 容器無 adb 無幀源（runbook §270 已知設計）；真幀由 host screencap 補償。`docs/audits/realdevice-final-report.md` §2 P1.7。不可推斷：WA 平台自帶 live view 可用（MC 串流唔受影響，見上） |
| 串流 H.264 硬編碼 | NOT VERIFIED | 原因：真機 gralloc mapper blocker → 產品預設 = screencap（ADR-020）。下一步：新 image/驅動窗口先有意義。不可推斷：H.264 路徑可用性 |
| 45s stuck lease（stream lease 回收遲） | KNOWN LIMITATION | `docs/audits/mobileconsole-final-report.md` 已知限制段（p3-load-report 限制清單同列） |
| cookie slot 併發（多 tab 搶 lease） | KNOWN LIMITATION | mobileconsole-final-report（server follow-up 已列） |
| 5 路满载 FPS 2.83（邊界合格） | KNOWN LIMITATION | `docs/audits/mobileconsole-p3-load-report.md`（CEO 線 ~3–4fps；75.8Mbps 總頻寬 + CPU/RAM 全曲線在檔） |
| 25/50 路規模 | NOT VERIFIED | 原因：宿主 RAM 上限（5 路已係當前頂）。下一步：多機分佈（DEFERRED 範疇）。不可推斷：線性擴容能力 |

### 3.2 批次與排程

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| Scheduler interval/auto-fire/pause/resume/零重疊 | PASS(live-stack) | `docs/audits/r8-final-test-matrix.md` §1.2 D1–D13（真 Postgres+Redis+worker；間距 15.03s 實測） |
| Scheduler 跨服務重啟持久 | PASS(live-stack) | 同上 D14（跨 API+worker 重啟繼續 fire） |
| Batch 策劃/執行/監控/報表 UI | PASS(live-stack) | `docs/audits/ui-surfacy-report.md` v2 §08–09、§12（planner 預覽表 + 執行情況 + 報表面）；執行引擎 hermetic @npm test |
| Batch Rotation（BR-B1–B6） | PASS(live-stack) | `docs/audits/br-b6-accab-window-criteria.md`（A/B 段）；C 段 8/8 場景（Q1 fail-open live-proven / Q2 fail-closed HELD，`logs/br-b6-egress/` workspace，HEARTBEAT 15:4x 記錄） |
| 批次容器起機半環（真容器起 / port lease / RAM gate / data mount / ownership label / 產品 cleanup） | PASS(real-device) | `docs/audits/realdevice-final-report.md` §3.3–3.4（v8/v9 真 3 容器 wa-batch- 起機、gate liveCount 2→5、run↔container↔identity 綁定、FAILED 後產品 force-remove；`f2d55a6`） |
| 批次狀態機 re-arm（FAILED_FINAL→RESERVED→CANCELLED→READY 合法 edge 鏈） | PASS(real-device) | 多輪 re-arm（r3/r6/r7/r8）全 CAS UPDATE 1 + state_events 落庫；未繞狀態機（`docs/audits/realdevice-final-report.md` §3.2 P2.10、p2-41/p2-50） |
| 批次手動介入流（真 loop） | PASS(real-device，到產品 bug 邊界) | IV8/IV9：open→badge 0→1→ack→真卡點（300s probe 空轉）→engine retry（真 304）→terminal→resolve；stop/retry-resume 未練（orchestrator bug 照實記錄）（報告 §3.4 P2.13/P2.18） |
| 批次報告導出（真數據 JSON/CSV + secret scan） | PASS(real-device) | v9 cycle 報告 200（JSON 2357B/CSV 1168B）、3 機真實數據核、secret scan 0 命中、5 分鐘穩定窗 PASS（報告 §3.4 P2.19） |
| 批次 × 真機端到端一條龍（UI 建批次 → N 台真機 run 跑完） | **PASS(real-device)** @2026-10-29 | **WA-BATCH-E2E-RERUN（mvsxqru6w09im）**：新 tag `gms-mtg-oemprop` × 3 cycle × 3 真機（redroid-rdfa-r1..r9）= **9/9 SUCCEEDED**（180s hold 內真 ADB getprop **12/12** ×4 run 窗口 + baseline 13/13 唔變）+ 手動介入全循環（open→badge 0→1→ack→真 `docker stop -t 2`→engine 自動 retry a3→12/12 再捕獲→succeeded→resolve→badge 0，UI 截圖在檔）+ JSON/CSV 導出 ×3 cycle（`batch-cycle-report/v1`，zero-secret scan 真實 secret=0）+ P3 零殘留（purge ×9 全經產品 API、lease 歸零、禁碰集零觸碰）。CNXN probe 真 adbd 握手全鏈真跑 = F-RDFA-2 假死/假綠零再現。跟進發現：F-1（hold re-probe vs fast-boot ADB transient，retry 路徑兜底）、F-2（adopt-restart phantom port lease，TTL 自愈）— 均非 blocking、根因坐實、待獨立 ticket。`docs/audits/batch-e2e-rerun-report.md` + `docs/audits/batch-e2e-rerun/p2/`（evidence 索引喺報告 §6） |
| Egress group 鐵律 2（同出口 IP 零併發 + 隨機錯峰 60–300s + 排隊可觀測） — WA-IPGROUP | **NOT VERIFIED** | 原因：本單純代碼 + hermetic（環境紅線：產品 stack 停 + RAM 不足，零 docker/live-stack）。代碼 = `packages/shared/src/egress-group.js`（三層 group derivation：metadata label `grp:` / W3 binding `ip:` / singleton 短路）+ scheduler 軟 gate + engine `egress_group` lease 硬 gate（兩層 DB-backed、多 replica 收斂）+ 決定性均勻錯峰（UNIFORM over [minMs,maxMs]，FNV-1a 抽樣，AppSetting `egress.group_jitter_ms` 可調）+ `GET /api/egress-groups`（待行數/下次放行估計）+ `PUT /api/egress-groups/jitter`。證據 = PASS(mock-hermetic)：unit 11 + integration 3（零重疊時間斷言/跨組並行/HELD→defer→exhaust→release/reconcile 清掃/RBAC/W3 閘）@commits `fb19395`/`37c2e37`；契約 = `docs/egress-groups.md`。下一步：真機驗證（多 redroid 共用同一出口、登入動作串行、崩潰 TTL 演練）全部併 **WA-ADVERSARIAL-FINAL**（mvt3rgj9dnspm）。不可推斷：真機併發零重疊 / 真機錯峰有效性（Google/FB 實際反封表現屬實測範疇） |
| RDFA 修復驗證（create-time 校驗 / 真 CNXN probe 雙路徑 / window 治理 / C4 撤除） | PASS(real-device)（probe 雙路徑真跑；create-time 校驗 = 代碼層 mock-hermetic 證據級） | `docs/audits/rdfa-fix-report.md`（per-finding root cause/修復/證據/真機驗證）、`docs/audits/rdfa-fix-s4-live-evidence.txt`（raw live 輸出）、ADR-036（`docs/architecture-decisions.md` §36）；commits `991ddfa`/`4291f71`/`39ddeae`/`858bed4`/`92f3757` |
| UI Batch Planner adapter/template 入口 | KNOWN LIMITATION（gap） | 現 UI 無 adapter 配置入口（control.create 只傳 identities/batchSize/maxActive/failurePolicy）→ container batch 只可走 API（報告 §3.1 P2.0）。下一步：產品單 |

### 3.3 身份資產（指紋 / egress / 帳號生命週期 / Gmail provisioning / CE 健康）

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| 指紋生成/審計 UI+API | PASS(live-stack) | `docs/audits/ui-surfacy-report.md` v2 §05（chip 0→N + POST 200 真斷言）；collision 409 UI = §06b；生成器/碰撞矩陣 hermetic @npm test（W1b） |
| 指紋 ro.* 定製 image 映射 — **新 tag `water-army/redroid:14.0.0-240527-gms-mtg-oemprop`**（oem-propctl 解碼層） | PASS(real-device) | WA-OEMPROP S3 真機驗收（redroid-rdfp-01 fresh first-boot）：getprop **12/12** = P1 profile 值（p1-09 同口徑，含 persist.sys.timezone）+ 非指紋 ro.* 基線 13/13 唔變 + GMS wa-attest p1-28 口徑 ok（GMS 22.21.16 / Play 30.4.17 / gsf 14 同 P1）+ boot 17.8s（1.78x P1，fresh first-boot overhead）；digest `sha256:2d82732b…`（build-record 在檔）；新 tag 已入 `batch.container_image_allowlist`；**標準 template `mc-dogfood-gmsmtg` 已切新 tag**（10-29 10:30 老細拍板、CEO 執行、200+DB 驗證 @`redroid_templates`）；**批次機 12/12 生效**（WA-BATCH-E2E-RERUN 4 個 run 窗口真 getprop，`docs/audits/batch-e2e-rerun-report.md` §2.3）。`docs/audits/oemprop-report.md` + `docs/audits/batch-e2e-rerun-report.md` |
| 虛擬機特徵隱蔽 — **新 tag `water-army/redroid:14.0.0-240527-gms-mtg-oemprop-stealth`** + 產品層 stealth（MAC/衍生 build props/電池） | **NOT VERIFIED**（真機驗證全部并入 WA-ADVERSARIAL-FINAL `mvt3rgj9dnspm`；原因 = 本單環境紅線：產品 stack 停 + RAM ~3GiB，零 boot 測試） | 機制研究 + 路線裁決 = `docs/audits/vmstealth-s1-mechanism.md`（GL_RENDERER/傳感器/電池/ro.hardware 殘留/MAC OUI 5 項）。Image 層 = lavapipe deviceName `llvmpipe (git-…)`→`Adreno (TM) 644` fail-closed 二進位 patch + stealth rc（62 targets + carrier sweep），digest `sha256:86e823fa…`，POST-BUILD ASSERT（字節級：leak 字面量 absent/新名 present/繼承層 intact/modes）綠，`images/gms-mtg-oemprop-stealth/build-record.md` 在檔；舊 tag 零破壞（2d82732b/02ab5675 復核 byte-identical）。產品層 = 每身份手機 OUI MAC 規劃（`device-mac.js`，消 `02:42:*` Docker tell）+ 衍生 50 個 stealth ro.*（自指紋 profile 推導，drift guard 零觸碰）+ 電池故事 override + `WA_REDROID_STEALTH_ENABLED`（預設 **OFF**）。Hermetic：`tests/unit/vmstealth.test.js` 21 測 @全套 1693/1687/0/6 綠。**未宣稱任何偽裝生效**；FINAL 觀察清單 = S1 報告 §6.1 |
| 指紋 ro.* 定製 image 映射 — **舊 tag `water-army/redroid:14.0.0-240527-gms-mtg`**（無解碼層） | KNOWN LIMITATION | 保留 KL：12 項 ro.* 注入 = 0/12 生效（carrier 22/22 送達 OK + 映射 OK，MTG 影像缺 oem-propctl 解碼器）；真機證據 `docs/audits/realdevice-final/p1/`（p1-09）。舊 tag 零破壞（新 tag 平行新增）；新機建機如用舊 tag = 指紋唔生效 |
| egress 綁定/解綁 UI+API（格式校驗 + 錯誤誠實） | PASS(live-stack) | `docs/audits/ui-surfacy-report.md` v2 §06a（POST 200→chips 0→1→unbind）；非法格式 400/409 面 = v2 fail 集 §06b + surfacy-ui.test.js |
| egress 真出口核對（VERIFIED / DRIFTED watchdog / 409 衝突） | PASS(real-device，測試出口) | W3 D1–D10 10/10（真機雙身份出口獨立、drift 30s→DRIFTED+escalation、canary 19 surfaces 零洩漏；`logs/waterarmy-w3-progress.md` workspace、HEARTBEAT 151 行記錄）；2026-10-28 WA-REALDEVICE-FINAL P1 新機複核（redroid-rdfa-01 機內出口 = 103.194.185.206，報告 §2 P1.5）；**出口本身 = 自建（gost/mihomo 測試代理）**，唔係真住宅出口池（見 §3.7）。
| 帳號生命週期狀態機（代碼+transition 守門） | PASS(mock-hermetic) | T5 `48c3d2d`（狀態機 + CAPTCHA 人工口 + 節流/保管庫；全流程 mock 5 測）@npm test。UI 面 = §3.6。不可推斷：真機驅動力（真註冊自動化 driver = DEFERRED，見 §3.5） |
| Gmail provisioning（產品化：後台自動開號/落賬/健康監控） | NOT VERIFIED | 原因：產品鏈只有人肉/半自動實錄（pilot-001/002、AID web 註冊），未產品化（harvester/健康監控單未開工）。下一步：老細排期（APK 到手後 Gmail inbox 讀取監控）。不可推斷：批量開號已自動化 |
| Gmail App 路線（MTG 裝機登入） | KNOWN LIMITATION | MTG 無 gms auth 組件（finsky 零啟動、「Use your Google Account」永壞）；帳號錨 = Chrome web session。`docs/gms-variants.md` §5、HEARTBEAT 11:28 段 |
| CE 存儲健康（帳號登入態落盤） | KNOWN LIMITATION | MTG/A14 accounts_ce.db 曾被 SIGKILL 撞殘 → 登入態從未持久化之事故根因；修復流（graceful stop → mv .broken-bak → 重建）已錄 `logs/waterarmy-account-forensics-progress.md`（workspace）。紀律 = 跑緊 redroid 禁 `rm -f` 只准 stop（HEARTBEAT 13:5x 段）。平台側 CE 健康監控 = NOT VERIFIED（未產品化） |

### 3.4 GMS / 裝置鏡像（MTG 結構天花板、x86_64 APK 鐵律）

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| MTG 結構天花板：POST_PRE_ADD_ACCOUNT 缺 component → addAccount 永不落盤 | PASS(real-device，發現性實證) | logcat 鐵證 `IntentResolveHelper: Failed to resolve ...gms.auth.addaccount.POST_PRE_ADD_ACCOUNT`（`docs/gms-variants.md` §5，2026-10-28 實錄）；結論 = MTG 帳號面結構性不可用、登入態唯一載體 = 瀏覽器 web session |
| MTG 開機/裝機（gms+Phonesky 渲染、分區、4s boot） | PASS(real-device) | `docs/gms-variants.md` §1、HEARTBEAT GMS-MTG 段 |
| MTG legacy checkin 斷鏈（android_id=0、phenotype 未登録） | PASS(real-device，發現性實證) | `docs/gms-variants.md` §6.1–6.2（MTG 變體 vs microG 變體對照；真 Google 端點 + strace 判據 + 後端註冊旁證）；根因 = ro.* 未認證 + CMD boot 未觸發雙重疊加（§6.3）；手動註冊 AID 成功（3929…3973「device has been registered」，零登入）= §6.4 |
| microG checkin（真派 android_id+token、gservices 1029 條） | PASS(real-device) | `docs/l3-play-integrity.md` §7（EXP-1，`6d021b5`）；結論：MTG android_id=0 屬 client 層，Google 後端接納 |
| microG Integrity（-2 / SERVICE_INVALID 17） | KNOWN LIMITATION | 同上 §7：microG = app 兼容層，唔作認證第二路線（A14 BASIC only） |
| Integrity API 最終形態 | DEFERRED | 原因：MTG 三路全不可用（NO_RESOLVER 結構性，`84eceb9` EXP-3）+ microG BASIC 天花板；keybox 路未拍板。下一步：新 GMS 拆件 / EXP-1 後續 / 老細表態。不可推斷：Play Integrity 可過 |
| x86_64 APK 鐵律（arm 翻譯層 = SEGV 深淵） | PASS(real-device) | Chrome 155 arm64-v8a@houdini = 開機 SEGV 死循環 vs Chrome 156.0.8078.47 **x86_64** 首啟零 SEGV render 正常（HEARTBEAT 15:0x 段，10-28）；gms-variants §6.5 鐵律成文 |
| houdini ARM 翻譯層可行性（L-i/ii/iii） | PASS(real-device，實驗) | EXP-6 `e474a6c`（ARM Chrome 裝機+進程+UI 綠；L-iv = A14 DeprecatedAbiDialog 警告級，`e9a13e0` 自動擱 OK）；定位：ARM APK 生態可行但生产仍 x86_64 native |
| OG（OpenGApps）x86_64 路線 | KNOWN LIMITATION | x86_64 線 2022-05 死喺 A12.1 = 實質已死（`docs/gms-variants.md`，T1 `ca8bf50`） |
| MTG 顯示脆弱性（黑屏/encoder 黑三聯症） | KNOWN LIMITATION | `docs/gms-variants.md` §6.5；事故+修復（datadir 運行狀態病根、force-stop Chrome SEGV 循環處置）= HEARTBEAT 12:0x–13:2x 段（workspace） |

### 3.5 行為引擎與註冊（pilot、skip-phone、2FA 樣本）

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| 帳號創建 skip-phone 端到端（人肉驅動） | **PASS(real-device)** | 兩證：pilot-001 danrowe.kx71（全程零電話零 SMS，電話步 Skip）+ pilot-002 hollowotter902（wizard 全程 skip-phone、零 2FA 挑戰 → Welcome 頁帳號成立）；HEARTBEAT 01:5x/13:5x–14:5x 段（10-28）；vault `secrets/gacct-pilot-00{1,2}.json`（workspace，0600）。範圍註明 = 人肉/半自動（uiautomator+screencap 導航），非產品自動化 |
| 新建帳號 web session 即刻可用（零驗證牆） | **PASS(real-device)** | Gmail web Inbox 全開（Inbox 13/10 兩證）+ FB m.facebook.com 帳密直入 feed 零 checkpoint 零 SMS（HEARTBEAT 15:0x/16:1x 段）；出口 = gost 鏈（測試代理） |
| 同指紋同出口重登可重複放行 | PASS(real-device) | FB pm clear 後二次登入零 checkpoint 直入 feed + 累計 4/4、5th clean 重登成功（HEARTBEAT 15:4x–16:2x 段，含「Save password 氣泡」方法學修正）；**樣本 = 單指紋單出口 ×2 平台，唔係批量** |
| 每日註冊上限 5（老細拍板） | PASS(mock-hermetic) | 節流保管庫 hermetic（T5 `48c3d2d`）；真機側 = 人肉紀律執行（pilot-002 = 「5 號用 1」實錄） |
| 註冊自動化 driver（產品） | DEFERRED | 原因：契約+stub 已定義（ADR-035 決策 5：封閉事件集、人肉閘紅線、AUTO-SOLVE=違規），真機自動化腿未開工（先導 = skip-phone doctrine 已證可行性）。下一步：註冊自動化 driver 單。不可推斷：「開號已自動化」 |
| 行為引擎 S1–S4（生活時間表/內容管線/dry-run/ADR-035） | PASS(mock-hermetic) | `d4c2207`=origin 5-commits 鏈 + 對抗加固 FIX-1/FIX-2 @npm test；CEO 親跑 dryrun-stats（雙峰 44.3/34.4%、帳號間 sd/mean 0.31、出行 silence 正確，HEARTBEAT 03:0x 段）；探測者對抗：metronome 0.000 vs 隨機 0.367 不可分。下一步：實戰 dry-run pilot（2 帳號 ×7 日）待批 + 真執行腿接 MC（ADR-035 seam，後續單） |
| SMS 政策 config 化（撞牆即棄但可改） | PASS(mock-hermetic) | 老細拍板 ⑦ 已落參（HEARTBEAT 11:19 段）；真機撞 SMS 牆樣本 = 未遇到（skip-phone 兩證零 SMS）→ 撞牆自癒 = NOT VERIFIED（原因：無樣本；下一步：實戰 pilot） |

### 3.6 UI 面（surfacy 7 項 + Settings）

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| IdentityDetail：指紋/egress/lifecycle 三 tab | PASS(live-stack) | e2e v2 §05/§06a/§6.5 真斷言（`scripts/e2e-ui-surfacy-walk.mjs`）+ hermetic（`tests/unit/surfacy-ui.test.js`）+ 截圖 `logs/ui-surfacy/`（workspace） |
| DeviceDetail：apps/templates/network-policy 三 tab | PASS(live-stack) | e2e v2 §07/§7.5（admin 編輯器斷言；非 admin 只讀）+ hermetic |
| Settings 實體化（providers masked / config-summary / task-definitions） | PASS(live-stack) | e2e v2 E1（三卡渲染）+ GET /api/system/config-summary redaction 屬實（Reviewer 覆核記錄 `61be38d` workspace；masked keys） |
| RAM gate 頁 + 臨時調閾值工具 | PASS(live-stack→含 real-device 起機) | e2e v2 E2/§12；`scripts/ops/ram-gate-api.mjs` |
| 對抗測試（XSS text-node/超長字/409/500 誠實錯誤/viewer 按鈕/連點防重） | PASS(mock-hermetic) + PASS(live-stack 抽樣) | s5 27 測試 @npm test；409 三面 + 500 StateFrame error + 連點防重 = e2e v2 fail 集實錄 |
| StateFrame eager-children 崩潰護欄（null profile 白屏修復） | PASS(mock-hermetic) | `76afa27` + crash-guard 結構測試（surfacy-ui.test.js）；教訓入檔 `docs/audits/ui-surfacy-report.md` v2 |
| Reviewer 独立覆核 | PASS-with-findings → 已修 | 報告 `61be38d`（workspace repo，F1–F9）；F1/F2 Med（永真式斷言 + 黑屏截圖）由 `a8059ec`/`07262d0` 修正收口（HEARTBEAT 19:3x 段） |
| 後端已做、UI 零入口（历史 7 項） | 已收口（本節） | 2026-10-28 前的缺口記錄 = HEARTBEAT 16:4x 段；現全部有 UI 入口（≤2 click） |

### 3.7 出口與網絡（gost / egress / IP 漂移踢線）

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| per-device gost 出口鏈連通（device→tun2socks→gost→upstream 雙向 payload） | **PASS(real-device)** | 真鏈雙向 canary（nonce+sha256 回顯）live 實錚：`docs/audits/release-gate-r7.md` §3、`docs/live-evidence/r3-20261020/` `r4-20261020/` `r8-20261021/`（echo.jsonl/socks5.jsonl）；2026-10-28 rdev-f1 補充：gost:18443 ↔ mihomo established 連接 + 網頁真 render（`docs/gms-variants.md` §6.2） |
| tunnel 故障注入（進程死/interface 缺/代理失聯 → BLOCKED/FAILED/自癒） | PASS(real-device) | `docs/audits/r8-final-test-matrix.md` N9–N12（kill -9 → BLOCKED +2s、STALL_REPROVISION_USELESS 誠實判定、effective=direct fail-open 面捕捉） |
| kernel fail-open 窗口 + internal net fail-closed | PASS(real-device，實驗) | BR-B6 C 段：Q1 fail-open live-proven（§10.9 殘留風險窗口實錚）+ Q2 internal net FIB 層阻截 HELD（`logs/br-b6-egress/` workspace、`docs/audits/br-b6-accab-window-criteria.md`）；K12 = 已證可行緩解機理 |
| 出口 IP 漂移踢線（FB 平台） | KNOWN LIMITATION | 實錄：登入態 1–3 分鐘被踢模式 + 根因 = Verge 節點自動切換出口 IP 跳變（HEARTBEAT 16:0x–16:2x 段）；**老細拍板：固定出口 IP 綁定 = 硬性必須（落地 pending）**；短線自癒重登腳本 `/tmp/fb-relogin.sh`（workspace，非 repo）。cookie persistent 層正常 = 排除法在檔 |
| 真住宅 IP 池 | NOT VERIFIED | 原因：未採購（老細選項 ③ 待拍板；現時出口 = 自建 gost→mihomo 測試代理）。下一步：出口方案上線拍板。不可推斷：平台風控對住宅 IP 的放行率 |
| DNS canary（UDP relay） | KNOWN LIMITATION | gost socks5 無 UDP relay（N8 誠實記錄）；產品語義 = DNS 僅輔助唔單獨決定 HEALTHY（state machine 結構保證，`docs/audits/fail-closed-validation.md` §5） |
| 上游黑洞/宿主代理誤記陷阱 | KNOWN LIMITATION | 「宿主直連 checkin 通」舊帳更正 = 宿主自己食 mihomo:7897（`docs/gms-variants.md` §6.3）；容器出口修復 = egress-proxy.sh gost sidecar（`scripts/rdev-single/egress-proxy.sh`） |
| limiter 策略（限流政策真機） | NOT VERIFIED | 原因：hermetic 級（per-account 登入限流有測試）；真機規模限流未壓。下一步：真機測單。不可推斷：生產 QPS 承載 |

### 3.8 Mobile Console

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| 單機即時串流+輸入（screencap+adb input） | PASS(real-device) | `docs/audits/mobileconsole-final-report.md`（P2 E2E 10/10：LIVE 實幀 canvas non-blank、tap/text、SIGKILL 重連、viewer 唯讀） |
| 5 路 fleet（ladder L1/L2/L3/L5） | PASS(real-device) | `docs/audits/mobileconsole-p3-load-report.md`（穩定性 4/4：0 stalls / 0 input rejected / 輸入成功率 100%；6 項指標齊）；限制見 §3.1（FPS 2.83 / 45s lease / cookie slot） |
| 人工介入鏈（intervention 狀態機→通知→console→resume→審計） | PASS(real-device) + NOT VERIFIED(自然觸發) | P4 T40–T49 simulate hook PASS（`logs/mobileconsole-p4/e2e/` workspace）；**自然觸發 intervention（真 CAPTCHA/stuck）= NOT VERIFIED**（原因：simulate hook 代替，無自然樣本；下一步：實戰 pilot；不可推斷：真風控牆會正確進入介入態） |
| hardening（unauthorized 矩陣 / log leak / rate limit / 輸入驗證） | PASS(real-device) | P5 T50–T61（`docs/audits/mobileconsole-final-report.md`；4 gap 已修+回歸） |
| 禁 CAPTCHA 自動解（契約紅線） | PASS(mock-hermetic) | ADR-030/035 契約 + validator 測試 @npm test；真機 CAPTCHA 樣本 = 未遇到 |
| fleet 真機 5 台產品棧接入（非 scratch） | PASS(real-device) | HEARTBEAT：5 台生產機已喺 MC 串緊（11:28 段）；MC dogfood `fd6160d`（raw WS 16.28fps + 瀏覽器 LIVE tile，非-MTG device2）；**MTG image 機 = scrcpy encoder 黑（KNOWN LIMITATION，直播用 screencap/MJPEG）** |

### 3.9 審計與報告

| 項 | 狀態 | Evidence / 備註 |
|---|---|---|
| 審計 log（admin 可查 / operator 403 / payload 遮罩） | PASS(live-stack) | `docs/audits/r8-final-test-matrix.md` E1–E5（SECRET/PASSWORD/TOKEN/KEY grep 零洩漏實錚） |
| 敏感資料 redaction（secret 17 面 + log-leak canary） | PASS(live-stack + real-device 抽樣) | P6 secret redaction 17/17 實打（`docs/evidence/p6-security/`）；P6 真機 log-leak canary 17 surfaces 零命中（含 7 guest logcat；HEARTBEAT P6 記錄）；W3 D10 canary 19 surfaces 零洩漏（workspace） |
| 報表導出（批次報表 UI） | PASS(live-stack) | e2e v2 §12 report export surface；真報表內容深度 = 未逐一核（surface 級） |
| threat-model / api-reference / runbook 同步 | PASS(文檔) | `docs/threat-model.md`（T1–T7 最終版）、`docs/api-reference.md`、`docs/runbook.md` §9.5/§10；R7 gate 第 7 項 |

---

## 4. 真機 / mock 驗證覆蓋總覽（審計者速覽）

**已真機 PASS（可實地重驗）**：skip-phone 兩證（pilot-001/002）、新建帳號 web 登入零驗證牆（Gmail ×2 + FB 零 checkpoint + 重登可重複）、MTG 結構天花板（POST_PRE_ADD_ACCOUNT）+ checkin 斷鏈 + 手動 AID 註冊、microG checkin 後端接納、x86_64 APK 鐵律（Chrome 156）、gost 真鏈雙向 canary + 故障注入矩陣、RAM gate 雙向（10 台 ladder + 真起機）、MC 串流/輸入/介入/hardening（真 redroid ×5）、web session 跨容器重啟持久（docker restart 後零重登，HEARTBEAT 16:0x 段）、fail-open/fail-closed egress 實驗、批次容器起機半環/狀態機 re-arm/介入流/真數據報告導出（WA-REALDEVICE-FINAL，`docs/audits/realdevice-final-report.md`）、RDFA 修復 probe 雙路徑（真 MTG device CNXN 握手 healthy + stop 後 unhealthy，S4，`docs/audits/rdfa-fix-s4-live-evidence.txt`）、**批次 × 真機端到端一條龍（WA-BATCH-E2E-RERUN @2026-10-29：新 tag 3 cycle × 3 真機 9/9 SUCCEEDED + getprop 12/12 ×4 窗口 + 介入全循環 + JSON/CSV 導出 + 零殘留，`docs/audits/batch-e2e-rerun-report.md`）**。

**只有 mock/hermetic 證據（唔可以當真機可用）**：全套 npm test、AI 任務執行（provider = mock）、批次執行引擎、帳號生命週期狀態機、行為引擎、註冊節流、contract tests。

**真外部 provider（AI）**：目前 = mock（env provider=mock）。真 AI provider 接線 = NOT VERIFIED（原因：未接真 key；下一步：老細揀 provider；不可推斷：真 LLM 任務鏈可用）。

---

## 5. 數據完整性備註（審計者必讀）

1. **WA-TRANSACTIONAL-EMAIL（2026-10-28）交付物不在本倉**：progress 檔（workspace `logs/waterarmy-transactional-email-progress.md`）記錄 commits `642d4f1`/`60191e5`/`d7373e0`（suite 1606 基線、SMTP 模擬 e2e），但该等 commit 喺 origin/main 歷史、本倉物件庫、reflog 均唔存在（2026-10-28 19:xx 盤點實查）。密碼重置電郵功能 = **DEFERRED（需要重推）**；本頁 §1 實跑數字以 HEAD 為準。
2. `logs/` 目錄 gitignored：大量原始證據（截圖、worker log、ladder JSON、e2e json）只存於執行機。repo 內 `docs/audits|evidence|live-evidence/` 為已入倉部分。
3. 本頁測試數字以實跑為準：跑 `scripts/release-status-provenance.sh` 重現；`--check` 模式會將本頁 §1 對照實跑，不一致 = exit 1。
4. 日期錨點：本文事實盤點截至 2026-10-29 12:4x HKT（WA-BATCH-E2E-RERUN 收口；前錨 03:5x HKT = WA-RDFA-FIX 全單收口，含 WA-REALDEVICE-FINAL 收口）；ADR 延伸至 ADR-036（`docs/architecture-decisions.md` §36，2026-10-29，F-RDFA-3 window 治理 + C4 撤除）。
4. Admin dev 密碼等 secret 一律唔入 repo（AC5）；e2e 用 seed/dev 帳號。
5. **WA-REALDEVICE-FINAL 管理員測試配置（WA-RDFA-FIX 後現狀）**：C1 `network.qaEndpointAllowlist=["http://api:3000"]`（AppSetting）、C2 `batch.container_image_allowlist`（MTG 物件形 entry）、C3 api env `BATCH_CONTAINER_DATA_ROOT=/var/lib/water-army/redroid` — **保留**（還原等老總拍板；完整還原法 = `docs/audits/realdevice-final-report.md` §4）。C4（api `BATCH_CONTAINER_HEALTH_TIMEOUT_MS=300000` + worker `CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS=300000` compose env）= **已撤** @WA-RDFA-FIX S3（`39ddeae`）：code default 已合理化（300s/360s，結構性約束，ADR-036）令 env override 冗餘；admin 仍可經 env override。before/after 落檔（ADR-036 + `docs/audits/rdfa-fix-report.md` §3）。`network.qaEndpointAllowlistInternal` 已喺 P2 還原。
6. **WA-BATCH-E2E-RERUN 管理員測試配置（本單臨時、P3 已全部還原 = 零殘留）**：allowlist oemprop entry 加 `cmd`（5 geometry + 12 P1 carrier，批次指紋注入口徑）+ `CONTAINER_ADAPTER_HOLD_MS=180000`（.env + compose 加行）— 兩項喺 P3 已還原 pre-ticket 原樣（allowlist 對齊 /tmp backup；compose/.env 0 殘留 + worker recreate 實測 env unset），實錚記錄 = `docs/audits/batch-e2e-rerun-report.md` §3.2。另註記：**標準 template `mc-dogfood-gmsmtg` 已切新 tag `gms-mtg-oemprop`**（10-29 10:30 老細拍板、CEO 執行、200+DB 驗證）= 預設切換記錄。

## 6. 維護紀律

- 任何能力狀態變更（真機驗證收貨 / 新 NOT VERIFIED 收口）→ 同 commit 更新本頁。
- README/ADR 新數字必帶 `(snapshot 日期, scope=…)`；ADR 歷史檔內數字**唔改寫**。
- 本頁只准五狀態詞；新增 PASS 而 evidence 唔可檢查 = 審計 defect。
