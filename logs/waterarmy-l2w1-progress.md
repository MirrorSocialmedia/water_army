# water_army L2 波次1（高性價比曝露修復）— 代碼段 progress

**任務**：Kairo `mvqgmpgjbpju4` subtask 1（老細 17:04 拍板按 l2-l3-proposal 波次1 序施工）
**狀態**：**COMPLETE（代碼段）** — 真機 NOT VERIFIED（複測清單見下）
**日期**：2026-10-27　**CTO session**：waterarmy-l2w1-code

## Commits（main，全部已 push）
| Item | Commit | 內容 |
|---|---|---|
| 1+2 | `83ec610` | 時區落機（timezone → persist.sys.timezone，post-fs-data 段）+ ro.hardware/ro.boot.hardware 聲稱層補洞；carrier 鏈 9→12 row；probe 斷言面同步；test-mapping.sh sim 12/12 |
| 3 | `6bf179a` | `images/redroid-w1b/build.sh` = 唯一 build 出口（drift check → build → finalize → **post-build mode+uid 斷言**，fail-closed）；正/負路徑實跑存證 `logs/l2w1-build-evidence.log` |
| 4 | `3fc3477` | ADR-031（§31 + index）+ exposure-surfaces D2/D3/S2/紅旗#6#7 標注 + D6 abilist 評估記錄 |

## Suite
- **Full suite：1458 tests / 1452 pass / 0 fail / 6 skip**（基線 1455/1449/0/6 + 新增 3 測試，零回歸）
- 存證：`logs/l2w1-full-suite.log`
- 新增測試要點：12-row flatten 漂移 guard、post-fs-data/early-init phase 雙向篡改、hardware 一欄兩 target 同值、SKIP 語義（legacy 行降級非阻塞）、vacuous-assertion 非空 guard（表必須恰好 12 行；SKIP 必須恰好 2 行）、timezone IANA 值承載格式。

## 聲稱層邊界（波次1 拍板口径，詳 ADR-031 決策 4 表）
- 修：ro.hardware/ro.boot.hardware、persist.sys.timezone
- 免修：ro.kernel.qemu（真機實測為空 = 紅旗唔成立；probe note 保留防回歸）
- 接受+記錄：abilist 自相矛盾（改名會改 PackageManager 過濾行為 = 行為層；歸 L3 ARM 路線）
- defer：propCount 586 backfill（數據活 — 要真機 prop diff 表逐項填；template roOverrides 機制現成）

## ⚠️ 真機複測清單（下一批開機逐項斷言 — 用新 image `water-army/redroid:14.0.0-240527-w1b` = `sha256:bfa6a160a371…`）
1. **probe APK 重裝**（12-prop 版 — 舊 APK 唔睇新版 3 個 prop）→ probe-assert `--expected` 全 12 行 PASS。
2. **persist.sys.timezone 落地**：`getprop persist.sys.timezone` == profile.timezone；JS `Intl.DateTimeFormat().resolvedOptions().timeZone` 交叉對照（B5/S2 收口）。
3. **TimeDetector 覆寫行為**：開機 10 分鐘後再讀 persist.sys.timezone（+ `dumpsys deviceidle`/time_zone 相關 service 狀態）— 確認無運行時覆寫；若覆寫 = 記錄機制再定（ADR-031 已知風險）。
4. **post-fs-data exec 語義**：init log 無 oem-ro-map.rc 相關 `Skipping insecure file` / avc denied（post-fs-data 段 `exec --` 喺 redroid permissive posture 下應通 — SELinux 口徑同 early-init，但 phase 新舊唔同要實測）；`prop -q persist.sys.timezone` 時間戳/順序佐證（映射先於 zygote）。
5. **hardware board token 對照**：`getprop ro.hardware` / `ro.boot.hardware` == template `fields.hardware`；两值必須相同。
6. **ro.hardware 舊 tell 掃描**：任何 dump 路徑再見 `redroid` = 映射漏（probe NOTE 行都唔准出現）。
7. **Cmd 注入回讀**：`/proc/1/cmdline` 見 `androidboot.oem_persist_sys_timezone` / `oem_ro_hardware` / `oem_ro_boot_hardware`（承載鏈三邊對齊嘅 ground truth）。
8. **image digest 對帳**：開機容器用嘅 image id == bfa6a160a371…（build.sh 出口）。

## 未動面（紀律確認）
業務 route 邏輯零改動；Kairo 9800 零寫；redroid 零開機（RAM 窗口保留）；用戶 stack 零動；secrets 零入檔。
