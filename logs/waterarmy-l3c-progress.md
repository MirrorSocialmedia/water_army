# water_army L3-C' — ARM 翻譯層入 redroid image（progress log）

Kairo: mvqgmpg7w82rk（實驗批最前，老細 19:40 拍板「ARM 先試吧」）
CTO session: mvqgmpg7w82rk / mvqgmpg…（本單施工段）· 2026-10-27 19:40 →

## 紀律追蹤
- RAM 口徑：rdev-single gate（floor 6144 MiB + 2560/device projection，boss 17:31 scratch）— 每次 boot 前 `free` 實測記錄於 `logs/l3c-arm/ram-watch.log` + `logs/rdev-single/harness.log`（boot.sh 內置）。
- 開機上限：≤2 部（本單只用 1 部 rdev-a1）。
- 唔碰 Kairo 9800 寫；用戶 stack 零動；串行唯一 active CTO。
- mem0 gateway（127.0.0.1:18789 /search /memories /add 全部 404）— **本段期間 memory 服務不可用**，照紀律記錄不阻塞；關鍵沉澱改入 repo 文檔（本檔 + SOURCE.md + §6）。
- 連敗計數：0（截至 checkpoint 2）。

## 進度
| 時刻 | 步驟 | 結果 |
|---|---|---|
| 19:40–45 | 物料取得：redroid-script A14 houdini 鏈（rote66/vendor_intel_proprietary_houdini@0c149b1 + redroid_libhoudini_hack@a2194c5）落料 `vendor/arm-translator/`；md5=上游 pin ✓；sha256 記錄 SOURCE.md | ✅ |
| 19:45 | berberis 現狀文檔核：base 得死 `libnb.so` 指向（redroid-doc #933 同類）；emulator 拆件要 API-matched + exec_region 庫 → 本 spike 用 houdini，berberis 列 follow-up | ✅ |
| 19:46 | **base 實測更正**：`14.0.0-240527` build.prop = `ro.zygote=zygote64_32`、abilist 已含 arm 群、`/system/lib` 有真 i386 運行時 → gms-variants §1d「64-bit only」講錯（已更正文檔）；ARM32 結構可行 + 「abilist 講大話」紅旗確認（libnb.so 懸空）| ✅ |
| 19:47 | `images/gms-mtg-arm` build：兩段式（alpine unpack 模式 pin + per-subdir COPY 疊 gms-mtg base，base id pin 斷言）；post-build insecure-file 斷言 GREEN（12 pinned files + 318/325 arm mirrors 全 0644 root:root）；image `sha256:5c24b8b678b2…c4a8b8` | ✅ |
| 19:49 | commit `7b3bdbb` + push（checkpoint 1）| ✅ |
| 19:49– | RAM 窗口觀察：MemAvailable 7.5–8.1Gi 震盪，projected <6144 = gate DENY（需 ≥8704 先開窗）；watcher `scripts/rdev-single/ram-watch.sh` 後台跑，樣本入 ram-watch.log | ⏳ |
| — | EXP-6 真機四層判據（boot→install→launch→browse）| 待窗口 |

## 下一步（順序）
1. RAM 窗口開 → `arm-exp.sh boot` → collect → install → launch → browse →（證據齊）teardown。
2. §6 EXP-6 成文 + verdict 四類判定 + full suite 存證（純 image/docs 都跑一次）。
3. 收口 commit + push + 交回。
