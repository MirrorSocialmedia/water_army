# WA-OEMPROP S1 — 機制研究（ro.boot.oem_* → ro.* 解碼）

日期：2026-10-29（gen1）
狀態：研究完結，路線已選定（見 §4）。本檔 = 改 image 前的落檔（工單 S1 AC）。

## 0. 問題（P1 finding 摘要）

WA-REALDEVICE-FINAL P1（`docs/audits/realdevice-final/p1/`）實錚 redroid-rdfa-01
（gms-mtg image + P1 fingerprint profile）：

- carrier 22/22 送達 OK：container Cmd 嘅 `androidboot.oem_*` 全部 map 成機內
  `ro.boot.oem_*`（p1-10 / p1-11 實錄）。
- **0/12 ro.* 生效**：12 項指紋 ro.*/persist.* 全部保留 image 默認（redroid/GMT）
  （p1-09 host adb getprop 實錄）。
- 根因坐實：`/system/bin`、`/system/xbin`、`/vendor/bin`、`/system_ext/bin` 全無
  `oem-propctl`，機內亦無 oem init rc（p1-10 forensics）— 最後一步
  `ro.boot.oem_* → ro.*` 解碼冇發生。
- 正例對照：display 1080x2400@420 生效（`androidboot.redroid_*` →
  `ro.boot.redroid_*` 由 redroid 自身 native 代碼消費，唔經 oem 層）。

## 1. 注入鏈全圖（現狀，全部實證）

```
產品層 (redroid-service.js / fingerprint-profile.js)
  profile → roOverrides map (PROFILE_PROP_MAP：11 fields → 12 targets)
  buildRoCmdArgs() → androidboot.oem_<prop dots→underscores>=value
        │  docker create Cmd（container start args，redroid-doc 官方機制；Env 刻意留空）
        ▼
redroid init（patched AOSP init，image 內 /init → /system/bin/init）
  argv 嘅 androidboot.X → ro.boot.X（AOSP 標準前綴處理；strings 實證 init
  binary 只有 "androidboot." 前綴邏輯，無任意 ro.* 直寫路徑）
        │  （實錄 p1-11：20 項 oem_* carrier 全部喺 ro.boot.oem_* 空間）
        ▼
ro.boot.oem_* 生值停泊 ← 【MTG image 喺呢度斷鏈】
        │
        ▼  （w1b image 先有呢一步：/vendor/etc/init/oem-ro-map.rc）
early-init：on early-init && property:ro.boot.oem_ro_XXX=*
  exec -- /vendor/bin/oem-propctl ro.XXX ${ro.boot.oem_ro_XXX}
  oem-propctl = static C wrapper（%20→space 解碼，雜散 % fail-closed）
                execv resetprop-rs v0.6.0（直寫 property area，
                bypass init ro.* one-time-write rule — ro.build.* 喺
                early-init 前已入 build.prop，plain setprop 必 no-op）
post-fs-data：persist.sys.timezone（init 喺 fs stage 重新 load /data
  persistent props，所以 persist.* 必須喺 post-fs-data 先至確定性）
```

source of truth（全部入 repo、CI unit-diff 防漂移）：
- 映射表：`packages/shared/src/w1b-image-mapping.js`（carrierMappingTable()，
  11 fields → 12 targets，同 PROFILE_PROP_MAP 一嚿）
- rc artifact：`images/redroid-w1b/oem-ro-map.rc`（GENERATED，
  `scripts/w1b/generate-wa-ro-map-rc.mjs --check` 驗證 — 本單實測 in sync）
- 二進制：`images/redroid-w1b/vendor/oem-propctl-x86_64`
  （resetprop-rs v0.6.0，sha256 `ea647e1b…049c2b`，
  `propctl.provenance.md` 全程紀錄；wrapper 源 `propctl-wrapper.c` 入 repo，
  build 時 gcc:13-bookworm static 編譯）

## 2. 最短路判定（S1 要求 — 照實記錄）

**問題：redroid 啟動參數層可唔可以直傳 ro.*？**

判定：**唔可以（結構性）。**

證據：
1. AOSP init 嘅 cmdline 處理只有一條通用路徑：`androidboot.X` → `ro.boot.X`
   （前綴 rewrite）。init binary strings 實證只有 `androidboot.` 前綴邏輯
   （+ 少量內建特例如 androidboot.selinux / partition_map），**無任何
   `androidboot.ro_*` → `ro.*` 或直接 ro.* 注入路徑**。
2. P1 實錄（p1-11）：20 項 `androidboot.oem_*` 全部落喺 `ro.boot.oem_*`，
   零項直接落 ro.* — 行為同 (1) 完全一致。
3. 就算 init 支持直傳，ro.* namespace 有 one-time-write + boot 後封鎖語義，
   `ro.build.*`/`ro.product.*` 喺 early-init 前已由 build.prop 佔位 —
   呢正係 W1b 選 resetprop-rs（直寫 property area）而唔係 setprop 嘅原因
   （`w1b-image-mapping.js` 頂部註釋，ADR-028/031 決策鏈）。
4. redroid 上游無 oem prop 直傳 feature（redroid-doc 參數面 = width/height/
   dpi/fps/gpu_mode 等 redroid_* knob，全部 ro.boot.redroid_* 消費）。

結論：**最短路唔存在。oem-propctl（image 內解碼器）係唯一唔改 init 二進制
（= 唔重建 AOSP）嘅路。** 呢結論同 W1b 當初（ADR-028）一致，本單只係將
已驗證層 merge 落 GMS 變體。

## 3. 選定路線 — Route A：W1b 層 merge 入 gms-mtg

### 3.1 已有真機驗證（唔係紙上設計）

W1b 真機段（`logs/rdev-single/verdict.md`，2026-10-27，w1b-f1 image）：
- R1-2 **9/9 ro.* == template**（含 "Pixel 8 Pro" %20 解碼）；rc import 乾淨；
  映射早於 zygote64 **5.4s**（= 早於任何 consumer 讀 ro.*）。
- R1-3 負向：無 carrier = 零 action（image 默認不動）；雜散 % = fail-closed。
- R1-4 boot：carrier boot 8–21s vs 無 carrier 8s；rc parse 2ms。
- R3 recreate 3× byte-identical（映射冪等）。
- 舊 image（未 finalize，rc 0664 group-writable）實測 "Skipping insecure
  file" 靜默死 → **build 管線強制 mode/ownership 斷言（build.sh post-build
  assertion，fail-closed）**。

### 3.2 點解 gms-mtg 冇呢層

`images/gms-mtgapps/build-record.md` RED LINES：「stock pin base ONLY; W1b
carrier/ro.* layer untouched（two-layer merge = post-PoC decision，
docs/gms-variants.md）」— GMS 變體當初刻意唔 merge W1b 層。本單 = 執行
嗰個 deferred decision。

### 3.3 構建選擇（S2 將照呢個做）

| 方案 | 內容 | 判定 |
|---|---|---|
| **(i) FROM gms-mtg + COPY W1b 3 件** | `water-army/redroid:14.0.0-240527-gms-mtg` + `/vendor/etc/init/oem-ro-map.rc` + `/vendor/bin/oem-propctl-real` + `/vendor/bin/oem-propctl`（gcc stage 編譯） | **選定** — gms-mtg = 生產實證 base（P1 GMS/進程/UI 全綠）；delta 最小（~500KB）；W1b artifact 零拷貝（build context = repo root，COPY `images/redroid-w1b/...` 原檔，drift check 兜底） |
| (ii) FROM w1b + COPY MTG payload | 重跑 MTG unzip/merge 490MB | 拒 — 同 gms-mtg 實證 base 距離大、delta 大、無收益 |
| (iii) docker cp + commit 手改 | 無 repo 化、唔可重現 | 拒 — 違反工單「build 腳本入 repo」 |

實測前提（本單 S1 已核）：
- gms-mtg 有 `/vendor/bin` + `/vendor/etc/init`（docker export 實錄；MTG zip
  只動 product/system_ext，/vendor 同 stock base 一致）。
- gms-mtg 無任何 oem-propctl 殘留（P1 forensics + 本單 export 複核）。
- build 料本地齊：gcc:13-bookworm、alpine:3.20、gms-mtg image；rc generator
  `--check` 綠。

### 3.4 範圍決策（邊界紀律）

| 項 | 決定 | 理由 |
|---|---|---|
| oem-proc-view 層（/proc view，L2 wave-2） | **唔入** | 本單 AC = 12 ro.*；proc-view 係獨立 feature（verdict 標 implemented-unverified），唔摻未驗證行為入 GMS 變體。oem_mem_* carrier 會照送達但保持生值（同現狀一致） |
| carrier 注入鏈（產品層 buildRedroidCmd） | **零改動** | 22/22 送達係正常嘅（工單明令） |
| 預設 image / 模板 | **零改動** | 新 tag 入 batch allowlist 供建機，預設切換等老細拍板 |
| 舊 tag `14.0.0-240527-gms-mtg` | **零破壞** | 只新增 tag `14.0.0-240527-gms-mtg-oemprop` |
| secret 入 image metadata | **零** | Dockerfile 無 LABEL/ENV secret；W1b artifact 全部 public provenance |

## 4. S3 真機驗收預先規劃（身份處理 = 唯一設計決策點）

「對齊 P1 同一 fingerprint profile」= P1 profile 值（p1-02：motorola/Redmi1BA
/…/MOTO-616277-P6V8）係 `generateTemplateProfile(identityId)` 嘅**確定性函數**
（fingerprint-service.js drift guard：stored row 必須 byte-equal 重新生成）。
→ **P1 嘅 profile 值只可以來自 identity `9c931b40-a100-4300-906b-232c97e413ec`
（externalRef redroid-rdfa-01，P1 建機時綁定，現 PENDING_LOGIN、device 已刪）。**

阻塞 + 解法：
- 阻塞：`identity_data_dir_claims` 有一行 stale claim
  （identity 9c931b40 → `/var/lib/water-army/redroid/redroid-rdfa-01`，
  P1 建機時建）— 直接綁新設備 redroid-rdfp-01 會 409
  `DATA_DIR_CLAIM_CONFLICT`（one identity one data home）。
- 成因：P3 teardown 時 data dir `rm -rf` 失敗（Device or resource busy，
  p3-02 實錄）→ removeData 唔完整 → claim 未清（removeData=true 先會刪
  claim，redroid-service.js:2644）。
- 解法（S3 執行）：
  1. SQL 刪嗰行 stale claim（本項目自己 namespace redroid-rdfa-01 嘅殘留，
     非禁碰集；device row 已唔存在 = claim 已 stale）。
  2. 新設備 `redroid-rdfp-01` 綁 identity 9c931b40（新 dataDir
     `.../redroid-rdfp-01`，自動建新 claim）。
  3. 核過運行時安全：identity `externalRef`/`dataPath` 喺單機設備流程
     （POST /api/devices/redroid）零消費（externalRef 只用於 display/label；
     dataPath 只用於 batch 容器 volume 路徑）— 命名 mismatch 無行為影響。
  4. 舊 data dir `redroid-rdfa-01`（busy mount 殘留）**唔碰**（P3 已收口，
     非本單範圍；報告照實記錄）。
- 新模板：`oemprop-verify`（image = 新 tag，1080x2400@420@30 gpu host，
  對齊 mc-dogfood-gmsmtg 幾何），API 建機；唔改任何現有模板。

驗收口徑（同 P1 p1-09 一致）：host adb `getprop` 12 項逐項 = 設備 row
roOverrides 注入值；非指紋 ro.* 抽樣對照 gms-mtg 基線；GMS 探測 = wa-attest
gms probe 段（P1 基線：GMS 22.21.16/Play 30.4.17/gsf 14 OK，Play Integrity
-12 = unauthenticated redroid 環境性，非 image 回歸）；boot 時間記錄
（P1 ≈10s 基線；W1b 真機數據：rc parse 2ms、映射早 zygote 5.4s、carrier
boot 8–21s → 預期 <2x）。

teardown（工單紀律）：產品 API DELETE（confirm=機名兩步 + removeData=true）
→ 核 data dir 清 + claim 歸位 + lease 歸 baseline（RAM gate
`GET /api/system/ram-gate`）+ 禁碰集 {rdev-f1, redroid-mc-dogfood-2,
rdev-e1-gost} 零觸碰。

## 5. 風險表

| 風險 | 評估 | 緩解 |
|---|---|---|
| MTG 變體 init 行為偏差（同 w1b 驗證 base 唔同） | 低 — init 二進制/SELinux posture 同 stock base 完全一致（gms-mtg 只加 product/system_ext 檔案） | S3 真機 12/12 係硬 AC；負向保障：無 carrier 時 rc 零 action（W1b 已驗證語義） |
| resetprop-rs 改 ro.* 影響 GMS 判斷（指紋變更 = GMS 見到「真機」profile） | 低-中 — 指紋本嚟就係目標（偽造成 real device story）；P1 已證 GMS 喺 redroid 默認指紋下都起晒 | S3 wa-attest gms probe 對 P1 基線；有回退 = 舊 tag 原封 |
| boot 拖慢 >2x | 低 — W1b 真機實測 rc parse 2ms、3-4 次 exec 各 ~ms | S3 記錄 boot 時間；>2x 要解釋（工單 AC） |
| claim 誤刪（stale claim 判定錯） | 低 — 只刪 identity 9c931b40 × dataDir redroid-rdfa-01 嗰一行，SQL 前核 devices 表無該機 | S3 執行前 SELECT 快照留證據 |
