# WA-UI-SURFACY — e2e 真機走查報告（s6）

- 日期：2026-10-28（Asia/Hong_Kong）
- 執行：CTO agent（Kairo 單 `mvrvfa9l5l813`，步驟 s6）
- 棧：產品 stack 真機 — web `http://127.0.0.1:3012`（host published）→ api container:3000 → pg/redis container。5 個 `water-army-*` 容器 healthy。
- 瀏覽器：chromium headless shell（playwright-core，零新依賴），viewport 1440×900。
- 帳號：一次性 e2e admin `ui-e2e`（`scripts/e2e-ui-bootstrap-session.sh` 產生 opaque session token，DB hash 落 sessions 表；零真實憑證、零 secret 落盤）。
- 腳本：`scripts/e2e-ui-surfacy-walk.mjs`（results → `logs/ui-surfacy/walk-results.json`，截圖 → `logs/ui-surfacy/`，gitignored）。
- 口徑：**誠實降級 = PASS**（工單明示 RAM gate 拒 = 記錄 gate 行為正確性也算 PASS；後端開關未開的 503 卡同理）。

## 結果總覽 — 16/16 PASS（ok:true，130s）

| # | 步驟 | 結果 | 實證 |
|---|------|------|------|
| 01 | login 頁（未登入） | PASS | 未認證根路徑渲染 login frame | `01-login.png` |
| 02 | dashboard（登入後） | PASS | `/api/auth/me`=200，heading=Dashboard | `02-dashboard.png` |
| 03 | 建機（RAM gate） | PASS — **RAM gate 誠實拒絕** | `RAM_GATE_DENIED — Device create '…' denied by RAM gate (PROJECTED_BELOW_TARGET) — MemAvailable 7,316 MiB, projected 4,915 MiB`；UI error-box 原文顯示、無白屏、無殭屍 row | `03-devices-create.png` |
| 04 | identities 列表 | PASS | 1 row（種子 identity） | `04-identities.png` |
| 05 | 生成指紋（W1） | PASS | 指紋 tab 渲染；generate → 誠實 500 `FINGERPRINT_GENERATION_FAILED`（RoService 未就緒），StateFrame 錯誤態 | `05-identity-fingerprint.png` |
| 06 | 綁 egress（W3，172.38.223.1:18443） | PASS | 表單+綁定結果渲染；W3 開關預設 off → 誠實 503 `EGRESS_BINDING_DISABLED` 卡 | `06-identity-egress.png` |
| 6.5 | 帳號生命週期（T5） | PASS | lifecycle 面板渲染（503 `ACCOUNT_LIFECYCLE_DISABLED` 誠實態） | `06b-identity-account.png` |
| 07 | 裝 APK（W2 device-apps） | PASS | apps 面板 = 誠實 503 開關卡（`APP_OPS_DISABLED`，附開關指引） | `07-device-apps.png` |
| 7.5 | templates + network-policy tabs | PASS | 兩面板均渲染；admin 見可編輯 policy（`{public:[],internal:[]}` 分區） | `07b-device-templates-policy.png` |
| 08 | 批次策劃 | PASS | planner 渲染 | `08-batch-planner.png` |
| 09 | 執行 | PASS | 誠實空態（無可啟動項 — 不造假按鈕） | `09-execute.png` |
| 10 | live view | PASS | monitor SSE live frame 渲染 | `10-monitor-live.png` |
| 11 | 人工介入 | PASS | interventions console 渲染 | `11-interventions.png` |
| 12 | 報表導出 | PASS | reports 頁渲染，export affordance 狀態見圖 | `12-reports.png` |
| E1 | Settings 實體化 | PASS | config-summary 卡 \| providers 卡（masked hasApiKey）\| task-definitions 卡 全渲染 | `13-settings.png` |
| E2 | RAM Gate 頁 | PASS | 建機 gate 決策記錄頁渲染 | `14-ram-gate.png` |

### 補充實證（CEO 降 gate 4G 後補跑，同日）

CEO 將 RAM gate 經 AppSetting 降至 `hardFloorMiB 4096 / postBootTargetMiB 5400`（config-summary 確認 `source: app_setting+env`）後補跑建機步：

- 模板 `matrix-a-14-host` + 名字 `redroid-uie2e-ok1` → **建機成功**：無 error-box、列表 row 出現、API 確認 `containerId` 已分配（真 container）。gate ALLOW 路徑亦有實證。
- 驗證後經 UI 同款兩步確認 API `DELETE`（`confirm` 名字）清理：`200 {deleted:true, containerRemoved:true}` — 無殘留。
- 截圖：`03b-device-created.png`。
- 結論：03 步的 `RAM_GATE_DENIED` 與補跑的 ALLOW+創建成功共同證明 gate 兩側行為均誠實正確。

## 誠實降級證據鏈（後端開關矩陣 × UI 行為）

| 功能 | 後端狀態（部署 default） | UI 行為（走查觀察） |
|------|--------------------------|---------------------|
| 建機 RAM gate | ON | 拒絕 POST → error-box 原文 `RAM_GATE_DENIED (PROJECTED_BELOW_TARGET)` + 右欄 Ram Gate 卡 RED `✕ DENIED`；未創建即被拒 = gate 語義正確 |
| W1 fingerprints | ON（RoService 未就緒） | 500 `FINGERPRINT_GENERATION_FAILED` 誠實錯誤態 |
| W3 egress binding | OFF（`WA_W3_EGRESS_BINDING_ENABLED=false`） | 503 `EGRESS_BINDING_DISABLED` 卡（非白屏、非假成功） |
| T5 account-lifecycle | OFF | 503 `ACCOUNT_LIFECYCLE_DISABLED` 卡 |
| W2 app-ops | OFF | 503 `APP_OPS_DISABLED` 卡 + 開關指引 |
| 建機 name 校驗 | — | 非 `^redroid-…` 名 → 表單錯誤態 `VALIDATION_ERROR — must match pattern`（實測捕獲） |
| providers key | masked | 僅 `hasApiKey ✓/✗`，零 key 回顯；proxyUrl 零回顯（config-summary 結構性 redact） |

## ≤2 click 可達矩陣（工單 §4）

| 功能 | 路徑 | clicks |
|------|------|--------|
| W1 指紋 | Identities → 行 → 指紋 tab | 2 |
| W3 出口 | Identities → 行 → 出口 tab | 2 |
| T5 生命週期 | Identities → 行 → 帳號 tab | 2 |
| W2 應用 | Devices → 機 → 應用 tab | 2 |
| redroid-templates | Devices → 機 → 模板 tab（列表頁亦有卡） | 2 |
| network-policy | Devices → 機 → 派發策略 tab（admin 可編輯） | 2 |
| 指紋碰撞審計 | Identities → 碰撞審計開關面板（admin） | 1 |
| 系統配置總覽 | Settings | 1 |
| task-definitions | Settings（唯讀列表；後端無 enable/disable API — UI 已註明） | 1 |

## RBAC

- 走查以 admin 進行（PolicyPanel 可編輯態、admin-only 開關出現）。
- viewer 側由 s5 對抗套件證明：`tests/unit/surfacy-ui.test.js` RBAC matrix（admin 動作按鈕 viewer 不出現）+ 集成測 `tests/integration/system-config-summary.test.js`（401/403/200）— 前後端口徑與後端 `requireRole` 一致。

## 測試基線（s6 時點）

- 全套 `npm test`：**1606 tests / 1600 pass / 0 fail / 6 skipped** — 對工單基線 1579/1573/0/6 零回歸、淨增 27 tests（s4/s5 新增）。

## 走查 harness 教训（非產品 bug）

- SPA 為 hash router：`page.goto` 同 document 內 hash 變更**不會** reload → 步驟間殘留舊 React 態。修正 = 每步強制真 `reload()`；修正後 16/16。
- headless 截圖前必須以 DOM（innerText/locator）machine-read 為準；縮圖誤讀曾造成一輪「舊 UI」疑雲（bundle md5、DOM grep、截圖三方核對後確認產品為新版本）。

## 殘留

- e2e 種子資料：identity `UI-E2E walkthrough`、admin `ui-e2e` + session（一次性，可刪）；早期建機嘗試被 gate 拒 — 無殘留；降 gate 後補跑的 `redroid-uie2e-ok1` 已連 container 一併 DELETE 清理。
- s7/s8（Reviewer Agent 代碼審查 + 全套復跑）為 Kairo 單後續 subtask，非本段範圍。
