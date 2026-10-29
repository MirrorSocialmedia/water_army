# WA-BATCH-E2E-RERUN — 全批次真機複跑 + P3 收口（final report）

- **單**：mvsxqru6w09im（gen1）｜老細 10-29 10:30 拍板
- **日期**：2026-10-29（UTC 03:22–04:25 / HKT 11:22–12:25）
- **repo**：`/home/kenneth/.openclaw/workspace/water_army`，基線 HEAD `d276328`（全套 1658/1652/0/6）
- **依據**：`docs/audits/rdfa-fix-report.md` §5（F-RDFA-1/2/3 已修 @92f3757）；release-status 行「批次 × 真機端到端一條龍」NOT VERIFIED → 本單升級口
- **Verdict**：**PASS（全綠）** → `docs/release-status.md` 行升 **PASS(real-device)**

---

## 0. 目標達成總覽

| 工單 AC | 結果 | 證據 |
|---|---|---|
| P2 全鏈真跑：3 機 create→probe→run→complete + 介入 + 導出，全部真機真實輸出 | ✅ | §2（3 cycle × 3 機 = 9/9 SUCCEEDED；介入 r8 全循環；JSON+CSV 導出 ×3 cycle） |
| 批次機指紋 12/12（新 tag 生效，同 P1/OEMPROP 同口徑） | ✅ | §2.3（4 個 run 窗口真 getprop 12/12 + baseline 13/13 唔變） |
| P3 零殘留（teardown 經 API）+ final report + release-status 口徑更新 | ✅ | §3（purge ×9 全經產品 API + data root 零殘留 + lease 歸零 + 禁碰集零觸碰 + 還原三項零殘留） |
| 全套零回歸 + sensitive scan 0 | ✅ | §5（1658/1652/0/6 同基線；scan 0 真實 secret） |
| 每段 commit+push+標 Kairo | ✅ | P0 `2667f75`、P2 `677afed`、P3/S5 本 commit；Kairo 4 subtasks 逐段標 done |

---

## 1. P0 — sanity 快查（commit `2667f75`）

15 項全綠，落檔 `docs/audits/batch-e2e-rerun/p0/`：
- git HEAD=d276328 clean；api/worker/web/redis/postgres 5/5 healthy
- 新 tag `water-army/redroid:14.0.0-240527-gms-mtg-oemprop` 喺 `batch.container_image_allowlist`（2 entries，無 cmd = 預設狀態）
- F-RDFA-2/3 代碼已部署運行中 api 容器（adb-cnxn-probe.js = bridge-IP L2 target + self-attach 修復）+ worker（360s lifecycle window）
- 標準 template `mc-dogfood-gmsmtg` = 新 tag（CEO 10-29 10:30 執行，DB `redroid_templates` 驗證）
- RAM gate enabled 4G/5400 現狀；baseline liveLeases=1 {redroid-mc-dogfood-2}
- 禁碰集 {rdev-f1, redroid-mc-dogfood-2, rdev-e1-gost} 3 容器 running，ID 落檔

## 2. P2 — 批次 × 真機 e2e（commit `677afed`）

### 2.1 口徑
- 新 tag × 3 機/cycle × **3 個 cycle**（9 identities `redroid-rdfa-r1..r9`，qa_device）
- 指紋注入 = allowlist `cmd`（5 geometry 1080x2400/420/30/host = P1 標準 template 口徑 + 12 P1 carrier args；image ENTRYPOINT 之後 append；全 9 機同一 P1 profile — workorder「same P1 profile」口徑，同 serial MOTO-616277-P6V8 喺本驗證批次屬預期）
- hold = `CONTAINER_ADAPTER_HOLD_MS=180000`（.env + compose 加行，P3 已還原）令真 ADB getprop 捕獲落喺 run 窗口內
- mock provider：worker env `AI_MOCK_SCRIPT=default`（P0 驗證）— 批次 run 無真 LLM；真機證據全真
- cycle 2 起用新身份：FSM `COMPLETED` = closed-leaf（MD §6.1 無 re-arm edge）→ 產品口徑下已完成嘅 identity 唔會再跑，cycle 3 用 r7/r8/r9（`p2-01b` 記錄）
- cycle 3 `maxAttempts=3`：a1 被 F-1 transient 消耗 + r8 intervention stop 消耗 a2 + a3 resume 成功（v8/v9 用 2 係因為佢哋嘅 stop 就係 a1）

### 2.2 結果：9/9 SUCCEEDED

| cycle | batch | 機 | 結果 | duration |
|---|---|---|---|---|
| 1 | bb2a049b… | r1/r2/r3 | 3/3 succeeded (a2) | ~192s/機 |
| 2 | 055bea17… | r4/r5/r6 | 3/3 succeeded (a2) | ~192s/機 |
| 3 | 2f574ec4… | r7/r8/r9 | 3/3 succeeded（r8=a3） | ~192s/機 |

全部 `container ok (held 180000ms, 11 health checks)`；CNXN probe（bridge IP 真 adbd 握手）= v8 之 F-RDFA-2 假死/假綠形狀**零再現**。
cycle 1 時間線三方交叉（worker log + audit_events + dockerd journal）= `p2-11-cycle1-analysis.md`。

### 2.3 真機 getprop（host ADB = 產品 probe 同 channel）

| 檔 | 窗口 | 12/12 | baseline 13 |
|---|---|---|---|
| `p2-12-gt-r7-a2.txt` | r7 a2（03:52:58） | **12/12** | 13/13 唔變 |
| `p2-12-gt-r8-a2.txt` | r8 a2（03:52:58，intervention 前） | **12/12** | 13/13 唔變 |
| `p2-12-gt-r8-a3.txt` | r8 a3（03:54:37，intervention 後 resume） | **12/12** | 13/13 唔變 |
| `p2-12-gt-r9-a2.txt` | r9 a2（03:53:02） | **12/12** | 13/13 唔變 |

每檔含 RUN id + containerId + host port + DB run window（capture 時 status=running）+ adb connect + 完整 getprop 雙 channel dump（-props-adb / -props-exec）+ 12 項 P1 profile 對照 + 13 項非指紋 ro.* 抽樣（同 P1 p1-09 / OEMPROP S3 口徑）。

### 2.4 手動介入（r8，v9 口徑全循環，`p2-13/13b/13c` + UI 截圖 ×3）

```
03:53:41  POST /api/manual-interventions（operator_report/DEVICE_OFFLINE/high/blocked_pending_review）→ 201
          badge 0→1（needs-attention-count + UI「Needs Attention 1」p2-10-…-1-badge.png）
03:54:02  POST /:id/acknowledge → 200；badge 1→0（ack 清 attention）
03:54:02  REAL STUCK EVENT：docker stop -t 2（exit 137）
03:54:14  engine 自動 retry：r8 queued a3（backoff ~10s）
03:54:24  a3 running（adopt 同容器 restart）→ getprop 再捕獲 12/12
03:57:34  r8 succeeded（a3）
03:57:35  POST /:id/resolve（summary）→ 200 resolved；badge 0
```
UI 證據：badge=1 截圖、詳情面板（Acknowledged + evidence JSON + 解決入口）、resolved 後清單。

### 2.5 導出 + zero-secret scan（`p2-14-report-cycle{1,2,3}.{json,csv}`、`p2-15-export-scan.txt`）

- `GET /api/batch-reports/:cycleId?format=json|csv`（operator）× 3 cycle 全 200
- JSON = `water-army/batch-cycle-report/v1`（cycle3：successRate=1、retries=3、peakActiveContainers=3）；CSV = 16 欄 header + 3 行
- scan 範圍 = exports + getprop dump + intervention/monitor 檔：**16 hits 全部 = `persist.netd.stable_secret`**（Android netd 系統屬性，per-boot 瞬時 token，非 operator 憑證、零 PII、容器已毀）→ **真實 secret = 0**；admin 密碼/token 零入 repo（product builtin e2e bootstrap session，opaque token 6h TTL）

## 3. P3 — 收口（零殘留）

### 3.1 teardown（9 機全經產品 API，零 docker rm）

```
POST /api/identities/:id/purge {dryRun:true}   → 預覽（dataPath 在 root 內/size/containers）
POST /api/identities/:id/purge {confirm:id}    → stop+remove 容器 + rm data dir + audit
```
- 首輪 confirm ×9 全部 500 = **EACCES scandir `<dataPath>/dalvik-cache`**（redroid 容器 in-container root 寫嘅目錄；api uid 1000 刪唔到 — 已知形態）；首輪已先完成容器 stop+remove（產品路徑正確）
- 補丁（host 側，零產品代碼改動）：alpine root 容器 `chown -R 1000:1000` 殘留 → 產品 re-purge ×9 全部 200 `removed:true`（67.3–67.6MB × ~835-867 檔/機）+ `batch_identity.purged` audit ×9（`p2-17/17b/17c`）
- 說明：產品 purge 唔會刪 identity 行（by design：purge = 唯一 data-wipe 路徑，identity 留 COMPLETED；產品無 identity DELETE/disable API）— 9 行 identity 記錄 = 審計資產，非殘留

### 3.2 零殘留驗證（實查）

| 項 | 結果 |
|---|---|
| wa-batch 容器（任何狀態） | **0** |
| data root `redroid-rdfa-*` 目錄 | **0**（root 剩餘 6 個 = 非本單既有） |
| `resource_leases`（port） | **0 rows**（2 條 TTL-expired 行已 sweep，`p3-lease-sweep` 段） |
| `ramgate:live`（redis） | **{redroid-mc-dogfood-2}** = baseline |
| 禁碰集 | rdev-f1 / redroid-mc-dogfood-2 / rdev-e1-gost **全部 running 未受影響** |
| `batch.container_image_allowlist` | **還原 = pre-ticket 原樣**（2 entries 無 cmd；/tmp/allowlist-before.json 對齊） |
| compose.yaml / .env `CONTAINER_ADAPTER_HOLD_MS` | **0 殘留**（行已刪 + worker recreate，env 實測 `<unset>`） |
| audit trail | `batch_identity.purged` ×9 + 全 run 事件齊 |

### 3.3 發現（F-2 產品 bug — port lease phantom）

- **現象**：`resource_leases` 有 1 條活 lease（port:16370，owner=r8 run）喺 stop 後 28 分鐘仍 active；04:24:23Z TTL 自動過期（實錚自愈）
- **根因（代碼層坐實）**：`startForRun`（batch-lifecycle-service.js L585）**每次 start（包括 adopt-restart）都 `acquirePortLease` 新分 pool port**；adopt 分支（`createAndStart` L616 `adopted:true`）重用原容器**唔改 port mapping**（容器繼續 16373），新 lease（16370）冇人用；stop 時 `releasePortLease(runId, 實際 HostPort)`（L961）release 嘅係 16373 → **16370  phantom lease 永不 release，靠 30min TTL 自愈**
- **影響**：bounded（TTL cap）+ self-heal（實錚 04:24:23 過期）+ 無功能影響（phantom 只係阻塞一個唔係任何人用緊嘅 pool port ≤30min；pool=50）；fleet 長時間 retry 密集場景下池容量短暫縮水
- **建議**：獨立 ticket — adopt 路徑 skip fresh acquire（lease 容器實際 HostPort）+ 回歸測試。本單唔改代碼（workorder 紀律：結構性 = 停 + 根因報告；此 discovery 非 blocking 且自愈，照紀律落檔 + 建議）

### 3.4 發現（F-1 結構性 — hold re-probe vs fast-boot ADB transient）

- 3 cycle 全 9 機 attempt 1 同一形狀：adbd t+~1.2s 即應答 CNXN（start ok）→ t+~15s boot 期 ADB 瞬斷 → 15s re-probe 捕到 unhealthy → run failed RETRYABLE → 自動 retry 成功。容器全程存活（dockerd 零 death/OOM 事件，`p2-11` 三方交叉）
- 影響：fast-boot image 批次多耗 1 次 boot；maxAttempts=1 會假紅
- 建議：hold re-probe 加 start-relative grace / N-strikes（同 B6 PROBE_GRACE 同構）— 獨立 ticket
- 本單處理：記錄（產品 retry 路徑本身 = AC 一部分，3/3 最終成功經產品自身 resilience 達成）

## 4. release-status 升級（同 commit）

- §3.2「批次 × 真機端到端一條龍」：**NOT VERIFIED（根因已修、複跑待獨立單）→ PASS(real-device)**（證據 = 本報告 + `docs/audits/batch-e2e-rerun/p2/`）
- §3.3 新 tag 指紋行：註記標準 template `mc-dogfood-gmsmtg` 已切新 tag（10-29 10:30 老細拍板、CEO 執行、200+DB 驗證）+ **批次機 12/12 生效**（本單 4 窗口）
- §4 總覽：批次端到端由「唔喺本列」移入真機 PASS 列
- §5 註記：本單 admin 測試配置（allowlist cmd / HOLD env）= **P3 已全部還原**（零殘留，§3.2）

## 5. S5 — 全套零回歸 + sensitive scan

- `npm test` 全套 @ 本單 HEAD（docs-only 改動，零代碼改動）：**1658 total / 1652 pass / 0 fail / 6 skip** = 基線同數（skip 全 = 環境門控，非跳過失敗）
- provenance：`bash scripts/release-status-provenance.sh --check` = **CHECK OK**（§1 vs 實跑一致）
- sensitive scan：本單 3 個 commit diff + 全部 evidence 檔 grep（password/secret/token/api_key/BEGIN/private key）→ **0 真實 secret**（唯一命中類 = 系統屬性名 `persist.netd.stable_secret`，見 §2.5）

## 6. Evidence 索引（全部 repo 內，clone 後可核）

```
docs/audits/batch-e2e-rerun-report.md      ← 本報告
docs/audits/batch-e2e-rerun/p0/            ← P0 sanity 落檔
docs/audits/batch-e2e-rerun/p2/
  p2-01..02c-*                             ← provision ×3 / batch create ×3
  p2-11-cycle1-analysis.md                 ← cycle 1 時間線 + F-1
  p2-12-gt-r{7,8,9}-a{2,3}*.txt            ← 真 getprop 12/12（+ -props-adb/-props-exec dump）
  p2-03c-monitor-cycle3.txt                ← live monitor 全時間線
  p2-13/13b/13c-*.txt                      ← intervention 全循環
  p2-10-interventions-ui-*.png             ← UI badge 0/1/detail/resolved 截圖
  p2-14-report-cycle{1,2,3}.{json,csv}     ← 產品導出
  p2-15-export-scan.txt                    ← zero-secret scan
  p2-16-summary.md                         ← P2 段總結
  p2-17/17b/17c-*.txt                      ← purge ×9 + chown 補丁 + re-purge
```

## 7. 侷限（honest）

- identity 層 fingerprint（profile 行）與容器層指紋注入（allowlist cmd）= 兩條產品路徑；本單驗證對象 = **容器層真 getprop**（workorder 口徑：真機 12/12）。identity profile 行 = 產品記錄（UI/未來 device-surface），批次路徑唔讀 identity roOverrides — 此產品差異記錄入此（跟進可立 ticket：批次 adapter 由 identity fingerprint 生成 cmd）。
- F-1 / F-2 = 兩個跟進 ticket 級發現（§3.3/§3.4），本單唔改代碼（紀律：結構性 = 停 + 根因報告）。
- 指紋 12/12 喺批次口徑 = **同 serial 多機**（workorder「same P1 profile」）；serial UNIQUE 碰撞喺真 fleet 口徑下係產品 collision 守門範圍（W1b scopedCollisions）— 本單範圍外。
