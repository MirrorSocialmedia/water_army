# gms-mtg-oemprop build record — WA-OEMPROP S2（2026-10-29，gen1）

Docker build only — NO redroid boot（RAM gate 不受影響；真機驗證 = S3）。

| Item | Value |
|---|---|
| Image tag | `water-army/redroid:14.0.0-240527-gms-mtg-oemprop` |
| Image ID / digest | `sha256:1becb88dfa170a75bb2e451eeec1e355b118762b656989855d2b86cbdb9bdcd2` |
| Base（pin 校驗後） | `water-army/redroid:14.0.0-240527-gms-mtg` @ `sha256:02ab5675…4ecee`（P1 實證生產 GMS 變體） |
| Delta | +3 files（~1.45MB）：`/vendor/etc/init/oem-ro-map.rc`（0644 root/root）+ `/vendor/bin/oem-propctl`（0755，static C wrapper，build 時編譯）+ `/vendor/bin/oem-propctl-real`（0755，resetprop-rs v0.6.0 x86_64，496,600 bytes） |
| 總大小 | 3.66GB（compressed 1.05GB）— base 3.69GB 共享層，delta ≈ 0 |
| Wrapper 編譯 | gcc:13-bookworm `-O2 -static -Wall -Wextra`；源 `images/redroid-w1b/propctl-wrapper.c` sha256 `18f71911…69254f`；產物 sha256 `d7bb0779cc6599be44b722c0fec870bda9f64f0380ebe00f07b20710444403ee` |
| propctl-real provenance | resetprop-rs v0.6.0（`images/redroid-w1b/propctl.provenance.md`）；sha256 `ea647e1b…049c2b` — build 管線 pin + post-build 再驗 |
| rc artifact | `images/redroid-w1b/oem-ro-map.rc`（GENERATED，12 targets = 11 early-init ro.* + 1 post-fs-data persist.sys.timezone）；`generate --check` 綠 + baked rc == committed 斷言 |
| 刻意排除 | `oem-proc-view.*`（L2 wave-2，S1 §3.4 範圍決策）— post-build 斷言驗證 absent |

## Build 管線（`images/gms-mtg-oemprop/build.sh`，one command）

1. **Input pins（fail-closed）**：base image digest pin + W1b 3 artifact sha256 pin + rc generator `--check`（drift guard）。
2. **docker build**（context = repo root；root `.dockerignore` 已排除 `.env`/`logs`/`node_modules` — secret 零入 context，更零入 image；Dockerfile 無 LABEL/ENV）。
3. **finalize.sh**：mode pin（rc 0644 / bins 0755）+ root:root re-own（layer-tar rewrite + docker import config 還原）+ staged vs committed bit-identity 斷言。
4. **POST-BUILD ASSERTION**（container-free export 審計）：3 文件 (mode, uid/gid) 精確值 + baked propctl sha256 + baked rc == committed + proc-view absent。任何一項紅 = exit 1。

## Build 過程記錄（誠信）

- 首跑（07:1x HKT）：raw build + re-own 成功，但 finalize.sh 尾段 mode 驗證 grep
  模式 `oem-propctl `（尾隨空格）匹配唔到 tar 行尾嘅 plain wrapper 路徑 →
  靜默 exit 1，final tag 已存在但管線未完（PRE 未清）。**image 本身無問題**
  （手動 export 審計 3/3 正確）— 係 finalize 驗證腳本 bug，非 image 缺陷。
- Fix：grep 改 `\-rwxr-xr-x.*vendor/bin/oem-propctl$`（anchored full path）。
- 重跑（07:2x HKT）：全程綠，`SCRIPT_EXIT=0`，上表 digest = 該次產出。

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
