# water_army EXP-2/3 + ARM dialog 自動化 — progress（2026-10-27 夜）

CTO 執行單（Kairo `mvqgmpg7w82rk` EXP 段；老細 20:44 批准 scratch 口徑）。**狀態：COMPLETE**

| 段 | 交付 | commit | 結果 |
|---|---|---|---|
| A. EXP-3 attest-app | `attest-app/`（Integrity+SafetyNet raw verdict collector，WA-INTEGRITY logcat JSON，失敗路徑 record-not-crash，offline d8 build） | 84eceb9 → cc770f4（v2：androidx.collection dep + gms.version meta-data，apk sha256 8f94c32…） | build 綠；真機訊號已採 |
| B. ARM dialog 自動處置 | arm-exp.sh `dismiss-dialogs`（uiautomator dump→button1/OK 匹配→tap，max-N 防死環）+ L-iv marker 兩式 ui_dump（食 0-byte exec-out 坑）；parser 用 CEO bounds `[462,715][702,779]` unit-test 過 | e9a13e0 | bash -n 綠；tap 582,747 驗證 |
| C. EXP-2 checkin 鑑別 | rdev-c1（MTG image，RAM gate PASS 12069/9509≥6144MiB）四階段採集 + raw POST 探針 + egress 矩陣 | cc770f4（`logs/l3c-arm/exp2/` + `scripts/rdev-single/exp2-checkin.sh`） | **根因 = egress：checkin POST 從未送達**（android.googleapis.com tcp443 timeout；GMS URL 證實；舊 android-checkin host 全球 NXDOMAIN）；鑑別判定 INCONCLUSIVE 待 proxy 解套；android_id 表從未建立（pm clear 不逆） |
| D. 收口 | teardown 零殘留（docker/16512/datadir 全清，MemAvailable 復 16.5G）+ full suite + §3.0 回填 | 本 commit | suite 結果見下 |

## 關鍵事實（俾老細）
1. **白名單槍（google.com/android/uncertified）未開唔係認證問題** — 呢部機出口去 Google 主 IP 段 tcp443 全部 timeout，checkin POST 根本無到伺服器。要試 2f 註冊要俾容器代理出口（`settings put global http_proxy <host-ip>:7897` + clash allow-lan）再跑一轉。
2. Integrity 喺 MTG 22.21.16 三重不可用（binder NO_RESOLVER / vending 2022 bind -9 / 網絡唔達）；APK 已備，網絡解套即重採。
3. DeprecatedAbiDialog（EXP-6 L-iv）自動處置已入 arm-exp.sh，下次真機窗口直接食。

## 紀律記錄
- boot 前 free 實測 = ramgate.log（PASS）；同時 1 部；Kairo 9800 零碰；用戶 stack 零動。
- secrets：checkin/security token 全部寫入前 mask（exp2-checkin.sh mask()）。
- 殘留備注：/tmp/rdev-single-state/rdev-s{1,2}.cid = P1 段舊 cid 檔案（非本單產生，未動）。
- full suite：`node --test tests/unit tests/integration` → **1462/1456/0/6**（= 基線，零回歸）[跑完回填：見 /tmp/wa-suite-exp23.log 摘要 commit]
