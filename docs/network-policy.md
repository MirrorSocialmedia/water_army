# Network Policy — QA endpoint allowlist + SSRF hardening（BR-B4，施工 MD Phase 4）

單一事實源：worker 嘅 outbound network gate（B1 seam 嘅 real implementation）。
實碼：`packages/shared/src/network-policy.js`；swap 點：`apps/worker/src/worker.js`（`networkGate:`）。
測試：`tests/unit/network-policy-ssrf.test.js` + `tests/unit/network-policy-gate.test.js` +
`tests/integration/task-engine-policy-gate-swap.test.js`（119 項，全 hermetic）。

## 1. 目標與非目標

**目標（MD §5.1）**
- 任務外發請求只能去白名單（staging/QA endpoint）內嘅目標。
- 防 SSRF 全路徑：任意 scheme（file/gopher/ftp/data）、DNS rebinding、私有網段、
  localhost、cloud metadata（169.254.169.254）、IPv4-mapped/compatible IPv6 偽裝。
- policy 未載入/失效 → **fail-closed**：run 標記 failed（`NETWORK_POLICY_UNAVAILABLE`），
  唔 retry，**絕不退回 allow-all 或任意直連**（MD §12 末行）。

**非目標（= B6 整合項，見 §10）**
- HTTP client 層嘅 pinned-IP dial（undici dispatcher）— 現行 provider 用 `globalThis.fetch`。
- AppSetting 嘅 admin-only 寫入路由（MD §12 角色要求）— 本單只提供讀取契約。
- compose 網絡拓撲改動（explicit `networks:` 段、device 專用 network）。

## 2. Gate 位置與契約（B1 seam，engine 零改動）

```
handleJob → gateConcurrency → networkGate(ctx) → startAttempt → provider
                                │ deny
                                └→ run failed（terminal，唔 retry）+ FAILED event
                                   + audit_events（actor=system）+ 穩定 error code
```

- 簽名：`async (ctx) => { allowed: true } | { allowed: false, code, reason }`
  （`ctx = { runId, attempt, identityId, batchId, taskType }`）。
- gate **永不 throw**：任何內部異常一律分類為 `POLICY_UNAVAILABLE` deny。
  B1 engine 本身都有第二層：gate throw / 無 code → 同樣映射 `POLICY_UNAVAILABLE`（雙保險）。
- 每次 dispatch（每個 attempt）都會重新過 gate — 政策修改即時生效。

## 3. 配置面

### 3.1 Env（`.env` / compose environment）

| 變數 | 格式 | 說明 |
|------|------|------|
| `QA_ENDPOINT_ALLOWLIST` | comma-separated entries | **public zone**：resolved IP 全部必須係 public |
| `QA_ENDPOINT_ALLOWLIST_INTERNAL` | 同上 | **internal zone**：Docker-network/host-local 目標；resolved IP 全部必須係 loopback/private/link-local |

兩個 zone 都**永遠拒**：metadata（169.254.169.254 任何 IP 形態）、CGNAT（100.64/10）、
unspecified、multicast、broadcast、test-net、nat64。

### 3.2 AppSetting（admin-only 改動 = B6 路由項）

| key | valueJson 形態 |
|-----|----------------|
| `network.qaEndpointAllowlist` | JSON `string[]`（同 entry 格式） |
| `network.qaEndpointAllowlistInternal` | 同上 |
| `network.taskTypePolicy` | JSON `{ "ai": bool, "adhoc": bool }`（缺省兩者 true；未知 key / 非 boolean = 整 policy unavailable） |

**合併語義**：同 zone 內 env + AppSetting 取 **union**（dedupe by scheme|host|port）。

### 3.3 Entry 格式（strict）

```
scheme://host[:port]      scheme ∈ {http, https}
host[:port]                bare 形式 = https 簡寫
```

- `host` = DNS name（單 label 容納 Docker DNS 如 `api`；label 字符集校驗）｜IPv4 literal｜bracketed IPv6 literal（`[::1]`）。
- `port` 缺省：https=443 / http=80；顯式 port 必須 1–65535、**無 leading zero**。
- **精確匹配**（scheme+host+port 三件套）：唔接受 wildcard（`*` 任何位置）、path、query、fragment、userinfo（`@`）、whitespace、trailing dot。
- IPv6 literal 必須 bracketed（unbracketed `fd12::1:8080` 有歧義 → 拒）。
- IPv6 匹配用 **canonical expanded form**（byte-level）— 任何拼寫（`::ffff:127.0.0.1` / `::ffff:7f00:1` / 大小寫 / 縮寫）匹配同一 entry。
- **一條 malformed entry = 整份 list 失效**（fail-closed；partial policy 會靜默改變允許面 — 絕不）。

示例：

```
QA_ENDPOINT_ALLOWLIST=https://qa.example.com,https://api.qa.example.com:8443
QA_ENDPOINT_ALLOWLIST_INTERNAL=http://api:3000
```

## 4. 評估流水線（`assessTarget`，順序即安全順序）

```
1. parse（scheme → userinfo → host → port）
   壞 URL 喺呢一步就死 — 唔會觸發任何 DNS
2. allowlist 匹配（精確）
   唔 match → TARGET_DENIED，同樣唔做 DNS（無 DNS leak 俾任意 host）
3. 單一 resolve（injectable；default = node:dns all:true，全部 A/AAAA 記錄）
4. 每個 resolved IP 過 class 表 — 任何一個 blocked class = 整 target 拒
5. 成功 → 回 { pinnedIps }（pin 契約，見 §6）
```

## 5. IP class 矩陣（byte-level — v4-mapped / v4-compatible 皆捉）

Node 22 WHATWG URL 會將 `http://[::ffff:127.0.0.1]/` 正規化成 hostname `[::ffff:7f00:1]`，
所以分類必須 byte-level（string 前綴匹配會漏）。`classifyIp` 實碼：parse → 16/4 bytes → prefix 表。

| class | IPv4 range | IPv6 range | public zone | internal zone |
|-------|-----------|-----------|:---:|:---:|
| public | 其餘所有 | 其餘所有 | ✅ | ❌ |
| loopback | 127.0.0.0/8 | ::1/128 | ❌ | ✅ |
| private | 10/8, 172.16/12, 192.168/16 | fc00::/7 | ❌ | ✅ |
| link-local | 169.254.0.0/16 | fe80::/10 | ❌ | ✅ |
| **metadata** | **169.254.169.254** | （mapped/compatible 形態同捉） | ❌ | ❌（兩 zone 都拒 — 雲憑證竊取向量） |
| cgnat | 100.64.0.0/10 | — | ❌ | ❌ |
| unspecified | 0.0.0.0/8 | ::/128 | ❌ | ❌ |
| multicast | 224.0.0.0/4 | ff00::/8 | ❌ | ❌ |
| broadcast | 255.255.255.255 | — | ❌ | ❌ |
| test-net | 192.0.2/24, 198.51.100/24, 203.0.113/24 | — | ❌ | ❌ |
| nat64 | — | 64:ff9b::/96 | ❌ | ❌ |

**偽裝形態（實測矩陣）**：`::ffff:127.0.0.1`、`::ffff:7f00:1`（WHATWG 拼寫）、
`::127.0.0.1`（deprecated v4-compatible）、`::ffff:169.254.169.254` — 全部 byte-level
展開後還原出 embedded v4 再分類 → 正確 block。

**misconfig 覆蓋**：operator 手誤將 `http://10.0.0.5:8443`（private literal）寫入
**public zone** → IP 檢查仍然覆蓋配置錯誤 → BLOCKED_IP（允許面永唔會大過 IP class 表）。

## 6. DNS rebinding 與 pinned-IP 契約

- 每次 assess **只 resolve 一次**；**全部**返回地址必須通過（classic rebinding 記錄
  `[public, 127.0.0.1]` 即死）。
- 成功結果帶 `pinnedIps` — 契約：**connect 必須 dial 呢啲已驗證 IP + `Host: <原 host>`，
  唔可以第二次 resolve**（第二 resolve 正係 rebinding 贏嘅地方）。
- **現行殘留（TOCTOU，已文檔化，B6 收）**：provider client（`openai-compatible.js`）
  用 `globalThis.fetch`（undici default），實際 connect 時會再 resolve 一次 —
  gate 驗證同 socket connect 之間有毫秒級窗口。當前 mitigations：
  (a) egress target 係 **operator 配置**（ProviderConfig / API_INTERNAL_URL），唔係任務文字 —
  攻擊面係 admin 誤配 / DNS hijack，唔係 per-task SSRF；(b) gate 每個 attempt 都重新 assess。
  B6 收口 = undici pinned dispatcher（dial `pinnedIps`，保 `Host`）。
- 目標集合（gate 每 run 評估）：
  1. run 指定 provider 嘅 `provider_configs.baseUrl`（`mock` / row 缺 / disabled = 無 target —
     run 會喺 provider resolver 硬 fail，無網絡接觸）；
  2. `config.apiInternalUrl`（worker→API tool 路徑）。

## 7. Redirect 政策（決定 + 理據）

**決定：逐 hop 重新過全部校驗**（`assessRedirect()`）— 每一 hop 視為全新 target：
parse → allowlist → 單一 resolve → 全 IP 校驗；**https→http 協議降級 = 直接拒**（BAD_TARGET）。

理據：blanket 禁 redirect 更嚴但會打斷正規 canonicalize 行為嘅 QA endpoint；
per-hop re-validation 保持同一安全不變量 — **任何一 hop 都唔可以落到 allowlist 之外**
（redirect 本身就係 rebinding 嘅一種載體：Location 指去 loopback 都會被 per-hop IP 檢查捉）。

**現行狀態**：client-side 啟用（undici dispatcher 入面 revalidate Location）= B6 整合項；
本單交付嘅係庫層契約 + 全套邊界測試（ssrf test §J）。

## 8. Fail-closed 矩陣（deny code 表 — `NETWORK_GATE_ERROR`）

| 觸發 | code | 行為 |
|------|------|------|
| 零 entry（env + AppSetting 全空） | `NETWORK_POLICY_UNAVAILABLE` | deny；audit；run failed |
| env/AppSetting 任一 entry malformed | 同上 | deny（**無 partial policy**） |
| AppSetting shape 錯（非 array / 未知 key / 非 boolean） | 同上 | deny |
| DB 讀取失敗（run row / provider row / appSetting） | 同上 | deny（「無法證明安全」=「唔准出」） |
| gate 內部任何 throw | 同上 | deny（gate 對 engine 永不 throw；雙保險） |
| taskType 被 policy 禁 | `NETWORK_TARGET_DENIED` | deny |
| target 唔喺 allowlist（scheme/host/port 任一唔match） | `NETWORK_TARGET_DENIED` | deny（**無 DNS**） |
| scheme 非 http/https（file/gopher/ftp/data…） | `NETWORK_BAD_SCHEME` | deny |
| userinfo / 壞 URL / 壞 port / 降級 redirect | `NETWORK_BAD_TARGET` | deny |
| resolved IP 落入 blocked class（含 metadata 兩 zone） | `NETWORK_BLOCKED_IP` | deny |
| DNS 失敗 / 零地址 / 返回非 IP 字串 | `NETWORK_RESOLUTION_FAILED` | deny |

- `db == null`（worker 未 start）= env-only 路徑（start 前 job 唔可能到 gate — robustness 而已）。
- deny 後：run → `failed`（terminal）、FAILED event、穩定 `errorCode`、**唔 retry enqueue**。
  重投嘅 job 唔可以復活已 deny 嘅 run（terminal stays terminal — 測試實證）。

## 9. Audit（MD §12：actor、原因、可追蹤）

- 每個 deny → `audit_events` row：`action='network_policy_deny'`、`actorUserId=null`
  （= system）、`resourceType='task_run'`、`resourceId=<runId>`、`status='failure'`、
  `detailsJson = { actor:'system', code, taskType, attempt, identityId, batchId, target, reason(≤300), durationMs }`。
- **target 紅線遮罩**：`redactTarget()` 只保留 `scheme://host[:port]`（explicit port 才顯示 —
  WHATWG implicit port 省略）；**userinfo（憑證）/ path / query 永唔入 audit trail**（測試實證）。
- audit 寫入失敗**唔改變 verdict**（deny 照回；只 log.error）— 跟 `createAuditService` 慣例。

## 10. 暴露面核對（MD §5.1，2026-10-21 gen2 實核）

| §5.1 要求 | 現狀（compose.yaml + code 實核） | 判定 |
|-----------|----------------------------------|------|
| 專用 Docker bridge，唔將所有容器 port 發到 host | 平台 5 容器走 compose 默認 project bridge；host port 只有 `web` 一個 | ⚠️ 見 gap G1 |
| `web` 唔暴露公网 | `127.0.0.1:${WEB_PORT:-3012}:3012` — loopback-only | ✅ |
| `api` 唔 publish host port | 無 `ports:` 段；`APP_HOST=0.0.0.0` 只係容器內（compose network 範圍）；web 同源反代 | ✅ |
| postgres / redis 唔暴露 | 兩者皆無 `ports:` 段（internal only） | ✅ |
| ADB 只對授權 worker 開放、唔 0.0.0.0 | `REDROID_LOOPBACK_BIND='127.0.0.1'` server-side 常量（route schema 無 bind 欄 — 客戶端改唔到）；ADB whitelist engine 目標只收 `127.0.0.1:<port>`，fixed ops、禁 shell | ✅ |
| 只連白名單 staging/QA endpoint | 本單 network policy gate（§2–§9） | ✅（本單交付） |
| 出口 policy 失效 → fail-closed `NETWORK_POLICY_UNAVAILABLE`，唔直連 | §8 矩陣 + 測試實證（policy 未載入時 mock provider 都拒） | ✅（本單交付） |
| worker health port 3001 | 無 `ports:` 段（容器內 only） | ✅ |

**Gaps（= B6 整合項，本單唔改 compose）：**

- **G1 — 無 explicit `networks:` 段**：compose 靠默認 project bridge（`water-army_default`）。
  功能上已係專用 bridge（唔係 host networking），但 MD §5.1「專用」嘅顯式表述（自訂 name、
  隔離 subnet、必要時 `internal: true` 切公網出口）未落地。**B6**。
- **G2 — device（Redroid）容器用默認 `NetworkMode: 'bridge'`**（docker 默認 bridge，
  非 water-army project network）：device 之間互相可達、可達 host bridge gateway。
  ADB port 已 127.0.0.1-only（✅）但 network 層隔離未做。**B6**（與 G1 一齊設計：
  平台 network + device network 分工，gost 代理 172.17.0.1 bind 嘅位置要隨 network 決定）。
- **G3 — pinned-IP client 未接**（§6 TOCTOU 殘留 + §7 redirect client-side 啟用）：
  undici dispatcher 改造，動 `providers/` — B6。
- **G4 — AppSetting admin 寫入路由未建**（MD §12：只 Admin 可改網絡政策；
  本單 gate 已 enforce 讀取契約 + fail-closed shape 校驗，路由本身 = B6 範圍，跟 RBAC admin 一起）。

## 11. §14.4 / Phase 4 禁止邏輯掃描（2026-10-21 gen2）

掃描範圍：全 repo code（`apps/`、`packages/`、`scripts/`），pattern =
residential / proxy rotation / proxy pool / proxylist / fingerprint rotation /
device spoof / risk control / 住宅代理 / 風控。

**結果：零命中。** 現行「proxy」相關代碼只有：
- `redroid-service.js` 嘅 per-device 出口狀態（gost 本地代理，狀態詞彙 only、零 secret）；
- `scrub.js` 嘅 `proxy-authorization` header 清除路徑（標準 secret scrub）。

**無住宅代理輪替、無第三方平台風控規避邏輯 — 符合 Phase 4 紅線；本單亦無新增任何此類功能。**
（MD §14.4 尾段「測試出口只用自有/授權端點」= 本 policy 嘅 allowlist 語義本身 — 結構性滿足。）

## 12. 測試矩陣（119 項，全 hermetic — 零真網絡、零真 DNS）

| 檔案 | 覆蓋 |
|------|------|
| `tests/unit/network-policy-ssrf.test.js` | §A allow 快路 + pin 契約（resolve 恰好 1 次）／§B scheme 矩陣（file/gopher/ftp/data → BAD_SCHEME）／§C target shape + 無 DNS leak／§D **IP class 全表**（v4+v6 邊界 + mapped/compatible 偽裝）／§E rebinding（`[public, loopback]` 記錄、時間型 rebind、resolve throw/零地址/非 IP）／§F internal zone（metadata 顯式列出都拒、mapped metadata、CGNAT、public-IP internal entry、0.0.0.0）／§G entry parser 嚴格性（wildcard/userinfo/path/port 0/65536/leading-zero/whitespace/unbracketed v6/一條壞=全 list 壞）／§H normalizeHost canonical 匹配／§I parseTarget WHATWG 正規化／§J redirect（per-hop 全校驗、降級拒、loopback Location、非 allowlist Location、壞 scheme Location） |
| `tests/unit/network-policy-gate.test.js` | fail-closed 全矩陣（零 entry / env 壞 / AppSetting shape ×4 / DB read error）／gate 永不 throw ×3（run row read error、resolver throw、audit sink fail）／taskType policy／egress target 收集（mock/row-missing/disabled = 無 target）／audit 內容 + redaction（credential 漏出負向斷言）／env+AppSetting union／db==null env-only |
| `tests/integration/task-engine-policy-gate-swap.test.js` | **真 engine**（`createTaskEngine` + 真 `createTaskRunService`）跑 swap 後行為：allow 透明（succeeded、無額外 queue traffic、無 deny audit）／deny → run failed **pre-startAttempt**（provider 零接觸、零 retry、FAILED event、穩定 errorCode）／fail-closed（無 env 時 mock provider 都拒）／terminal stays terminal（redelivery 唔復活） |

運行：`npm test`（node:test，零外部依賴）。2026-10-21 實跑：**822 total / 821 pass / 0 fail / 1 skip**
（skip = 原本 env-gated real-redis；703 基線 + 119 新，零回歸）。
