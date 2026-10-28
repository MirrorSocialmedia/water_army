# WA-UI-SURFACY — 需求分析 + UI 方案（s1）

Kairo: mvrvfa9l5l813 · 2026-10-28 · CTO agent

## 0. 原則（照工單）
- 復用既有 pattern：`useApi` + `StateFrame` + `api` client（error envelope { code, message, requestId }）+ services 層函數組。零新 dependency（FE 測試 = node:test + react-dom/server（已 hoist，ContainerDetail tab pattern 已有 `role="tablist"`））。
- 每項功能 UI 可達 ≤2 click；RBAC 守門與後端 `requireRole` 完全一致；後端 fail-closed 503（switch off）顯示誠實「disabled」框架，唔當 crash。
- 503 disabled 處理先例 = IdentityDetail `useLoginState.disabled`（LOGIN_STATE_DISABLED）— 跟足。

## 1. 七項零入口功能 → 後端契約盤點（已讀 route 源碼核實）

| 功能 | Routes | RBAC | Fail-closed |
|---|---|---|---|
| identity-fingerprints (W1/W1b) | GET/POST `/api/identities/:id/fingerprint`；GET `/api/identities/fingerprints/collisions` | 讀 viewer / 生成+審計 admin | — |
| identity-egress (W3) | GET `/api/identities/:id/egress`；PUT/DELETE 同路徑；GET `/api/identities/egress`（隊列） | 讀 viewer / 寫 admin | 503 `EGRESS_BINDING_DISABLED`；zero-credential（proxyUrl 永不回傳，只 hash 前綴） |
| account-lifecycle (T5) | GET `/api/identities/:id/account`（+vault masked）；GET `…/account/audit`；POST `…/transition`、`…/provision` | 讀 viewer / 動作 operator | 503 `ACCOUNT_LIFECYCLE_DISABLED`、`GMAIL_PROVISION_DISABLED` |
| device-apps (W2) | GET `/api/devices/redroid/:id/apps[/:pkg]`；POST `…/apps/install`；DELETE `…/apps/:pkg` | 讀 viewer / 寫 operator | 503 `APP_OPS_DISABLED`；install 只食 managed-dir flat fileName（無目錄列表 route → 安裝入口 = fileName 輸入框，後端校驗） |
| redroid-templates | GET `/api/redroid/templates` | 讀 viewer（寫 admin，本單 UI 只讀） | — |
| network-policy (BR-B6) | GET `/api/network-policy`；PUT `…/allowlists`、`…/task-types` | admin only（讀+寫皆 admin） | available=false 時誠實報 reason |
| task-definitions | GET `/api/tasks/definitions` | 讀 viewer（無 POST/PATCH route → 「管理入口」= 列表 + 誠實 note「啟用/停用 API 未提供」） | — |

Settings 相關：GET `/api/providers`（admin，masked keys — `publicProvider` 已 redact）；RAM gate 已有 GET `/api/system/ram-gate`（admin）。

## 2. 新增後端 route（工單允許）
`GET /api/system/config-summary` — admin 唯讀聚合，redact secret：
- `egress`: bindingEnabled、echoHost/echoPort（探測端點，非憑證）、probeTimeoutMs、staleMs、failThreshold
- `ramGate`: effective config = `resolveRamGateConfig(AppSetting patch, process.env)`（唔依賴 gate 可建構 — 純讀）
- `registration`: gmailProvisionEnabled、perIpDaily、perIdentityDaily、min/maxIntervalMs、recoveryPoolSize（只計數字，唔回郵箱內容）
- `sms`: 政策常量 — autoSolve=false（AUTO-SOLVE=契約違規）、gate=HUMAN_GATE→EXTERNAL_VERIFICATION、captchaTimeoutMs
- `fingerprint`: roOverridesEnabled、templateProfilesEnabled（W1/W1b 開關）
零 secret 欄位（無 password/token/proxy credentials/pool 位址內容）；Route file `apps/api/src/routes/system-config-summary.js`，app.js 註冊。

## 3. FE 結構（tab 方案 — ContainerDetail `.tabs` pattern 已存在）
- **IdentityDetail** → tabs：Overview（現有內容）| 指紋 | 出口 (Egress) | 帳號生命週期。
  - 指紋 tab：profile JSON 顯示 + 「生成/校驗 (ensure)」按鈕（admin）+ fleet collisions 審計面板（admin，含 blocking 旗標）。
  - Egress tab：綁定詳情（expectedIp/proxyHashShort/verified 時間/綁定裝置數）+ PUT 表單（proxyUrl + expectedEgressIp）+ DELETE；503=switch-off 誠實卡。
  - 帳號 tab：state+vault(masked)+audit 表 + transition 按鈕（operator，目標狀態 select + reasonCode）+ provision 按鈕。
- **DeviceDetail** → tabs：Overview（現有全部內容）| 應用 (Apps) | 模板 | 派發策略 (Policy)。
  - Apps：packages 列表（filter）+ 单包 info + install(fileName)/uninstall（operator）；503 誠實卡。
  - 模板：listTemplates 唯讀表。
  - Policy：network-policy 有效策略 + AppSettings 行（admin only；viewer 403 誠實顯示）。
- **Settings** 實體化：providers 真實表格（masked key、hasKey）；新卡「系統配置總覽」= GET /api/system/config-summary；task-definitions 列表卡（viewer+）。
- Services 層新檔：`services/identity-extras.js`、`services/device-extras.js`、`services/system.js`。
- 純邏輯檔（可測）：`lib/surfacy-ui.js` — RBAC capability（canManage*/canOperate*）、errorText(err)、長字串/word-break helper class 應用、連點 guard helper、collision/conflict 訊息格式化。

## 4. 對抗測試 s5（tests/unit/surfacy-ui.test.js，零 new dep）
1. XSS：react-dom/server `renderToStaticMarkup(createElement(...))` 渲染 `<img src=x onerror=alert(1)>` displayName → 輸出無 live `<img`/`onerror`（React text-node 轉義實證，非假設）。
2. 超長 300 字元 → helper 輸出帶 word-break class + preview 截斷誠實。
3. 409（collision / egress 已綁）→ errorText 映射顯示 code+message（非白屏路徑）。
4. 500/離線 → ApiError{status:0 NETWORK_ERROR} 與 500 errorText 誠實。
5. viewer → canManageFingerprint/canWriteEgress/canOperateLifecycle/canManagePolicy 全 false（admin/operator 矩陣）。
6. 連點 → busyGuard：busy 中重複 click 不觸發第二次提交。

## 5. 交付順序
s2 IdentityDetail tabs → s3 DeviceDetail tabs → s4 Settings + config-summary route → s5 對抗測試 → s6 e2e 真機（RAM gate 拒 = gate 行為 PASS）→ commit+push+標 Kairo 每段。基線 1579/1573/0/6 零回歸紅線；3 連敗即停。
