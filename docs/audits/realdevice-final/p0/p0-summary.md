# P0 環境基線 — 斷言總表（WA-REALDEVICE-FINAL）

時間：2026-10-28 20:07–20:27 HKT（UTC 12:07–12:27）。證據檔同目錄。

| # | 項目 | 斷言 | 結果 | 證據 |
|---|------|------|------|------|
| 1 | RAM | MemAvailable ≥ hardFloor 4096 MiB；gate enabled；wouldAdmitNext=true | **PASS**（available≈43G；hardFloor=4096/target=5400；liveLeases=1；admitted=true projected 42351MiB） | p01-ram-gate.txt |
| 2 | MTG image | `water-army/redroid:14.0.0-240527-gms-mtg` 在，SHA 記錄 | **PASS**（sha256:02ab5675ba15f4acadaf21544a9e28aa5af774c3dd6a7e53e8b74d002fa4ecee，3.69GB） | p02-image-dataroot.txt |
| 3 | data root | /var/lib/water-army uid=1000 | **PASS**（drwxr-x--- 1000:1000；redroid/ + redroid-ramgate-g2/） | p02-image-dataroot.txt |
| 4 | gost 18443 | 過 gost 出 ipinfo.io = 200 + 出口 IP 記錄 | **PASS**（200，egress=103.194.185.206 Netsec HK） | p03-gost.txt |
| 5 | 宿主真直連出口 | env -i 真直連（排除 shell http_proxy=7897 陷阱）IP 記錄，且 ≠ gost 出口 | **PASS**（27.45.51.73 ≠ 103.194.185.206 → IP 判據在 P1 可用） | p03-gost.txt（CORRECTION 段） |
| 6 | 基線容器 | 水軍 5 容器 healthy；redroid-rdfa-* = 0；禁碰機在檔 | **PASS**（web/api/worker/redis/postgres healthy；禁碰 rdev-f1、redroid-mc-dogfood-2、rdev-e1-gost 已記錄；redroid-mc-dogfood-1 Exited 137 基線在檔） | p04-docker-baseline.txt |
| 7 | ADB | host canonical adb 可用 + 版本 + device 清單 | **PASS**（platform-tools 37.0.1 / adb 1.0.41；devices 清單空 = 基線；PATH 無 adb 已記錄） | p05-adb.txt |
| 8 | 拓撲限制① | api 容器 adb binary 有/無 記錄 | **限制（runbook §270 已知設計）**：api 容器無 adb → 平台 ADB zone = ADB_UNAVAILABLE/unknown；真驗證用 host adb（本單執行方式） | p06-topology.txt |
| 9 | 拓撲限制② | WA_W3_EGRESS_BINDING_ENABLED 狀態記錄 | **限制（fail-closed by design）**：未設（default false）→ W3 identity-egress 表面 503 EGRESS_BINDING_DISABLED；P1.5 會實測 503 後以文檔化手動路徑（settings put global http_proxy + gost）驗證 egress 機制本身 | p06-topology.txt |
| 10 | 拓撲③ | W1 ro override 開關 | **ACTIVE**（default true since 2026-10-27）→ 指紋注入路徑可用 | p06-topology.txt |
| 11 | 模板/身份 | MTG 模板 + 身份庫存記錄 | **PASS**（mc-dogfood-gmsmtg = MTG image、無 proxy；identity 1 個 READY） | p06-topology.txt |

**P0 判定：環境基線成立（7 PASS + 2 已記錄限制 + 2 拓撲事實）。可進 P1。**
