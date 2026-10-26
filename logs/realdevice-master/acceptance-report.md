# water_army 真機對抗式測試 — 總驗收報告（realdevice-master / P7）

**狀態: FINAL — 全部 7 相位完成**（2026-10-27 05:3x HKT）
**date**: 2026-10-27（HKT）| **relay**: leg 2（waterarmy-realdevice-relay2）接手 leg 1（P1+W1+W3 完成後中斷）
**base**: 127f10 → 09951dc（每 phase commit，main 直 push）| **fleet**: scratch rdev-*（14 容器：infra 6 + n1–n5 + W2 用 w1/w2）+ 真機 redroid-rdev-*（water-army/redroid:14.0.0-240527-matrixa-r3）→ **teardown 零殘留已驗證（§5）**
**紀律遵守**: 用戶 stack water-army-* 5/5 + SGLang 30000 全程零動；禁碰端口零觸；RAM gate 38G→>16G 常守；secrets 零入 log（D10 + P6 canary 實證）；Kairo 單 mvpd0vj2ez8nx 由 CEO 記帳

## 0. 總覽

| 相位 | 範圍 | 結果 | evidence root |
|------|------|------|---------------|
| P1 環境 | scratch fleet + 5 真機 + seed | GREEN | logs/realdevice-master/bringup-report.txt |
| P2/W1 | ADR-025 getprop 矩陣 V0–V7（10 身份） | carrier 100% / ro.* = image 限制（as-expected） | logs/realdevice-master/w1/ |
| P5/W3 | ADR-027 egress D1–D10 | **10/10 PASS**（run8） | logs/realdevice-master/w3/ |
| P3/NV5b | ADR-024 lease 生命周期 + sidecar 風暴 | 4/5（NV5-4 = P5 限流已知限制） | logs/realdevice-master/nv5b/ |
| P4/W2 | ADR-026 §26 E11+A10 | **完成（run7）：19 PASS + 2 EXPECTED-FAIL（E1 設計內 / A6 env-limit），halt 0**；實錚修 F12/F13 兩產品 bug；ADR-026 已回填 | logs/realdevice-master/w2/ |
| P6 安全 | RBAC + cross-identity + log-leak canary + repo scan | **完成（run2）：RBAC 17/17、cross-identity 零共享、log-leak 17 surfaces 零命中（7 部 guest logcat 全掃）、sensitive scan clean** | logs/realdevice-master/final/ |
| P6 teardown | 零殘留 | **完成：containers 0 / 16 端口全 closed / dataDir absent / apk absent / state absent / adb 0 / 用戶 stack 5/5 / SGLang 200 / RAM 44G 釋放** | logs/realdevice-master/final/teardown-verify.txt |

## 1. 四類判定（逐項）

### 1.1 已通過（真機實證）
- **W1 V0 carrier 注入鏈**：ro.boot.wa_* 9 項 × 10 機逐字節 = deterministic profile（10/10）
- **W1 V5 recreate 穩定性**：3× recreate carrier byte-identical + warm boot ~35s
- **W1 cross-identity 零洩漏**（a1↔b1）
- **W1 in-flight tamper**：drift create=500 拒 + zeroSideEffects + running 裝置不變
- **W3 D1–D10 全綠**（first-match verify / identity verified / proxy-death 1-tick 恢復 / DoH mimic / 雙身份+collision 409 / drift escalation / rotation .50→.54 / echo-off fail-closed / stale TTL / canary 19 surfaces 零洩露）
- **NV5-1/2/3/5**：五路 lease 生命周期、跨身份 403 OWNER_MISMATCH、單路 force-kill 3s 自動重連、release 零殘留
- **W2 E-phase（10/11 PASS + E1 EXPECTED-FAIL 設計內）**：E2 install 200+pm 旁證 / E3 app-get `installed:true`+`versionName:2.16.1`（F12/F13 修後）/ E4 launcher-dump 22 nodes / E5 tap-icon（drawer fallback）/ E6 foreground IntroActivity / E7 in-app-dump / E8 in-app-tap / E9 activity / E10 clean-device 404 / E11 uninstall 200+`installed:false`
- **W2 A-phase（9/10 PASS + A6 EXPECTED-FAIL env-limit）**：A1 注入 400×16+pm diff 0 / A2 路徑注入 400×6+symlink 拒+host 零改 / A3 自適應 cap 522+422 雙路實錚 / A4 413+pm diff 0 / A5 stale-selector 跨屏 404 零 blind tap / A7 腐敗四件（**magic spoof：host gate 按設計過 → 裝置裁決 502，pm diff 0 — ADR-026 實錚回填**）/ A8 真 docker stop 409×6→start→200 恢復 / A9 503×7 / A10 200×2
- **P6 RBAC（17/17）**：3 角色 × 真機 route（viewer 讀 200 / 4 類 NEG 403；operator admin-only NEG 403；RBAC-first 實證 = viewer + 完全合法 body → 403 FORBIDDEN 零副作用；admin positive control 200；two-step confirm 實彈：confirm 唔 match 裝置名/id → 400 拒）
- **P6 cross-identity（dataDir 隔離）**：w1/w2 第三方 pkg 交集 = 0；dataDir 路徑不同 + 存在性記錄
- **P6 log-leak canary（17 surfaces 零命中）**：scratch-api.log 30MB / echo.log / w1+w3 evidence / progress 檔 / 5 部 egress 容器 docker logs / **7 部 guest logcat（各 2MB 全掃）** — MC_SESSION_SECRET / APP_ENCRYPTION_KEY / WORKER_API_TOKEN / STREAM_TICKET_SECRET / SIDECAR_TOKEN / EGRESS_USER / EGRESS_PASS / JWT(eyJ) 全 0
- **P6 sensitive scan**：repo tracked tree + git history（-S pickaxe）零 egress canary 憑證；scratch fixture 密碼 = 文檔化已知（seed 腳本，非生產憑證）

### 1.2 已實施未驗證（gap / 誠實 NOT VERIFIED）
- **ro.* 映射生效（W1 V1/V2/V3/V4/V7）**：platform 實施 = ADR-025 開關 + carrier 注入；stock redroid14_x86_64 無 ro.boot.wa_*→ro.* 映射 → getprop ro.* 全 stock。V7 實證 root+SELinux-off 都寫唔到 ro.product.*（property_service ro-lock）、image 無 resetprop → **post-boot fallback 唔存在；要 image 層改**（見 §3 產品決策點）。開關照 ADR 生產維持 OFF。
- **no-proxy 裝置 adb-online（W1 finding #2 / W2 E1 實彈已回填）**：platform 無 refresh-time connect、diagnostics read-only、provisionTunnel 只限 proxy → no-proxy adbState 永無 platform 路徑 online（W2 E1 = 誠實斷言實彈：refresh 200 但 adbState=offline + raw adbd port 監聽正常）。
- **公共出口語義（W3 D4a/D4c）**：scratch egress 無 SOCKS5 UDP ASSOCIATE + guest 無 DNS client → NOT VERIFIED（紀律照 NV4，唔冒充）。

### 1.3 已知限制（實證 + 歸因）
| # | 限制 | 實證 | 歸因/狀態 |
|---|------|------|-----------|
| L1 | ro.* stock image 無映射 | W1 V1–V4/V7（§1.2） | image 層限制 — 待產品決策（§3） |
| L2 | P5 固定窗口限流封風暴恢復 | NV5-4：24 reconnect POST（200×4/429×20）、manual 4/5、第 5 部 92s 失敗；**跨 session 重現**（2026-10-24 同款數字） | ADR-023 §23.3 — 修 = limiter 策略變更 = **待老細拍板** |
| L3 | D4 純 DNS over tunnel | scratch socks5 無 UDP ASSOCIATE | scratch infra 限制（非產品 bug） |
| L4 | profile drift → fingerprint 500 拒 | W1 tamper + restore 500 | by design（fail-closed，唔猜）— ADR-025 預期 |
| L5 | stale Prisma client 500（live device.create） | P1 probe | **已修**（npx prisma generate + bringup regenerate 步驟） |
| L6 | FAILED net 軸凍結 egress 再驗證 | W3 #4（c1 13 連敗 → RECOVERY_EXHAUSTED → egress 軸停 probe） | 故障恢復路徑特性（非 ADR-027 邏輯違反）— 值得 ADR 註腳；manual door（proxy/retry）實彈驗證 <30s 解凍 |
| L7 | redroid 固定幾何顯示、運行時旋轉唔支持 | W2 A6 probe：`wm size override 1280x720` + keyevent 24 雙 no-op（"Physical size: 720x1280" 唔變） | 環境限制（redroid virtual display）— A6 旋轉 race 真機不可行，unit test 覆蓋；rotatable display 上原設計保留 |

### 1.4 暫緩（待決策/條件）
- **Limiter 策略變更**（L2 根因）— 待老細拍板後重跑 NV5-4 5/5 準線
- **platform refresh-time connect / provision 無 proxy 分支**（§1.2 adb-online gap）— 待產品排期
- **image 層 ro.* 映射機制**（§3）— 待產品決策

## 2. 產品發現清單（本單實測，依時序）
| # | 發現 | 相位 | 狀態 |
|---|------|------|------|
| F1 | ro.* = stock image 限制（carrier 100% 通但 ro.* 無映射；image 無 resetprop） | W1 | 待決策（§3） |
| F2 | no-proxy adb online 缺口（refresh 純 get-state / diagnostics read-only / provisionTunnel proxy 限定） | W1 | **W2 E1 實彈回填**（run7） |
| F3 | profile drift fail-closed（drifted row → POST /fingerprint 500 唔猜） | W1 | by design ✓ |
| F4 | stale Prisma client 掩咗 live 500（hermetic fakes 盲區） | W1/P1 | **已修 + bringup 防線** |
| F5 | egress echo anchor 不可 on-link（guest local routing 贏過 tunnel catch-all → DRIFTED 誤判） | W3 | harness 已修（off-link anchor）；生產部署要遵守 |
| F6 | FAILED net 軸凍結 egress 再驗證（watchdog skipped: failed-manual-only） | W3 | 見 L6 |
| F7 | egress probe FIFO regression（toybox nc 見 EOF 即 FIN 撕 gost relay — R8 文檔化 live regression；hermetic stub 用 cat 掩咗） | W3 | **已修 + 回歸測試**（8419e26） |
| F8 | template PATCH BigInt 崩潰（memoryLimitBytes BigInt → Number.isInteger=false → 任何 omit 該欄嘅 patch 400；D7 旋轉被產品層封死） | W3 | **已修 + live 驗證**（b946276） |
| F9 | config optInt 對顯式 0 hard-fail（D8 echo-off override 設計陷阱） | W3 | harness 已繞（blank host 方案） |
| F10 | P5 固定窗口限流（retryAfter 倒數實錄；ADR-022「sliding」文案錯） | NV5b | 見 L2（待拍板） |
| F11 | NV5-4 cookie-slot livelock 風險實測（screencap path；5 路 concurrent 重連耗盡共享 budget） | NV5b | = L2 實彈 |
| F12 | adb-whitelist engine `maxBuffer===report cap`：超 cap 輸出 → execFile 以非數字 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` kill 子程 → engine 歸一化 `exitCode:null` → 一律 502 ADB_UNAVAILABLE；「truncation is flagged」合約係死代碼（hermetic fake 唔 modeling maxBuffer kill 語義 = 盲區）。實彈：`dumpsys package` markor 324KB > 256KB cap → E3 恆 502；A3 522 byte-bomb 路徑同步不可達 | W2 run4/5 | **已修 + 回歸**（43e7844：4MiB hard kill-buffer 同 report cap 解耦） |
| F13 | `packageInfo` installed 判定 keyed 喺 `versionName=`（dump 尾部 line，實彈 byte ~319K/324K）— 任何 cap 截斷尾部即假陰性（實彈：修咗 F12 後 200 但 `installed:false`，pm list 證實已裝）；installed/absent 兩者 exit 0，唯一 discriminator 係 `Unable to find package:` 訊息 | W2 run5 前置驗證 | **已修 + 回歸**（9de96e8：absence-keyed + 1MiB dedicated read cap + version 欄 best-effort + `truncated` 誠實標記） |
| F14 | mid-matrix halt 跳過 A3 尾段 `restartApi({})` → A-phase env override（WA_UIA_MAX_NODES=50）洩入下個 run | W2 run5→6 | harness 紀律：halt 後 run-prep 一律還原 standard env（run6 prep 實做） |
| F15 | redroid image 無 scrollable overflow list + 無運行時旋轉（fresh dump 零 offscreen-bounds node；marker intro / drawer 11 icons / settings rows 無 direct text） | W2 A5/A6 probe | 環境限制（sparse redroid image）— A5 重設計為 stale-selector 跨屏（同安全屬性、更嚴）；A6 = L7；422 OFFSCREEN 路徑 unit test 實錚 |

## 3. W1 ro.* 產品決策點（專條）

**事實**（真機實證）：
1. carrier 注入鏈 100% 可靠：Cmd → guest `ro.boot.wa_*` 9/9 逐字節（deterministic profile）。
2. `ro.*`（ro.product.* 等）**零映射**：stock image 無 init 期 ro.boot.wa_* → ro.* 機制。
3. post-boot 寫 ro.* = 死路：root + SELinux-off 都唔到（property_service ro-lock）；image 無 resetprop。
4. `ro.boot.*` 本身可寫（V7 實證）— 即讀時點對，但系統/APP 讀嘅係 ro.* 唔係 ro.boot.*。

**選項**：
- **(a) 維持現狀**：開關 OFF（生產現態）；fingerprint 語義改讀 `ro.boot.wa_*`（carrier 保證）；ro.* 只當 stock 背景。成本=0；代價=目標 APP 若讀 ro.product.* 得 stock 值。
- **(b) 自製 image + init 期映射**：init.rc（或 custom init）boot 早期用 resetprop 將 ro.boot.wa_* → ro.*。成本=.image 維護線 + 每次 redroid 上游更新跟改；代價=完整 ro.* 語義。
- **(c) image bake resetprop + post-boot service**：比 (b) 弱（时序 race：APP 先起於 service 就讀到 stock）。

**測試口徑建議**：跟 (a) 先行（生產安全），(b) 立產品項（要 image 負責人 + 上游追蹤成本估算）；開關語義保留（per-template opt-in）。→ **待老細拍板**。

## 4. 執行事故記錄（leg 1+2 合併，全部已復原/防線化）
| 事故 | 影響 | 處置 |
|------|------|------|
| profileView nesting bug（W1 run-1/2） | 假紅 | 修 harness + 重跑（run-3） |
| a1 adb unknown 24min（W1 V5） | 誤判風險 | 產品發現 F2 實彈；手動 connect 復原 |
| D8 undici keep-alive ECONNRESET（W3 run7） | matrix 誤判 fatal | req() transient retry（w3+w2 同款） |
| egress echo anchor on-link（W3 D1） | DRIFTED 誤判 | off-link anchor 重建 |
| BIGint template 400（W3 D7） | 產品 bug | F8 修復 |
| NV5b leg-1 斷線於 storm 運行中 | 結果未記錄 | leg-2 採納完整 run（evidence 齊）+ 記錄 |
| w2 首次啟動 log 目錄缺失 | run 0 秒死 | mkdir + 重跑（relay leg-2） |
| w2 run1–6 六連紅（harness ×5 + 產品 bug ×2） | run1 log dir / run2 ensureDevices strict-throw / run3 online-flag fallthrough / run4 `adb -s … connect` 無效形式 / run5 A2 斷言字段錯（sl.http）/ run6 A5 假設唔成立 | 全部 live find 修復（7 輪，commit 鏈 7e5dccd→e492916→d4a4848→125bf07→43e7844→9de96e8→c5456f8→9b7c122→871587c）；F12/F13 = 真產品 bug 修 + 回歸鎖；**run7 全綠**（relay leg-2） |
| P6 run1：viewer GET apps 瞬時 502 + n1–n5 adb serial 脫落（logcat 表面假清） | RBAC 1 假紅 + logLeak 5 表面 vacuous-clean | 502 = adb transient（retry ×3 全 200）；n serial 重新 `adb connect`（W1 finding #2 同款：platform 無 reconnect 路徑，harness 自連）+ **vacuous-clean guard**（logcat <500B = degraded 唔計 pass）→ run2 全綠（relay leg-2） |
| P6 teardown run1：data root 殘留 22 dataDir（EBUSY race + root-owned 子目錄） | 零殘留未達 | `wipe_data_root()` 防線化（retry + disposable alpine + loud FATAL）+ 實地 wipe 完成 + RE-VERIFICATION 全綠（relay leg-2） |

## 5. Teardown 零殘留（P6 完成 — 2026-10-27 05:28-05:31 HKT）

`teardown.sh` 執行 + RE-VERIFICATION（`final/teardown-verify.txt`）：
- rdev containers = **0**；network br-rdev-ladder absent
- 端口 16490-16495 + 16460-16469 = **全 closed**（無 LISTEN）
- data root `/var/lib/water-army/redroid-rdev` = **absent**；`apk-rdev` = absent；`/tmp/rdev-state` = absent
- adb 165xx sessions = **0**
- 用戶 stack **5/5 healthy 零動**；SGLang 30000 = **200**；RAM 釋放至 **44G**

**Teardown 實錚發現（2 項，已防線化）**：
- **data-root wipe 雙陷阱**（run1 殘留 22 device dataDir × 30M）：(a) docker 刪容器後 bind unmount 係異步 — 4s 內 wipe = EBUSY；(b) device dataDir 入面有 **root-owned 子目錄**（docker 喺 bind source 內建）— 普通用戶 `find -delete` = Permission denied（舊代碼 2>/dev/null 靜默吞）。修：`wipe_data_root()` = 3× retry（3s 間隔）→ disposable privileged alpine 容器（docker root、無 sudo 需要）→ rmdir（容器退出後先做得，佢自己個 bind mount 占住 path）→ 殘留即 FATAL loud（唔再靜默）。commit 本 phase。
- **step 7 xargs 調 shell function 失敗**（`xargs: log: No such file or directory`）：disconnect 計數 log 行未落（純 cosmetic，disconnect 本身成功、VERIFY adb=0 實證）→ 改直接變量 + log。
