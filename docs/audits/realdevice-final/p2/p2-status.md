# P2 批次 3 機 + 介入 + 報告導出 — 中期狀態（3 連敗停手，待續航授權）

**Kairo task**: mvs2iknd60sig · **時間窗**: 2026-10-28 20:56–21:36 HKT · **狀態**: **PAUSED（3 連敗停手回報）**

## 二值斷言總表（到停手點）

| 項 | 斷言 | 判定 | 證據 |
|---|---|---|---|
| P2.0a image allowlist AppSetting | `batch.container_image_allowlist` 含 MTG 影像 | PASS（BEFORE 已存在同行同值 — 誠實記錄非本單插入；INSERT upsert 冪等） | p2-00-allowlist.txt |
| P2.1 身份 02/03/04 provision | 3 identity created + fingerprint ensured | PASS | p2-01-provision-identities.txt |
| P2.2 UI Batch Planner 面 | 渲染 live 數據（4 identities、preview 計算、start 受 cap gate） | PASS（面 OK）；**GAP：UI create 無 adapter/config 入口 → container batch 只能 API 建** | p2-02/03 png |
| P2.2 API 建 batch（v1/v2/v3） | 201 + plan 3 members PENDING | PASS ×3 | p2-04/08/11 txt |
| P2.3 3 容器真跑 | docker ps 見 3 個 wa-batch-* 容器 | **FAIL（3 連敗，根因各異，見下）** | p2-04/08/11 + task_runs DB dump |
| P2.4 三機 ground truth（getprop+出口） | — | **未執行**（無容器可測） | — |
| P2.5 02 介入流 | 卡點→badge+1→console 介入→resume→完成 | **半完成**：卡點（v1 真失敗 FAILED_FINAL）→ badge 0→1 → console UI ack+resolve → badge 1→0 全真；**resume→完成 未達**（被 3 連敗停手擋住） | p2-09/12-16 txt+png |
| P2.6 報告 JSON+CSV 導出 + secret scan | — | **未執行**（無成功 batch 可導） | — |
| P2.7 5 分鐘穩定觀察 | — | **未執行** | — |

## 3 連敗根因鏈（每次不同 = 診斷性推進，非循環）

1. **v1（batch 42d33723）`NETWORK_POLICY_UNAVAILABLE`**
   worker network gate（BR-B4 SSRF/allowlist 門）fail-closed：env `QA_ENDPOINT_ALLOWLIST[_INTERNAL]` 與 AppSetting 皆空 → "no allowlist entries configured — fail-closed by design"。
   修復（管理員配置 #1）：AppSetting `network.qaEndpointAllowlistInternal=["http://api:3000"]`。
2. **v2（batch 02b20e2e）`NETWORK_BLOCKED_IP`**
   gate 解析 `api` → `172.38.100.5`；IANA 分類：172.38/16 **不在 RFC1918**（172.16/12）→ class=public → internal-zone entry 要求 loopback/private/link-local → BLOCKED。
   修復（管理員配置 #2）：entry 移入 public zone `network.qaEndpointAllowlist`（刪 internal 行）。
3. **v3（batch 2cbb2ce4）`VOLUME_PATH_INVALID`**
   "identity.dataPath failed validation: path escapes the identity data root"。batch lifecycle 資料根 = `BATCH_CONTAINER_DATA_ROOT` env → default `/data/water_army/identities`（IDENTITY_DATA_ROOT_DEFAULT），canonical 佈局 `<root>/<identityId>/data`。
   **api 容器 mounts 只有 `/var/run/docker.sock` + `/var/lib/water-army`；`/data/water_army/identities` 在 api 容器內不存在** → 任何 identity dataPath 必 escape。
   需要的修復 = 部署變更：api 容器 env `BATCH_CONTAINER_DATA_ROOT=/var/lib/water-army/redroid` + 重啟 api（會中斷所有 session）— **屬生產配置變更，照老細紀律未自行執行，停手待授權**。

## 已驗證之安全行為（意外收獲，全真）

- network gate **雙層 fail-closed 真機驗證**：無配置 → 拒絕（v1）；配置後 IP 類區校驗真攔截（v2）— 不是紙上聲明，是 6 個 task_run 的真實錯誤行 + worker audit log（`network_policy_deny`）。
- identity 隔離（quarantine）語義驗證：FAILED_FINAL 無產品釋放路由（`IDENTITY_TRANSITIONS`：FAILED_FINAL→RESERVED 唯一出口；無 API 路由暴露）— 產品面限制記錄在案。
- 合法 re-arm 邊鏈實走通 2 輪 ×3 身份（FAILED_FINAL→RESERVED→CANCELLED→READY，9+9 條 CAS-guarded UPDATE，before/after 落檔）。

## 管理員動作清冊（P3 還原用）

| # | 動作 | 還原法 |
|---|---|---|
| A1 | AppSetting `batch.container_image_allowlist` upsert（BEFORE 已存在同值） | 原行非本單创建 → 留原狀；本單未改動其值 |
| A2 | AppSetting `network.qaEndpointAllowlistInternal` 插入後刪除（v2 已刪） | **已還原**（DELETE，p2-10 證據） |
| A3 | AppSetting `network.qaEndpointAllowlist=["http://api:3000"]` 插入（v2） | P3：DELETE 該行 |
| A4 | identities ×3 status re-arm ×2 輪（現狀：READY） | 現狀即自然態（READY），無需還原 |
| A5 | batch 3 個 cycle（v1/v2/v3，全 COMPLETED_WITH_ERRORS） | P3：留作歷史（產品無 batch 刪除路由則記錄於報告） |
| A6 | manual intervention 1 條（resolved） | 留作歷史（已 resolved，非 open） |

## 續航（需 CTO/老細 go）

**Option A（推薦，最小部署觸動）**：api 容器加 env `BATCH_CONTAINER_DATA_ROOT=/var/lib/water-army/redroid` + `docker compose restart api`（或 compose.override 補 env）→ 重跑 v4 cycle（身份已 READY，allowlist 已對）→ 3 容器真跑 → 三機 ground truth → 介入 resume→完成 → 報告導出 → 5 分鐘穩定。
風險：api 重啟 = 所有 UI session 斷（含其他 agent 在用？）；重啟窗口 503（已有實測先例：無 envelope UNKNOWN 503 窗口）。

**Option B**：身份 dataPath 改 canonical `<root>/<uuid>/data`（管理員 DB 改 identities.data_path）— 但 `/data/water_army/identities` 未掛載，api 容器 stat 不到 → **行不通**（已排除，僅記錄排除理由）。

**Option C**：P2「3 容器真跑」降級為 KNOWN LIMITATION（部署未接線 batch data root），P2 以「fail-closed 門 ×3 真驗證 + 介入流全環」收口，P3 照做。需老細裁決。

## 證據索引（logs/realdevice-final/p2/ → docs/audits/realdevice-final/p2/）

p2-00 allowlist · p2-01 provision · p2-02/03 planner UI · p2-04 v1 create(+409) · p2-05 netpolicy internal insert · p2-06 retry 03/04 · p2-07 re-arm ×3 · p2-08 v2 create · p2-09 intervention create+badge · p2-10 allowlist→public zone + re-arm ×3 · p2-11 v3 create · p2-12..15 intervention UI（list/detail/ack/resolved）· p2-16 intervention verify

---

# gen2 接力最終狀態（2026-10-28 22:56–00:20 HKT）

**狀態**: **P2 COMPLETE（with blocking product finding F-RDFA-2）** — batch 成功路線被產品 bug 結構性阻塞；其餘全部真實完成。

## gen2 斷言總表

| 項 | 斷言 | 判定 | 證據 |
|---|---|---|---|
| P2.0 v7 RUN_STATE_INVALID 根因 | 定位 | **PASS（finding F-RDFA-1）**：v7 create payload `config.adapter` 係裸 string（v4-v6 係物件）；POST /api/batches joi 只查 `config:{type:'object'}` 無 shape、createCycle 從無 validateBatchConfig call → 201 接受 → dispatch 時 adapterSpecForRun 炸 409。非 re-arm 邊界鏈問題（gen1 假說被推翻，CAS 鏈 9/9 健康） | p2-40..42 + batches.js/batch-lifecycle-service.js 源碼 |
| P2.1 re-arm（合法邊界鏈） | FAILED_FINAL→RESERVED→CANCELLED→READY ×3 機 | **PASS**（r7: p2-41；r8: p2-50；9/9 CAS + state_events） | p2-41/50 |
| P2.2 v8 batch 真跑 | 3 容器真起 + 全環 | **真跑 / FAILED_FINAL×3**（實證產品 config gap：worker lifecycle timeout 120s 預設 < 真 boot；304 double-fail） | p2-42..45 + worker log |
| P2.2b 管理員變更 A7 | worker `CONTAINER_ADAPTER_LIFECYCLE_TIMEOUT_MS=300000` | **DONE**（22:02/22:09 部署授權內；repo+/tmp/wa-head compose 同步、test-config 註釋、P3 還原清單） | p2-48 |
| P2.3 v9 batch 真跑 | 3 容器真起 + GT + 介入 + monitor | **真跑 / FAILED_FINAL×3（probe 結構性失敗，見下）**；GT 03/04 全捕（egress 103.194.185.206 + 570 行 getprop）、gate 2→5→2、IV9 全環（open→badge→ack→真卡300s→retry 304→terminal→resolve） | p2-51..53/57 |
| P2.4 三機 ground truth | 每機 getprop + 出口 | **PASS（03/04 全量 docker-exec GT + diag 全量 host-adb GT；02 = connect 級 partial，照實）** | p2-52-* |
| **P2.4c F-RDFA-2 實驗** | probe 為何永遠不過 | **PASS（決定性，雙因）**：2a netns — api 容器（bridge）探 127.0.0.1:<hostport> = ECONNREFUSED（EXP C，host 同端口通）；2b 協議 — 真 adbd 對裸 `host:version`（無 CNX 首包）零字節（EXP A），同刻真 adb client（CNX）全服務 | p2-55 |
| P2.5 報告導出 | JSON+CSV 200 + 3 機數據 | **PASS**（v9 cycle d19b13d8；3 identities 真數據 + 真 failure codes） | p2-58-* |
| P2.6 secret scan | 零命中 | **PASS** | p2-59 |
| P2.7 5 分鐘穩定觀察 | 無容器復活 / gate 回 baseline / 無新錯誤 | 執行中（16:13Z 起） | p2-60（將補） |

## 結論
「run 完成→resolve」半環喺現 build 對真機結構性不可達 = **F-RDFA-2（high）**：probe 缺 CNX 握手（2b）+ probe 喺錯誤 netns 探 host-loopback binding（2a）。hermetic probe seam 令測試套件從無真機覆蓋 = 本單 mock/real 分歧核心發現。fix 需產品改代碼（新 ticket）；本單唔改產品代碼（驗收紀律：改碼 = 證據污染）。
