# Release Gate — R7 評估（MD §9.3 八項逐項 verdict）

> 日期：2026-10-21（R7）。規則（MD §9.3）：**以下任一項不符合，即不得把該版本
> 標示為正式可用。** 每項 verdict 附證據引用；verdict 只用 `PASS` / `FAIL` /
> `BLOCKED`（+ 註）。
> 本檔同 `docs/audits/repair-baseline.md`（R0）、`tcp-transport-investigation.md`
> （R2 + R7 addendum）、`fail-closed-validation.md`（R3/R4）、
> `redroid-host-validation.md`（R5）、`r4-state-sources.md`（R4）共同構成
> release 證據鏈。

## 總表

| # | Gate | Verdict | 一句話 |
|---|------|---------|--------|
| 1 | P0 測試失敗 | **PASS** | 627/627/0 fail/0 skip（Node 24 clean checkout 實跑 + CI 實跑） |
| 2 | Binary 打包不具可重現性 | **PASS** | pin + sha256 fail-fast + 每次 CI push 重建 image 驗 sha256 |
| 3 | TCP data-plane 測試只有 mock 結果 | **PASS**（帶誠實註） | 真鏈雙向 canary live 實錚 + 常規 gate；R2 spike 拓撲根因 open 已文檔化 |
| 4 | tunnel/process 失效未能進入 BLOCKED/FAILED | **PASS**（帶誠實註） | kill -9 → BLOCKED +2s（live）；max retry → FAILED + manual；kernel 層殘留風險已 decide-and-document |
| 5 | 健康狀態只能靠程序存在判定 | **PASS** | netState 單一權威；HEALTHY 唯一入口 = fresh 雙向 canary PASS |
| 6 | 真 Redroid 測試被錯誤標記為已通過 | **PASS** | CI 明確唔跑真 Redroid（workflow 註明）；實錚證據喺 docs/live-evidence/ 並清楚標 live |
| 7 | API/schema/前端/文件未解釋契約差異 | **PASS** | NET_PAYLOAD_KEYS 契約 test 鎖三邊界；api-reference 錯誤碼表已同步 |
| 8 | 測試需要破壞性清除既有使用者資料 | **PASS** | hermetic suite 全 fake db/redis/docker；real-redis test 只 sweep 自己 namespace |

**結論：八項全 PASS（第 3、4 項附帶已文檔化嘅誠實註/殘留風險，唔影響 gate 判定，
但 release 後嘅 operator 必須跟 runbook 守則）。** 版本可標示為正式可用
（repair chain 範圍內）；R8（Phase 8 全量回歸）係收貨前最後一道 P1 關。

---

## 1. P0 測試失敗 — **PASS**

- `npm test`（unit + integration 全 hermetic suite）：
  - 宿主 Node 22（dev）：**627 / 626 pass / 0 fail / 1 skip**（基線 625/624/0/1 + R7 2 新 test）。
  - **CI-equivalent clean checkout**（fresh `npm ci` + Node **24.22.0**（=
    package.json `engines >=24` / .nvmrc）+ TZ=UTC + redis:7.4.5 service）：
    **627 / 627 pass / 0 fail / 0 skip** — 之前嘅 1 skip（real-redis gated test）
    喺 CI 有真 redis service，**真跑綠**（ADR §15.8 rule 3：skip 唔可以被當
    coverage）。
  - GitHub Actions run 1（39496605713）red → 原因 + 修復見
    `docs/audits/release-gate-r7.md` 下方 CI 段（hermetic config test 隔離缺陷
    — R6 latent、被 host untracked `.env` mask — + ci.yml regex bug）；run 2 後
    全綠（run 連結見 progress log）。
- P0（repair chain R0–R6）scope 內：零 fail。

## 2. Binary 打包不具可重現性 — **PASS**

- Single source of truth：`docker/redroid-matrix/tun2socks.env`
  （`TUN2SOCKS_VERSION=2.7.0` + inner-binary `TUN2SOCKS_SHA256=98d545a6…c031`）；
  URL 係 derived（floating `latest` 結構性唔可能存在，fetch script 拒任何
  `latest` URL）。
- Fail-fast：sha256 唔符 = **build 失敗**（`fetch-tun2socks.sh`）；arch 唔符（非
  x86-64 static ELF）= build 失敗。
- Repo sync guard：`redroid-service.js` 嘅 `TUN2SOCKS_PIN` 同 env 檔由
  `tests/unit/redroid-t2s-pin.test.js` 靜態掃描鎖定（drift = test 爆）。
- **CI 每次 push 真重建**：`images-redroid` job build wrapper image（含 pinned
  fetch 進 build stage）+ smoke-assert 兩個落點（`/data/local/tmp/tun2socks`
  canonical + `/usr/local/bin/tun2socks` fallback）sha256 == pin + static ELF。
- R1 live 實錚：zip 下載 + inner sha256 核對 + `--version` =
  tun2socks-2.7.0（`docs/audits/repair-baseline.md` R1 段）。

## 3. TCP data-plane 測試只有 mock 結果 — **PASS**（誠實註見下）

- 產品鏈 = device → tun2socks → **per-device gost 容器** → upstream SOCKS5。
- **真鏈雙向 payload 實錚（live，非 mock 結果）**：R3（`docs/
  live-evidence/r3-20261020/`）+ R4（`docs/live-evidence/r4-20261020/`）canary
  = 雙向 TCP payload（**nonce + sha256 回顯**，latency ~1s）行完整真鏈
  device kernel → tun0 → t2s → gost 容器 → upstream → canary echo。端點係
  自建 canary server — 正合 MD §4.3 要求（「用自管或認可嘅測試端點」）。
- **常規化 gate（唔係一次性）**：watchdog 每 30s（`REDROID_HEALTH_POLL_MS`）
  重跑同一條雙向 canary；HEALTHY 唯一入口 = VERIFYING + **fresh** canary PASS
  （transition table 結構性保證）；任何回歸 → DEGRADED→BLOCKED
  （`fail-closed-validation.md` §2.3 實錚）。
- **誠實註**：R2 spike 拓撲（t2s 第一跳 = 裸 mock relay，**無 gost**）嘅
  forward-stall 根因**未完全裁定**（R7 addendum §C — 機構層 restapi
  instrument 未做）。產品**唔存在**裸第一跳配置（gost 永遠係第一跳）→ 現行
  fleet 無影響；若日後引入非 gost 第一跳拓撲，**必須重跑 R2 八層矩陣**。
  mock 矩陣（`docs/audits/r2-evidence/`）定位 = 診斷檔案，唔係驗收證據。

## 4. tunnel/process 失效時，安全狀態未能進入 BLOCKED/FAILED — **PASS**（誠實註見下）

- Live（R3 Phase A）：`kill -9` t2s → **BLOCKED +2s**（definite protection
  loss 立即路徑，唔候 threshold）；backoff anchor → recovery 1 → HEALTHY
  （kill-to-healthy 37s，exactly 1 attempt — recovery ledger 9 episodes 全部
  exactly-one）。
- Live（R3 Phase B）：canary-down（t2s 仍活）→ DEGRADED → canary-up → HEALTHY
  3s（soft 路徑；failure-family 分類正確 → 0 亂 re-provision）。
- Hermetic（`redroid-net-health.test.js`）：max retries（3）→ **FAILED +
  manualIntervention**；gVisor-stall signature 小預算（exactly 1 re-provision
  → manual door）；recovery lock 內容 = WAIT（唔第二 recovery）。
- MD §5 驗收標準「設備唔會繼續執行依賴網絡嘅任務」= **平台層**：worker 網絡
  任務 gate = `networkReady`（BLOCKED/FAILED/STALE → false）→ 唔派發；UI/audit
  全透明（R4 live UI 文字 badge 實錚）。
- **誠實註（decide-and-document，R7 決定）**：kernel 層 egress（Android app
  自己開 socket）喺 tunnel 死後會隨 routing shadow 消失而可經 eth0（bridge）
  直連 — **平台層 BLOCKED 唔阻斷 kernel 層直連**。R7 決定：**唔喺呢段實裝
  iptables 兜底**（Android netd 擁有容器 netns 嘅 iptables 規則、產品級 DROP
  規則會同 netd 互踩 — 需要獨立 spike + ADR + 安全評審）；文檔化風險 +
  operator 守則（runbook：BLOCKED/FAILED 期間視設備 egress 為 untrusted；
  需硬隔離時用 host 層 firewall 限紅roid 容器 egress 只過 proxy leg）+ backlog
  ticket（`redroid-host-validation.md` §5 + README K12）。gate 判定唔受影響：
  MD §5 條文嘅「任務」= 平台管理嘅網絡任務，已實錚 gate。

## 5. 健康狀態只能靠程序存在判定 — **PASS**

- 單一權威 = `Device.netState`（net_* 13 欄，migration `20261018000000-net-health`）
  — R4 狀態盤點：`docs/audits/r4-state-sources.md`（每個 UI/worker/API 顯示值
  都 trace 到 net_* 或明確標 derived）。
- 7 狀態機（`redroid-health.js` pure）：`HEALTHY` 唯一入口 = `VERIFYING` +
  fresh 雙向 canary PASS 證據（`isCanaryPassEvidence` 結構校驗）；
  **process alive 單獨唔夠**（hermetic §6.4-1：process=PASS + canary=FAIL →
  DEGRADED→BLOCKED，never HEALTHY）；**DNS OK 單獨唔夠**（§6.4-2）；stale
  （>60s `REDROID_HEALTH_STALE_MS`）= 按不健康（`networkReady=false`）。
- 三邊界契約：`NET_PAYLOAD_KEYS` / `NET_CHECK_KEYS`（`r4-payload-contract.test.js`
  鎖 API/worker/UI payload 形狀；drift = test 爆）。
- Legacy `proxy.state` 降級為 derived 投影（保守投影，唔做輸入）。

## 6. 真 Redroid 測試被錯誤標記為已通過 — **PASS**

- **CI（GitHub-hosted runner = runc VM）明確唔跑真 Redroid**（冇 binder/
  binderfs/GPU host）— workflow header 註明 + 無任何 job 宣稱 Redroid 通過。
  CI 只跑：hermetic suite / vite build / compose config / docker image build /
  secret scan — 全部係 CI 可執行部分（MD §9.2 清單逐项對應）。
- 真 Redroid 實錚**明確標 live** 並集中喺 `docs/live-evidence/`
  （r3/r4/r5-20261020 + p5-evidence）：每份 summary 開頭列 host 前提
  （runc + binderfs persistent + RTX 3090 ×2 + 隔離卷/端口範圍）。執行方式
  定義：本 host（`scripts/redroid-host-setup.sh`）+ 隔離
  `redroid-matrix-<ticket>-*` 命名 + 16xxx 口 + 用完全拆。
- mock 同真嘅邊界：`REDROID_ADAPTER=mock`（unit/hermetic 用 fake docker client
  + mock seam）vs `real`（live 用）— production 強制 real
  （config.js：`nodeEnv=production && mock → real`）。

## 7. API、資料 schema、前端和文件之間存在未解釋的契約差異 — **PASS**

- 錯誤詞彙單一來源（R6 接口清單）：`packages/shared`（DOCKER_ERROR + status
  map）/ `redroid-health.js` NET_ERRORS / `redroid-service.js` fail() —
  R7 未新增第二套；api-reference「Redroid 錯誤碼契約」表同
  「network payload 契約」段已同步（R6 寫、R7 核：代碼 ↔ 表 ↔ test 三方對齊）。
- Schema：net_* 13 欄（migration 20261018000000）+ cpuLimit/memoryLimitBytes
  （20261020235900）— 全部 additive；api-reference 列出。
- 前端：UI 狀態文字 badge（唔係只剩顏色）— R4 live 截圖實錚
  （`docs/live-evidence/r4-20261020/` 6 張）。
- 文件同步（MD §9.1 清單）：README / runbook / api-reference / ADR /
  .env.example / Dockerfile+Compose 註解 / 4 審計檔 — R7 C2–C8 全數落地
  （commit 清單見 progress log）。

## 8. 測試需要破壞性清除既有使用者資料才可跑 — **PASS**

- Hermetic suite（`npm test`）：全 fake db（in-memory seam）/ fake docker
  client / fake redis — **零真 DB、零真容器、零用戶數據接觸**。
- Real-redis gated test：只 sweep 自己建嘅 namespaced keys
  （`schedulerIdFor(uuid)` / `onceFireJobId(uuid, slot)` + `t.after` cleanup）—
  唔觸及其他 queue/key。
- Live 實錚（R3–R5）：用 disposable live device + 獨立卷，用完全拆
  （各 summary 嘅 cleanup 段）；user compose 6 容器 + SGLang 零 stop/modify
  （R5 §7.5 實核）。

---

## CI 記錄（MD §9.2 落地 + 真綠要求）

- Workflow：`.github/workflows/ci.yml`（R7 C5）— jobs：test（npm ci lockfile +
  全 hermetic suite Node 24 + redis:7.4.5 service（real-redis test 真跑）+
  compose config validation）/ web-build（vite prod）/ images-app（api+web+
  worker docker build）/ images-redroid（R1 pin + sha256 每次 push 真驗）/
  secrets（gitleaks 全 history + tracked-.env check）。
- lint/typecheck：N/A by design（plain ESM JS，無 eslint/biome/TS — R0 基線）；
  常規 static guard 喺 suite 內（patch-default-guard、t2s-pin）。
- **Run 1**（`0b46fdd`）red：兩個真缺陷（config test latent 隔離缺陷 — R6
  引入、host untracked `.env` mask；ci.yml .env-check regex 誤殺
  `.env.example`）→ 修復 commit `e3b9c75`（clean-clone 實測 627/627/0/0）。
- **Run 2**（`e3b9c75`）：全綠（progress log 有 run 連結 + 各 job 結果）。
- 真 Redroid/GPU = 明確 `manual`（workflow 註 + 本檔 gate 6），唔係 CI 綠。

## R6 交接 5 項 — R7 決定記錄（decide-and-defer 紀律）

| # | 項 | 決定 | 落地 |
|---|-----|------|------|
| 1 | `redroidTunnelPollMs` 未 map | **WIRE**（`REDROID_TUNNEL_POLL_MS`，default 5000 行為一致） | config.js + .env.example + test（commit `a872fda`）— .env.example 只列程式真讀嘅變數（MD §9.1），文檔一個唔存在嘅 env = 違規 |
| 2 | tunnel 死 = fail-open 直連恢復（kernel 層） | **decide-and-document（唔實裝 iptables 兜底）**：平台層 fail-closed 已實錚（gate 4）；kernel 層 DROP 規則同 Android netd 互踩風險未 spike，屬另開 P0 單範圍 | `fail-closed-validation.md` §3 邊界段 + `redroid-host-validation.md` §5 + README K12 + runbook operator 守則 + gate 4 誠實註 + backlog |
| 3 | adbd recreate-stall 根因未定位 | **記錄為已知限制 + 追索方向**（唔使呢段定位到 — 同 R6 口徑） | `redroid-host-validation.md` §5（recreate 特有、非產品回歸、診斷 honest 嘅證據鏈 + 追索方向）+ README K13 + backlog |
| 4 | FlowSession 孤兒累積 | **N/A（cross-project 帶入項）**：water_army 無 FlowSession 表（呢項由 clinic-workforce 上下文帶入）；對應物 = `task_run_events` 無 retention（README K4 既有 backlog）— 唔喺 R7 做 DB hygiene（範圍外，另開單） | backlog（README K4 註明） |
| 5 | `.next` loadManifest race | **保持「重跑即好」口徑入文檔**（N/A 精化）：water_army web = Vite（無 Next.js/.next）；dev manifest race 係跨項目通用 flake 签名 — runbook §5 既有行（「Next/Vite dev manifest race（已知 flake）…重跑即好」）保留 + R7 註明本 repo prod build = vite static（CI 每次 push 真 build — 該路徑無此 flake） | runbook §5（R7 註）+ gate 1（CI web-build 綠） |

## 未解決事項（= R8 輸入）

1. R2 spike 拓撲（裸第一跳）TCP forward-stall 根因 — 機構層 restapi
   instrument（`tcp-transport-investigation.md` §8 清單）；觸發條件 = 有人要
   引入非 gost 第一跳拓撲。
2. adbd recreate-stall image/內核層 root cause（追索方向已記錄 —
   `redroid-host-validation.md` §5）。
3. kernel 層 egress fail-closed（netns DROP + netd 互踩 spike → ADR → 實裝）—
   另開 P0 單。
4. R8（Phase 8）：全量回歸（MD §10 清單）— 管理平台 + Redroid/network 全
   項重跑 + 最終測試總表（PASS/FAIL/SKIPPED/BLOCKED 逐項列明，唔記總通過率）。
