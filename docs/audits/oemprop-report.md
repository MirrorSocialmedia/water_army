# WA-OEMPROP — 自製 image 補 oem-propctl：12 項 ro.* 指紋真機生效

- 工單：`/home/kenneth/.openclaw/workspace/logs/waterarmy-oemprop-workorder.md`（WA-OEMPROP gen1）
- 基線：HEAD `0de0b9b`（WA-RDFA-FIX 收口後，全套 1658/1652/0/6）
- 交付 image：`water-army/redroid:14.0.0-240527-gms-mtg-oemprop`
  **final digest `sha256:2d82732bbb88cbe4bfad64ec8680582b5c73e3ef289c2bd14a6a7728d0bb82b2`**（v4，build-record 在 `images/gms-mtg-oemprop/build-record.md`）
- 結論：**12/12 真機生效（fresh first-boot）；非指紋基線唔變；GMS ok；舊 tag 零破壞**
- 審計日：2026-10-29（Asia/Hong_Kong）

---

## 1. 背景與根因（WA-REALDEVICE-FINAL P1）

P1 實測（`docs/audits/realdevice-final/p1/`）：12 項 ro.* 指紋注入 = **0/12 生效**；
forensics（p1-10/11）確定：carrier 22/22 送達 OK + `ro.boot.oem_*` 映射 OK，斷喺
**MTG 影像缺 oem-propctl 解碼器**（最後一步解碼入 ro.* 冇發生）。
S1 機制研究（`docs/audits/oemprop-s1-mechanism.md`）判定：無「redroid 啟動參數直傳 ro.*」
最短路（AOSP init 無該路徑）→ 選 **Route A**：W1b `oem-ro-map` 層（oem-propctl + 生成 rc）
merge 入 gms-mtg，舊 tag 零破壞。

## 2. S2 實作（image 層）

`images/gms-mtg-oemprop/`（Dockerfile + build.sh + finalize.sh + build-record）：
- base = `water-army/redroid:14.0.0-240527-gms-mtg`（sha256 pin）
- 入：`vendor/bin/oem-propctl`（%20 解碼 wrapper）+ `oem-propctl-real`
  （resetprop-rs v0.6.0 x86_64，sha256 pin `ea647e1b…`）+ `vendor/etc/init/oem-ro-map.rc`
  （生成器產出，sha pin，baked == committed assertion）
- 入（S3 發現後補）：`vendor/lib64/hw/hwcomposer.default.so` + `vendor/lib/hw/hwcomposer.default.so`
  = `hwcomposer.redroid.so` 位元複製（sha pin）— 見 §3 發現 #1
- 唔入：oem-proc-view 層（L2 wave-2，出範圍；MUST_ABSENT assertion 守門）
- secret 零入 image metadata（build-record 誠信口徑：digest 非 byte-reproducible —
  staging mtime 入層；內容 deterministic（pin + assertion））

## 3. 機制發現（真機實證，三個）

| # | 發現 | 實證 | 處理 |
|---|------|------|------|
| 1 | **`ro.hardware=redmi-1ba` 令 boot loop**：影像只有 `hwcomposer.redroid.so`，`ro.hardware` 唔係 `redroid` 時 HAL variant lookup 失敗 → SurfaceFlinger 唔起 → zygote 5s 循環（v1 實測 120s 無 boot_completed） | v1 機 zygote restart 循環 + logcat init 行 | `hwcomposer.default.so` fallback 複製（雙位 sha pin + post-build assertion） |
| 2 | **resetprop-rs（oem-propctl-real）寫唔到 `persist.*`**：exit 0 但 property area + `/data/property/persistent_properties` 零改動（silent no-op）；ro.* 11 項全部寫到 | 手動 `oem-propctl persist.sys.timezone Asia/Tokyo` → 無效；`setprop` 同值 → 生效（area + 檔案皆更新） | 生成器 writer 分流：persist.* → `/system/bin/setprop`（bionic 路徑，同時 journal 入 `/data/property`）；ro.* → oem-propctl。parse 守門（wrong writer = problem）+ 測試覆蓋 |
| 3 | **first-boot GMT one-shot writer**：`persist.sys.timezone` 缺席時，first-boot 系統邏輯寫 default GMT（同 `persist.sys.locale=en-US` 配對）；property 已存在時唔再寫 | v3 機首 boot GMT 落檔（00:06）；手動寫 Asia/Tokyo 後 **reboot 存活**（09:17 JST）；v4 fresh first-boot 即 12/12 | 唔需要 patch writer：rc 喺 `load_persist_props_action`（zygote 前）寫入 → property 全程存在 → writer 唔觸發 |

rc 相位（persist.*）= `on load_persist_props_action && property:<carrier>=*`：
init.rc 喺 `on post-fs-data` section 內行 `load_persist_props` builtin 後 fire 呢個 trigger
（ordering-guaranteed hook；bare post-fs-data section 可能排喺 builtin 前 — 見
`packages/shared/src/w1b-image-mapping.js` 註）。

## 4. S3 真機驗收（硬 AC 逐項，redroid-rdfp-01）

| AC | 結果 | 證據 |
|----|------|------|
| getprop 12/12 = P1 profile 值（p1-09 同口徑） | **12/12 PASS**（fresh first-boot，v4） | `oemprop-s3/s3-07b-compare-12of12.txt`（dump：`s3-07b-…getprop-v4.txt`） |
| 非指紋 ro.* 基線唔變（抽樣對照舊 image） | **13/13 PASS**（對照 P1 p1-25 舊 image dump context） | 同上（part 2） |
| GMS ok（wa-attest 或等價） | **PASS**（p1-28 同口徑：gms/bind/legacyapi ok；GMS 22.21.16 / Play 30.4.17 / gsf 14 = 同 P1 版本；safety/integrity task_error = 同 P1 已知 server-side 類） | `oemprop-s3/s3-08-gms-probe.txt`（logcat WA-INTEGRITY 6 行） |
| boot 時間（>2x P1 ~10s 要解釋） | **17.8s** fresh first-boot（1.78x）；v3 second boot 11.7s。口徑 = fresh /data first-boot GMS provisioning overhead，唔係 image 增量成本 | create 回應 + boot poll（`s3-04c-…`、本報告 §7 時間線） |
| 新 tag 入 allowlist + API 建機可用（預設切換唔做） | **PASS**：`batch.container_image_allowlist` +1 entry（tag 層）；3 輪 API CREATE 全部經 allowlist 成功；預設（template 默认）未切 | `oemprop-s3/s3-02-allowlist*.txt`、`s3-04*.raw` |
| teardown 經產品 API DELETE（confirm=機名 + removeData） | **PASS**（3 輪：v1 boot-loop 機 / v3 機 / v4 驗收機） | `oemprop-s3/s3-11-*.txt`、`s3-12-final-teardown.txt` |
| lease 歸 baseline | **PASS**：liveLeases=1 / reservedMiB=1200（= pre-snapshot 基線） | `oemprop-s3/s3-00-presnapshot.txt` + 收口 gate 查詢 |
| 禁碰集 {rdev-f1, redroid-mc-dogfood-2, rdev-e1-gost} | **零觸碰**（S3 全程 Up 時間只增） | 每次 docker ps 快照（evidence 檔內） |

### 3.1 v1 → v4 迭代（誠信記錄）

| 版 | digest | 結果 |
|----|--------|------|
| v1（W1b 原層） | `sha256:1becb88d…` | **boot loop**（zygote 5s 循環）→ 發現 #1 |
| v2（+hwcomposer.default） | `sha256:c26c6b99…` | boot 成功（11.7s 類）但 persist.sys.timezone = GMT → 發現 #2 定位中 |
| v3（rc 改 load_persist_props_action，仍 oem-propctl 寫 persist） | `sha256:134e1ae7…` | 11/12（persist 仍 GMT）→ **發現 #2 實證**（resetprop-rs persist no-op）+ 發現 #3（reboot 存活實驗） |
| v4（persist → setprop） | `sha256:2d82732b…`（final） | **12/12 fresh first-boot** |

## 5. 產品層 finding（出範圍，上報）

1. **removeData 對 privileged redroid 結構性失效**（本 deployment）：api 容器 uid 1000
   （node），redroid 數據目錄子層由容器 root 建立（root:root / 1023:1023 等，mode 750/700）
   → api `scandir` EACCES → DELETE 回應 `dataRemoved:false` + `claimReleased:false`。
   本單 3 輪 teardown 皆如此；收口 = host 側 alpine root 容器 `find -delete` +
   identity claim SQL 清理（evidence 在檔）。**產品修復方向**：removeData 用
   root-capable 清理路徑（docker run 掛載 or api 提權 sidecar）或建機時 chown 數據根目錄。
2. P1 既有 stale claim（`redroid-rdfa-01` 殘行）已喺 S3.1 清除（`s3-01-claim-removal.txt`）。

## 6. 交付物

- `images/gms-mtg-oemprop/`（Dockerfile / build.sh / finalize.sh / build-record.md）
- `packages/shared/src/w1b-image-mapping.js`（writer 分流 + phase + parser 守門）
- `packages/shared/src/fingerprint-profile.js`（persist 路徑註更新）
- `tests/unit/w1b.test.js`（20/20，含 writer/phase tamper 新斷言）
- `images/redroid-w1b/oem-ro-map.rc`（重新生成，sha `3868d367…` pin 入 build.sh）
- 證據：`docs/audits/oemprop-s3/`（16 檔）
- git：`7c02cd6`（S2）→ `c3b6ad3`（S3）→ S4 report commit（本檔）

## 7. 時間線（UTC，2026-10-29）

| t | 事件 |
|---|------|
| 00:03:53 | round-1 teardown（v1 boot-loop 機 + rdfp-02 對照機，API DELETE） |
| 00:05:51→00:06:02 | v3 機建機 + boot 11.7s → 11/12（persist=GMT） |
| 00:15–00:17 | persist 機制定位（resetprop-rs no-op / setprop 生效 / reboot 存活實驗） |
| 00:21–00:24 | v4 build + round-2 teardown |
| 00:24:14→00:24:32 | **v4 fresh first-boot 17.8s** |
| 00:24:40 | getprop 12/12 + baseline 13/13 |
| 00:25:37→00:27:18 | GMS probe（wa-attest，elapsed 90s，summary ok 口徑同 P1） |
| 00:28:xx | 最終 teardown（API DELETE）+ host 清理 + gate 歸 baseline |

## 8. 待老細拍板

- **切預設**：新 tag 已入 allowlist 且 API 建機可用；預設 template 切換**未做**（工單指示）。
- 舊 tag `…gms-mtg` 保留（零破壞），其指紋 KL 保留於 release-status §3.3。
- oem-proc-view（L2 wave-2 /proc 視圖）仍係獨立後續單。

## 9. 複現

```bash
# build（幂等）
bash images/gms-mtg-oemprop/build.sh
# 建機（新 tag 已入 allowlist）
# POST /api/devices/redroid {name:"redroid-rdfp-XX", templateName:"oemprop-verify",
#   identityId:<12-prop identity>, overrides:{width:1080,height:2400,dpi:420}}
# 驗收
adb -s 127.0.0.1:<adbPort> shell getprop  # 12/12 比對 profile
```
