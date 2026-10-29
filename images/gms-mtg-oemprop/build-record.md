# gms-mtg-oemprop build record — WA-OEMPROP S2（2026-10-29，gen1）

Docker build only — NO redroid boot（RAM gate 不受影響；真機驗證 = S3）。

| Item | Value |
|---|---|
| Image tag | `water-army/redroid:14.0.0-240527-gms-mtg-oemprop` |
| Image ID / digest（**final = v4，S3 驗收版**） | `sha256:2d82732bbb88cbe4bfad64ec8680582b5c73e3ef289c2bd14a6a7728d0bb82b2`（迭代史：v1 `1becb88d…` / v2 `c26c6b99…` / v3 `134e1ae7…` — 見下方 S3 迭代表） |
| Base（pin 校驗後） | `water-army/redroid:14.0.0-240527-gms-mtg` @ `sha256:02ab5675…4ecee`（P1 實證生產 GMS 變體） |
| Delta | +5 files：`/vendor/etc/init/oem-ro-map.rc`（0644 root/root）+ `/vendor/bin/oem-propctl`（0755，static C wrapper）+ `/vendor/bin/oem-propctl-real`（0755，resetprop-rs v0.6.0）+ `/vendor/lib64/hw/hwcomposer.default.so` + `/vendor/lib/hw/hwcomposer.default.so`（0644，= redroid HAL 位元複製，sha pin） |
| 總大小 | 3.66GB（compressed 1.05GB）— base 3.69GB 共享層，delta ≈ 0 |
| Wrapper 編譯 | gcc:13-bookworm `-O2 -static -Wall -Wextra`；源 `images/redroid-w1b/propctl-wrapper.c` sha256 `18f71911…69254f`；產物 sha256 `d7bb0779cc6599be44b722c0fec870bda9f64f0380ebe00f07b20710444403ee` |
| propctl-real provenance | resetprop-rs v0.6.0（`images/redroid-w1b/propctl.provenance.md`）；sha256 `ea647e1b…049c2b` — build 管線 pin + post-build 再驗 |
| rc artifact | `images/redroid-w1b/oem-ro-map.rc`（GENERATED，12 targets = 11 early-init ro.* via oem-propctl + 1 `load_persist_props_action` persist.sys.timezone via **stock setprop**）；sha pin `3868d367…`；`generate --check` 綠 + baked rc == committed 斷言 |
| 刻意排除 | `oem-proc-view.*`（L2 wave-2，S1 §3.4 範圍決策）— post-build 斷言驗證 absent |

## Build 管線（`images/gms-mtg-oemprop/build.sh`，one command）

1. **Input pins（fail-closed）**：base image digest pin + W1b 3 artifact sha256 pin + rc generator `--check`（drift guard）。
2. **docker build**（context = repo root；root `.dockerignore` 已排除 `.env`/`logs`/`node_modules` — secret 零入 context，更零入 image；Dockerfile 無 LABEL/ENV）。
3. **finalize.sh**：mode pin（rc 0644 / bins 0755）+ root:root re-own（layer-tar rewrite + docker import config 還原）+ staged vs committed bit-identity 斷言。
4. **POST-BUILD ASSERTION**（container-free export 審計）：5 文件 (mode, uid/gid) 精確值 + `system/bin/setprop` 存在/owner/exec 斷言（rc persist 路徑依賴）+ baked propctl sha256 + 2×hwcomposer.default sha256 == base redroid HAL + baked rc == committed + proc-view absent。任何一項紅 = exit 1。

## Build 過程記錄（誠信）

- 首跑（07:1x HKT）：raw build + re-own 成功，但 finalize.sh 尾段 mode 驗證 grep
  模式 `oem-propctl `（尾隨空格）匹配唔到 tar 行尾嘅 plain wrapper 路徑 →
  靜默 exit 1，final tag 已存在但管線未完（PRE 未清）。**image 本身無問題**
  （手動 export 審計 3/3 正確）— 係 finalize 驗證腳本 bug，非 image 缺陷。
- Fix：grep 改 `\-rwxr-xr-x.*vendor/bin/oem-propctl$`（anchored full path）。
- 重跑（07:2x HKT）：全程綠，`SCRIPT_EXIT=0`，v1 digest = 該次產出。

## S3 真機迭代（v1 → v4，2026-10-29）

| 版 | digest | 變更 | 真機結果 |
|----|--------|------|----------|
| v1 | `1becb88d…` | 初版（3 files） | **boot loop**：`ro.hardware=redmi-1ba` → 無 `hwcomposer.default.so` fallback → SurfaceFlinger 唔起（zygote 5s 循環） |
| v2 | `c26c6b99…` | +hwcomposer.default.so 雙位（sha pin） | boot 成功；persist.sys.timezone = GMT |
| v3 | `134e1ae7…` | rc persist 行改 `load_persist_props_action`（仍 oem-propctl 寫） | 11/12；定位：**resetprop-rs 寫唔到 persist.\***（exit 0 silent no-op，area + /data/property 零改動；setprop 同值生效） |
| v4 | `2d82732b…`（final） | persist 行改 **`/system/bin/setprop`**（writer 分流入生成器 + parser 守門 + 測試）；setprop 斷言入 post-build | **12/12 fresh first-boot** + 基線 13/13 + GMS ok（`docs/audits/oemprop-report.md` §4） |

## 重現

```bash
cd <repo-root>
bash images/gms-mtg-oemprop/build.sh
# → water-army/redroid:14.0.0-240527-gms-mtg-oemprop
# 可重現口徑：輸入全部 pin（base digest + W1b artifact sha256 + wrapper 源）
# + 產物全部斷言（mode/ownership/baked sha/rc）— 內容 deterministic。
# 注意：finalize re-own 走 docker export/import，staged 文件 mtime 入層 →
# image digest 每次 build 唔同（W1b 同語義）；驗收看斷言 + 本檔 digest 紀錄。
```
