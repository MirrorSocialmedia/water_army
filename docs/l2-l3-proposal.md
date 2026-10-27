# L2 / L3 立項輸入包（T7 匯總，2026-10-27）

> 輸入 = `docs/exposure-surfaces.md`（本審計，編號 D/S/N/B/A 引用於此）+ ADR-028（L1/L2/L3 分層）
> + `docs/gms-variants.md`（T1 ABI/認證情報）+ `logs/realdevice-master/acceptance-report.md`（真機實測）
> + `docs/w1b-l2-l3-proposals.md`（早期建議 — 本檔係其**升級版**，加入瀏覽器層 + 一致性維度）。
> 口徑：呢兩張係**工單草案**，俾老細拍板；開工前各自要新 ADR。證據等級沿用 [實測]/[文檔]/[推論]。

## 總策略判斷 [推論，輸入已標注]

1. **瀏覽器層係主戰場**（browser-first 已拍板）：Meta web 一行 JS 已同時讀到 GL(B4)、核數/RAM(B2)、
   時區(S2)、屏幕幾何(B6) — 呢四項而家全部同 ro.* 故事矛盾。**「修 app 層指紋但唔修 web 一致性」
   = 白做**；反之修 web 一致性大部分要經 L2 設備層手段（/proc、GL、display）→ **L2 範圍必須以
   web 可見面為優先排序**，唔係以「完整隱藏容器」為目標。
2. **一致性 > 完美偽裝**（B7）：每加一個偽裝面 = 新增自洽責任（w1b-l2-l3 原有紀律，本審計升級為
   **驗收標準**）：任何 L2/L3 修復嘅 Done 定義 = probe 斷言矩陣（w1b-consistency 擴充）全綠，
   包括 web probe JSON 交叉斷言（例：`navigator.hardwareConcurrency === profile.cpuCores`）。
3. **L3 喺 browser-first 下降級**（詳見 L3 節）：Meta 三平台 web 登入唔問 Play Integrity；
   Gmail 登入亦唔問（gms-variants §1e [文檔: 社群共識 + T1 判斷]）。L3 唯一剛需觸發器 =
   業務要求「Google 後端依賴 app 功能」或「平台明查 device integrity」— **情報未齊前唔付維護稅**。

---

## 工單草案 A — L2 硬件表層偽裝（路線：web 可見面優先）

**目標**：令「web 一頁 JS + app 標準 SDK」睇到嘅硬件故事 = profile template 講嘅故事。
**前置**：W1b 真機段收口（NV-W1b）+ 本審計採集項（真機對照組 probe diff）— **未採集就開工 = 賭**（w1b-l2-l3 紀律照守）。

### 範圍（按優先級 = 「今日紅旗表」排序）

| 項 | 內容 | 審計編號 | 成本 | 風險/備注 |
|----|------|---------|------|-----------|
| L2-1 | **/proc 视野偽裝**：bind-mount `meminfo`/`cpuinfo`（+ 可行時 `uname` syscall 層）為 per-identity 真機值 | D5/D10/D11 → **B2 根因** | 中（3–10 人日方向 [推論]，w1b-l2-l3 §L2-3 同項細化） | Chrome 讀核數經 syscall 唔止 /proc — bind-mount 可能唔夠，spike 先（1 人日判定技術邊界 [推論]）|
| L2-2 | **時區/locale 落機**：`persist.sys.timezone` + locale 入 carrier 映射（值已喺 profile DB [實測: fingerprint-profile.js:129]） | S2/B5/N6 | 低（生成器+rc+validator 各加欄；W1b 承載機制現成 [實測: ADR-028 §4]） | IP 池地理 = 時區池對齊紀律要埋（N6 政策項）|
| L2-3 | **display 幾何 per-identity 池**：分辨率/DPI 池化 + 旋轉行為 spike | D7/B6 [實測: acceptance L7/F15] | 低-中（分辨率配置 [推論]）+ 旋轉 = 未知（upstream 依賴）| 幾何改咗要同步 web 斷言（viewport×dpr = profile 屏幕规格）|
| L2-4 | **GL renderer 對策**：路線 (a) swiftshader/ANGLE 改名起步 + (c) 機隊 GPU 同質化長期（w1b-l2-l3 §L2-4 結論維持）；**新增輸入**：B4 = web 側同步收，extension 組合必須並改 [實測: 我哋已有 extHash 採集] | D4/B4 [實測: RTX 3090] | 高（10+ 人日級，独立 spike 先） | 深度對抗者查 ext 組合會穿 — 斷言矩陣必須含 extHash 對照 |
| L2-5 | **prop 殘洞**：`ro.hardware`/`ro.boot.hardware`/`ro.kernel.qemu`/propCount 補洞（W1b 只映射 9 項 [實測: w1b-image-mapping]） | D2/D3 | 低（build.prop 改值 + mapping 表擴充 = JS 源頭改一行/prop，w1b-l2-l3 §L2-2 維持） | 低風險、高性價比 — 建議隨首個 image rebuild 順車 |
| L2-6 | **傳感器/電池注入**：SensorManager 列表 + battery 狀態偽裝（採集後定深度） | D8/D9（採集項 X2/X3） | 中（sysfs/HAL；w1b-l2-l3 §L2-3） | web-first 下優先級低於 L2-1~4；app 路線開動時升級 |
| L2-7 | **settings DB 注入**：真機對照 diff 表驅動嘅 per-identity settings put 集 | S1/S5（採集項 X1） | 低-中 | adb_enabled 照接受（操作需求，紅旗表 #13 口徑）|
| L2-8 | **（可選）canvas/audio 穩定隨機化**：若採集證明艦隊同質係實際風控輸入先做；語義 = per-identity 穩定噪聲 | B3 | 中 | Chrome 層改造成本屬 [推論] — 開工前要 PoC |

### L2 驗收標準（草案）
1. 真機對照組（≥1 部真 Pixel）行同一套 probe（web + wa-probe/2）→ **diff 表归零或白名單化**（每條殘留 diff = 拍板接受嘅紅旗 + 紅旗表更新）。
2. web probe 斷言矩陣入 CI（`probe-assert` 姊妹腳本）：`navigator.hardwareConcurrency`/`deviceMemory`/`Intl.timeZone`/WebGL renderer/canvas hash 穩定性（identity 內 2× 一致、跨 identity 差異）全綠。
3. 任何 L2 偽裝面改动 → 斷言矩陣必須同步改 + 真機段重跑（防「假綠」紀律同 F12/F13 教訓）。
4. RAM gate/性能影響記錄（bind-mount/HAL 唔准觸 16G 常守線 [實測: 验收紀律]）。

### 工作量方向
L2-2/L2-5 = 人日級（順車項）；L2-1/L2-3 = 人周級（含 spike）；L2-4 = 人月級（独立 spike 先行）；
L2-6/L2-7 = 採集後評估。**建議波次**：波次1 = L2-2+L2-5（低價高傷防）；波次2 = L2-1+L2-3（web 一致性核心）；
波次3 = L2-4（GL，独立 ADR）；L2-6/7/8 按平台實測數據觸發。

---

## 工單草案 B — L3 Play Integrity / GMS / ABI（含 browser-first 重估）

**現狀缺口 [實測: ADR-028 §L3 + gms-variants §1e]**：零 attestation（無 keybox/TEE/attestation 鏈）→
Play Integrity 三檔全 FALSE；GMS 變體（MTG 綠 build [實測: gms-variants §0]）與 W1b 指紋層零交集（老細拍板等 PoC）。

### browser-first 重估結論 [推論]
| 觸發器 | 未觸發前 | 觸發後 |
|--------|----------|--------|
| Meta web 登入/日常操作 | **唔使 L3**（web 唔問 integrity）| — |
| Gmail 錨點（登入+收發） | 唔使 device integrity（gms-variants §1a [文檔]）| backup 加密/FindMyDevice 類功能要求 = 評估「功能取捨 vs 做」|
| 平台明查 integrity（社交/電商 app SDK 開始問） | 繼續採集觀察（J4 sign-off 矩程觀察項） | 開工 L3 路線 A |
| 需要裝 ARM-only app（D6 結構天花板 [實測: gms-variants §1d]） | web 路線迴避 | 評估 ARM 版 redroid / ARM host（新變體，非 keybox 範疇 — 歸 L3-C'）|

### 範圍（拍板後先細化）
- **L3-A Tricky-Store 類 keybox 注入**（w1b-l2-l3 §L3 路線 A 維持）：keybox 採購 + keystore 代理 + 維護稅；3–8 人日整合 + 持續成本 [推論]。**keybox 泄露週期性失效 = 長期帳单**，要老細白紙黑字。
- **L3-B 業務迴避**（0 人日）：如果拍板「Play Integrity = non-goal（browser-first 路線）」→ 紅旗表 #14 正式轉「接受」+ 本檔封存。**呢個係產品決策唔係技術債。**
- **L3-C 真機池對口**：高風險帳號 → 真機/雲真機；偵測對抗嘅盡頭係成本結構（w1b-l2-l3 原句維持）。
- **L3-C' ABI 路線**（本審計新增維度 [推論]）：D6 證明 x86_64 裝 ARM-only app 係結構天花板 — 若 App 面擴大，評估 arm64 redroid host（ARM 服務器 = 新 HW 採購）vs 保持 web-only。**唔好買 keybox 之前先答呢條數**。

### L3 驗收標準（若開工）
1. Play Integrity API 真機返回 `MEETS_DEVICE_INTEGRITY`（SOFT）為最低線；STRONG 另列。
2. GMS × W1b 合併後一致性斷言（A4/B7）：GMS app 讀到嘅 build == web ro.* 故事 == profile（wa-probe/2 + web probe 雙側綠）。
3. keybox 輪替 runbook（失效 = 可視告警，唔准靜默降級）。

### 建議次序（餵拍板）
1. **而家唔使拍 L3 開工**，要拍嘅係 **L3-B 口徑**：「browser-first 階段 Play Integrity = non-goal，觸發器如上表」— 白纸黑字封存。
2. GMS PoC（R1–R6）照排 — 佢嘅結論同時決定 A4 合併工程同 L3 觸發情報。
3. L2 波次 1–2 先行（web 一致性紅旗 #1/#4/#5/#7 除 GL 外全部有解）。

## 明確唔建議（沿用 w1b-l2-l3 + 本審計新增）
- 而家買 keybox（觸發器未確認）。
- 而家動 GL 層（L1 真機段斷言環境未收口 — 原紀律維持）。
- 用 prop 改名修 D6 ABI 矛盾（行為層裝得但 crash，改名反增不一致 [推論]）。
- canvas 隨機化做「每次隨機」語義（真風控見到 instability 即旗 [推論]）。

— 完（拍板欄：L2 波次順序 ___ / L3-B 口徑 ___ / 採集段排期 ___）
