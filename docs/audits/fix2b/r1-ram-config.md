# R1 — RAM gate 配置 B：postBootTarget 5400→2100（老細 22:15 選 B）

## Override ledger
- **postBootTarget 5400→2100，老細 10-29 22:15 選 B**（WA-FIX2B R1；hardFloor 4096 照舊唔郁；perBootBudget 1200 照舊）
- 載體：AppSetting `ram_gate.config` = `{"hardFloorMiB":4096,"postBootTargetMiB":2100}`（psql operator update，無 admin API 凭證；gate 每decision 即時重讀 = live）；審計行 `audit_events.ramgate.config_updated`（actor=admin 927b788c，details 含 merged/previous/derivation）。
- env `RAM_GATE_*` 實查零設定 → AppSetting 即 effective（無更高優先序覆蓋）。
- **10-29 23:46 拆 a4（老細批准，CEO 執行）**：產品 API DELETE confirm 逐字 + removeData；data dir 同遭 `DATA_DIR_PERM_DENIED`（root-owned），CEO 一次性 alpine chown+purge 清淨（紀律同 batch-rerun 先例）→ 窗口 9,425 MiB 曾開（fx-3 attempt 窗口淺，後跌返 8.6G）。
- **10-30 00:0x fx-2 teardown（WA-FIX2B R5）**：產品 API DELETE confirm="redroid-rdev-fx-2" + removeData:true → container/gost/proxy 經 API 清；data dir `DATA_DIR_PERM_DENIED`（dalvik-cache root-owned，同款先例）→ alpine:latest chown+purge 清淨；零殘留核對 = devices 0 行、stream/resource leases 0（fx）、identity_data_dir_claims 無 fx 行、fx containers 0。
- **postBootTarget 2100 = 老細批准配置，留低唔撤**（override 賬目收口口徑）。

## 定值算式（按 gate 代碼 projected 公式，唔係估）
公式（`packages/shared/src/ram-gate.js` §ADMISSION）：
```
projected = current − (live+1) × perBootBudget(1200)
ADMIT iff projected ≥ postBootTarget AND current ≥ hardFloor(4096)
```
**口徑 = 「5 台 adv + 1 複測機」：第 6 次 boot 時 live=5 → projected = current − 7,200。**

| 項目 | 數 | 來源 |
|---|---|---|
| 改前要求（5400） | 第 6 boot 需 current ≥ **12,600** | 5400+7200；主機從未見到（見下）→ D4 必死 |
| 主機穩定帶（4 adv+lease 常在，strata LLM 67 GiB RSS 常駐） | MemAvailable **10,240–10,547 MiB** | s5 實測「10.0–10.3 GiB 穩定」+ 本輪 3 次採樣 11,478/12,011 MiB |
| 實錚低谷（5-lease，RAM「寬鬆時」） | **~9,300 MiB** | adversarial d2 `b1-create.txt`（19:07，projected 2091） |
| **選定 N = 2100** | 第 6 boot 要求 current ≥ **9,400** | ①覆蓋實測低谷 9,300（+100 恰過）；②喺 s5 穩定帶裕力 **840–1,147 MiB**；③安全線 = hardFloor/2 = **2,048 < 2,100**（projected 仍高於 boot 完成後真實 MemAvailable 安全線 — 老細口徑）；④唔等於實際：實測最低 projected = 3,040（穩定帶底）≠ 2,100 — gate 仍係真閘，跌穿 9.4 GiB 照拒 |
| boot 完成後真實 MemAvailable（修後預期） | **≥ 8,832 MiB**（穩定帶底 − 實測單機增量 ≤1,408） | A10 實測 settled ≈934 / fleet-avg 增量 ≈1,408 MiB/device（docs/ram-gate.md §2） |

## 修前 → 修後 → 殘餘
- **修前判語**：DENIED 實據喺 audit_events（fx-1 ×5 筆 `ramgate.admission_denied` PROJECTED_BELOW_TARGET，liveCount=5、currentMiB 10,090–10,307、projected 2,890–3,107 全部 < 5400）；s5 已試 11 次 start 全 409。
- **修後判語**：要求降至 current ≥ 9,400 → 穩定帶（10,240+）必過；真實 R4 開機 ADMITTED 實據見 progress log（本檔只落配置段；真機判語以 boot 為準，唔准「改咗 config = 修好」）。
- **殘餘**：①主機 MemAvailable 由 strata LLM 常駐主導 — 若 LLM RSS 再升 1 GiB+，gate 會誠實拒第 6 機（政策層再拍板，唔係 code bug）；②`mc-dogfood-2` 容器 exited 而 DB stale=running → 其 ramgate lease 被 reconcile 收回（live=5 而唔係 4），計多一個 1,200 預算 — 已入 R4 開機前狀態記錄；③hardFloor(4096) 同 budget(1200) 未改。

## 複現/驗證命令
```bash
docker exec water-army-postgres-1 psql -U app -d water_army -tAc \
  "SELECT value_json FROM app_settings WHERE key='ram_gate.config';"
docker exec water-army-postgres-1 psql -U app -d water_army -tAc \
  "SELECT created_at, details_json->>'ledger' FROM audit_events WHERE action='ramgate.config_updated' ORDER BY created_at DESC LIMIT 1;"
```
