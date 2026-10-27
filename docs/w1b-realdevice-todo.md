# W1b 真機段待辦清單（ADR-028 · NV-W1b 收口單）

> 前提：本清單 = 代碼段（COMPLETE，2026-10-27）之後、生產開關解鎖之前嘅唯一閘口。
> 執行環境 = 真機（qwen27B 段 / RAM gate 解除後）。**跑晒之前 `WA_TEMPLATE_PROFILES_ENABLED` 生產保持 OFF。**（2026-10-27 更新：`WA_REDROID_RO_OVERRIDES_ENABLED` 已老細拍板默認翻 ON — kill-switch = env 顯式設 `0`/`false`，見 ADR-025 開關節標；本單真機斷言口徑不變。）
> 紀律：每步落 evidence 到 `logs/realdevice-w1b/`；失敗 = 記錄 + 停，唔好繞過斷言。

## R0 前置
- [ ] R0-1 `docker pull`/build 定制 image：预期 digest == `sha256:9b0c697c3106…add33`（2026-10-27 12:21 重建實證；舊代碼段 build = `100ba08a…`，wrapper 層因 gcc:13-bookworm moving tag 漂移 **唔保證 bit-同** — 見 propctl.provenance.md「Reproducibility rebuild」；核實口徑 = real binary `ea647e1b…` + rc sha + test-mapping GREEN，唔係 image ID）。不一致 = 重建並記錄新 digest
- [ ] R0-2 校驗 `oem-propctl-real` sha256 == `ea647e1b6cafb2a639bd213e8dc33daaa73a7f8afadd2ee3116e4acd0b049c2b`（對 image 內實物，唔係對 repo 檔）
- [ ] R0-3 記錄 host RAM gate 狀態 + 用戶 stack（water-army-*）健康快照（開工前基線）

## R1 定制 image boot（映射生效實證）
- [ ] R1-1 用 w1b image boot 1 部機（帶 9 項 `androidboot.oem_*` Cmd 注入，model 用 `Pixel%208%20Pro` 形）
- [ ] R1-2 **早期映射 race 實證**：`adb shell getprop` 逐項核 9 個 `ro.*` 目標值 == 注入值（解碼後）；`ro.product.model` 必須係「Pixel 8 Pro」（含空格 = wrapper 解碼成功）；記錄 init 日誌入面 `oem-ro-map` exec 行嘅時間戳 vs `zygote-start`（映射必須早於 app 層任何讀取）
- [ ] R1-3 負向：(a) 唔帶任何 oem carrier boot → 全部 ro.* 保留 image 默認（各 action 唔觸發）；(b) 注入含雜散 `%`（直接 adb 改 Cmd 模擬）→ wrapper exit 2、目標 prop 保留默認、init 有非零 exit 記錄但唔 boot-loop
- [ ] R1-4 boot 時長 vs stock image 基線（exec 9 行 early-init 嘅代價記錄，>2s 異常要查）

## R2 probe 裝機 + ground truth
- [ ] R2-1 `probe-app/build.sh` 出 APK（需要 SDK build-tools + platform-34；首次 = 環境搭建，計入工時）
- [ ] R2-2 `adb install` + 啟動 → 取 `/data/local/tmp/wa-probe-dump.json`（+ logcat base64 雙通道交叉核對）
- [ ] R2-3 `node scripts/w1b/probe-assert.mjs --dump dump.json --expected <(GET /api/identities/:id/fingerprint)` → 9/9 PASS；任何 FAIL = 停 + evidence
- [ ] R2-4 自洽面人工覆核：partition-split `ro.product.*.{system,vendor,product,odm}` 有冇部分分區未映射（redroid 分區結構 = 已知風險點）；telephony carrier 名 vs profile carrier

## R3 V1–V7 重跑（W1 驗收矩陣喺 w1b 語義下）
- [ ] R3-V1..V7 照 `logs/realdevice-master/` V 矩陣全部喺**定制 image + template profile** 下重跑；逐項結果記錄（V3 = ADR-025 一直未過嘅真機項 — w1b 就係為佢存在）
- [ ] R3-R1 recreate 穩定性：同 identity 3× recreate → 3 份 probe dump 逐字段相同（除 propCount/telephony 動態欄）
- [ ] R3-R2 fleet 抽樣：≥10 identity（跨 ≥3 templates）→ shared-build 對（同 templateId 兩身份）兩部機指紋相同 serial 不同 = 真人形態實證

## R4 平台側閉環
- [ ] R4-1 migration `20261027120000` 喺真 DB apply（`prisma migrate deploy`）+ 回滚演練（safe-drop 聲稱實證）
- [ ] R4-2 `WA_TEMPLATE_PROFILES_ENABLED=on`（staging）→ 新 identity 全部 template 行（schemaVersion 2）+ 舊 W1 行零 drift 覆核
- [ ] R4-3 碰撞審計 endpoint 喺真 DB 回報 blocking=false（shared-build 形態）

## R5 L2 情報採集（只讀，唔修復）
- [ ] R5-1 GL：機內 `dumpsys SurfaceFlinger | grep -i gl` + GLES extension dump → 記錄 renderer 實值（預期見 host GPU 字樣 — 代碼段已錄「RTX 3090」情報）
- [ ] R5-2 `ro.hardware`/`ro.boot.hardware`/`ro.kernel.qemu`/prop 總數 vs 真人機對照組（借 1 部真 Pixel 行同一 probe）
- [ ] R5-3 `/proc` 形態 diff：电池 sysfs、傳感器清單、內存/CPU 佈局 vs 真機（probe 未蓋嘅用 shell 補）
- [ ] R5-4 `/vendor/etc/init/oem-ro-map.rc` + `/vendor/bin/oem-propctl*` 可見性：無 root app 實測可讀性（adb shell 用戶 vs app uid）
- [ ] R5-5 情報入檔 `docs/audits/w1b-l2-intel.md` → 餵畀 L2 立項建議（`docs/w1b-l2-l3-proposals.md`）

## R6 收口
- [ ] R6-1 acceptance report（w1b 版）+ ADR-028 NV 段落改寫為 VERIFIED/失敗因由
- [ ] R6-2 生產開關 decision paper → 老細拍板
- [ ] R6-3 失敗路徑：任何 R 段紅 = 圖文並茂 report，唔好自行放寬斷言（斷言口徑改動要過 ADR 修訂）
