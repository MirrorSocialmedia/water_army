# W1b 後續立項建議：L2 硬件表層 / L3 Play Integrity（ADR-028 §分層 — 僅建議，未執行）

> 定位：L1（ADR-028 本次）解決「build 身份係唔係真 build」。L2/L3 解決另外兩個獨立問題——
> **硬件講唔講得埋**、**attestation 有冇得傾**。三層互相唔能替代：L1 全綠 ≠ L2 過 ≠ Play Integrity 過。

## L2 — 硬件表層對抗（建議級別：中；依賴：L1 真機段全綠）

**問題實證（代碼段照錄真機情報）**：機內 GL renderer 直接爆 host GPU（實測見「RTX 3090」字樣）；`ro.hardware=redroid`、`ro.kernel.qemu`、prop 總數異常、`/proc` 电池/傳感器形態 = 全部同指紋層無關嘅獨立線索。任何肯讀 3 個 sensor 嘅偵測方都唔需要理你 build 指紋。

**工作量方向（由平貴排）**：
1. **採集先行（≈0.5 人日，已入真機單 R5）**：probe 對照組（1 部真 Pixel 行同一 probe）→ diff 表 = L2 工程清單嘅唯一真相來源。未採集就開工 = 賭。
2. **低價項（1–3 人日級）**：image 內 build.prop 改 `ro.hardware`/`ro.boot.hardware` 為真機值 + 删 `ro.kernel.qemu`（我哋已識 init 期寫 ro 嘅路）；prop 補洞（用真機 diff 表逐項補，生成器已支持任意 prop 注入 — 承載機制照用，只需擴 mapping 表 = JS 源頭改一行/prop）。
3. **中價項（3–10 人日級）**：传感器/电池 sysfs 偽造（redroid 支援程度未実測 = spike 先行 1 人日）；CPU 資訊（/proc/cpuinfo bind mount 覆蓋）。
4. **貴價項（10+ 人日級，独立 spike 先）**：GL renderer — 三個路線：(a) swiftshader renderer 名字偽裝（ANGLE/layer 改字，紅利即刻但深度對抗者查 extension 組合會穿）；(b) virgl/venice 類直通 + host 端改名（複雜、性能收益大）；(c) 接受 GL 層暴露，用真機 GPU 池對口（运维路線：機隊 GPU 同質化 = 暴露變常態）。**建議 (a) 起步 + (c) 長期**。
5. 風險：每加一個偽造面 = 新增一個自洽責任（GL renderer 講 NVIDIA 但 extension 列表講 swiftshader = 新穿煲點）。**L2 紀律：每次偽造必須由 probe diff 表驅動、有對照組、入斷言矩陣，唔准憑感覺。**

## L3 — Play Integrity / Keybox（建議級別：大；依賴：L2 後、業務有真需求先做）

**缺口如實（代碼段結論，唔使實測都成立）**：現行方案零 attestation 能力 — 無 keybox、無 TEE/StrongBox key store、無遠程配置证书鏈。Play Integrity 三檔（NO/SOFT/DEVICE+STRONG）目前全標唔過；呢個係**架構性缺口**，L1/L2 做得幾好都唔會自動縮細。

**工作量方向**：
1. **路線 A — Tricky-Store 類（社區已驗證紅roid 可行，3–8 人日級整合 + 維護税）**：注入 keybox（需要採購/自維護，合規同成本要老細拍板 — keybox 洩露週期性失效 = 持續成本）+ keystore 代理（定制 image 已經有 init 掛鉤基建，加 service 有路）+ 跟 Magisk/Play 更新嘅長期維護負擔。
2. **路線 B — 業務迴避（0 人日）**：如果目標平台係社交/電商 app 而唔係 Play-Integrity-gated app（銀行/Google 服務依賴），可以明確將「過 Play Integrity」列為 non-goal — **呢個係產品決策唔係技術債，要白紙黑字**。
3. **路線 C — 真機池混合（运维路線）**：高風險帳號放真機/雲真機，農場機只做低檢強度平台。同 L2 路線 (c) 同根：**偵測对抗嘅尽头係成本結構，唔係技術完美。**
4. 建議次序：R5/L2 情報到手後，先用**平台實測數據**（邊個平台真係打 integrity API）決定 A vs B；唔好預付維護税。

## 明確唔建議
- 而家就買 keybox（情報未齊，路線 A/B 未拍板）。
- 而家動 GL 層（RAM gate + L1 未收口，GL 改動會污染 L1 真機段斷言環境）。

— 完（L2/L3 任何一項開工前都要新 ADR；呢份檔 = 輸入材料，唔係授權）
