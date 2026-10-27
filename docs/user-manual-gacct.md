# GAcct 使用手冊 — Google 帳號資產流水線（人機輪流制 Runbook）

> 範圍：persona 生成 → 開機+checkin → AID 註冊 → 帳號創建（人機輪流）→ vault 登記 → 排程入池。
> 適用：water_army redroid fleet（MTG 變體、EGRESS_PROXY 紀律）。
> 權威設計：`docs/architecture-decisions.md` §34（ADR-034）。本手冊係操作口徑；衝突以 ADR 為準。

## 0. 三條鐵律（睇唔入唔好开工）

1. **AID ↔ datadir ↔ 帳號生死綁定**：Android ID 由 datadir 派生；`rm -rf` datadir = AID 死 = 已註冊憑證作廢。換機 = 重新 checkin + 重新註冊。fleet 紀律 = **checkin → register → pool**，順序唔可以調轉。
2. **人肉閘零自動解**：CAPTCHA / 電話驗證 / 風控牆一律停機等人（`blocked_pending_review`），AUTO-SOLVE 係契約違規（ADR-034 §5）。
3. **零敏感資料入 repo**：密碼只喺 vault（`.dev/accounts/registry.json`，0600、AES 密封）；evidence PNG 入 gitignored `logs/`；events/log 零 credential。

環境前置：`APP_ENCRYPTION_KEY`（vault 密封 key，同 provider secrets 同一治理面）；adb = `~/.local/share/platform-tools/adb`；scratch 開機用 `scripts/rdev-single/boot.sh`（RAM gate 6Gi，只准 rdev-g* 命名，禁碰 rdev-f1/rdev-e1-gost）。

## 1. 生成 persona（帳號資產登記證）

```bash
export APP_ENCRYPTION_KEY=***
node apps/api/src/cli/account-gen.js create --role farm --region hk --show
# acct-XXXXXXXXXX  [farm]  d***1@gmail.com  region=hk  Cindy Yu  PREPARING  pw<108.39 bits>  vault:.dev/accounts/registry.json#acct-...
# password: ***   ← 只有 --show 先會印；自己收好
```

- `--role anchor|ops|farm|recovery`（語義表見 ADR-034 決策 1）；`--region` 預設隨機，`hk` = 港人雙重身份（見 §1a）。
- 三位一體綁定（裝置/出口）建號前可 `--fp <id> --eg <id>` 落欄，或明確 deferred（farm 預生成）。
- gmail 前綴反機械味（禁 `wa-`）；entropy 記錄在檔；撞名自動換 id 重試。

### 1a. hk profile（港人升維）

`--region hk` 嘅 persona 係一個原子故事：`余詩琪 ↔ Cindy Yu ↔ cyu192@gmail.com`，粵語拼音（jyutping 文件拼寫 Chan/Wong/Cheung，唔係普通話拼音），性別跟名字池、email prefix 呼應人名、時區 Asia/Hong_Kong，並帶**生活軌跡 metadata**（常離港模式 shenzhen-weekly/jp-quarterly⋯、消費習慣、社媒平台/語言混合/發文頻率）— 全部合成池值、零 PII，俾日後模擬真人生活餵數據。驗證器對 hk 配對 fail-closed（改一個字即 RED）。

## 2. 開機 + checkin（GMS 身份誕生）

```bash
EGRESS_PROXY=1 bash scripts/rdev-single/boot.sh rdev-g1 \
  water-army/redroid:14.0.0-240527-gms-mtg 16515 /tmp/rdev-single-state/g1-data -
ADB=$HOME/.local/share/platform-tools/adb
$ADB connect 127.0.0.1:16515
# 等设备入面（boot_completed=1），再设出口代理（容器橋接 GW → gost → mihomo）：
GW=$($ADB -s 127.0.0.1:16515 shell ip route | awk '{print $3; exit}')
$ADB -s 127.0.0.1:16515 shell settings put global http_proxy ${GW:-172.38.223.1}:18443
```

- **等 boot+~2 分鐘自然 checkin**（MTG reason-1 一次性 boot 排程；shell 強制觸發全部失效 — 見 EXP-2b 記錄，唔好再踩）。
- **Checkin 成功判據（MTG 變體）**：`docker exec rdev-g1 ls /data/data/com.google.android.gms/files/checkin_id_token` 存在 + `shared_prefs/Checkin.xml`（android_id/versionInfo）。⚠️ gsf `googlesettings.db` 喺 MTG **永遠唔會建立** — 盯錯 db = 假紅。
- AID 攞法：`$ADB -s 127.0.0.1:16515 shell settings get secure android_id`。
- 常见牆：表單/頁面 load 唔到 = 出口問題（gost sidecar 有冇起、`settings get global http_proxy` 有冇設、宿主 mihomo 活唔活）。

## 3. AID 註冊（零登入，機械化）

```bash
scripts/rdev-single/register-aid.sh 127.0.0.1:16515
# 證據：logs/aid-reg/<ts>-<serial>/001-wake.png … 099-success.png
```

流程 = wake → VIEW intent 開 `google.com/android/uncertified/`（webview_shell 承接、表單靠 checkin 憑證自動預填 Android ID）→ screencap 輪詢表單渲染（上限 60s）→ tick「I understand」(50,1165@720×1280) → SUBMIT (630,1206) → 成功頁存證。

- 坐標按裝置分辨率自動縮放；`--dry-run` 睇計劃；`AID_TAP_METHOD=micro-swipe` 補救 tap 被 keyboard 食咗。
- **Gotcha（真機實錄）**：① keyboard 食 tap → 微 swipe `input swipe X Y X Y-1 120` 觸發 JS click；② uiautomator dump 永遠讀唔到 MinuteMaid/uncertified WebView（0 bounds/stale）— 只能 screencap 導航，腳本用「渲染幀大小+穩定」偵測，**最終判據係人眼睇 099-success.png**；③ KEYCODE_BACK 一次回溯多步 — 呢條流從唔用佢。
- exit 2 = 表單 load 唔到（先查 egress）；exit 3 = submit 後偵測唔到成功頁（睇 098-no-success.png，可能坐標漂移或風控）。
- 註冊生效 = async（Google 側可以要數小時）。

## 4. 帳號創建 — 人機輪流制

機器行機械步驟，人只出現喺人肉閘。Step table = `packages/shared/src/account-signup-steps.js`（CEO 2026-10-28 人肉跑通流程嘅機械化）：

```
名 → 生日 → 性別 → 自訂名(gmail) → 密碼 → 電話[Skip·微swipe·零SMS紀律]
  → 還原電郵[留空] → 條款[雙剔+確認]  ⟹ CREATED
```

```bash
# 睇計劃（唔掂機）
node apps/api/src/cli/account-gen.js signup acct-XXXXXXXXXX --dry-run
# 真機執行（adb argv 注入、每步 screencap 存證、事件全部過契約 validator）
node apps/api/src/cli/account-gen.js signup acct-XXXXXXXXXX --serial 127.0.0.1:16515
# 撞閘被人手清咗之後，由指定步驟後續行
node apps/api/src/cli/account-gen.js signup acct-XXXXXXXXXX --serial 127.0.0.1:16515 --resume-from fill-password
```

- 證據：`.dev/signup-evidence/<id>-<ts>/NN-<step>.png`；閘手續文件 `handoff-blocked_pending_review.json`（status/step/evidence/reason — 呼應 MC intervention console，本段係寫檔交接）。
- lifecycle 自動寫回 vault：PREPARING→PROVISIONING→（AWAITING_HUMAN⇄）→CREATED；TERMINAL_FAILURE 時操作者 `retire` 或重跑。
- 人嘅職責（輪值表）：CAPTCHA 解完話俾機器知 → `--resume-from <閘步驟>`；風控牆（要電話驗證）= 決定棄號（retire）定改道真機 SMS；意外頁 = 睇 evidence PNG 判讀。
- 坐標係 720×1280 校準 + 按比例縮放 — **首次喺新分辨率機跑之前，逐對照 evidence PNG 核實坐標先准無人值守**（ADR-034 §7 誠實條款）。

## 5. Vault 登記與賬本

`signup` 成功即已完成登記（email 唯一性喺入面強制、密碼 AES-256-GCM 密封、軟退休）。人手命令：

```bash
account-gen list [--role farm]          # masked 摘要 + vault 指針
account-gen show <id> [--show]          # --show 先解密碼
account-gen retire <id> [--note ...]    # 軟退休（DEAD 終態，賬本不撕頁）
account-gen export --out backup.json    # 密文可攜；import 冪等、分歧硬衝突
```

## 6. 排程入池（隨機紀律）

註冊唔可以係_metronome_（風控味）。計劃器 = seeded、可重現、约束明確：

```bash
node apps/api/src/cli/account-gen.js schedule --count 10 --window 24h --seed batch-7
#    --min-gap 15     兩單最小間隔（分鐘）
#    --start <ISO>    窗口起點（預設而家）
#    --allow-night    允許 00:00-07:00（預設避開，HKT）
```

- 輸出 = 每單註冊事件嘅 UTC + HKT 時間戳；同 seed 重放 byte-equal（審計得）。
- 約束滿足唔到時**降級必張揚**（輸出行 `RELAXED: ...`），機器永不靜斦齋違反紀律。
- 日後「某貼留言」類人類動作延遲用 `actionDelay({seed})`（lognormal、seeded、預設中位數 90 秒、clamp 30s–6h）。
- 執行口徑：按 plan 逐個開新機（§2）→ 註冊（§3）→ 創建（§4）。**唔好一次過起 N 機**（RAM gate + 風控）。

## 7. 常見牆處理表

| 症狀 | 判讀 | 處理 |
|---|---|---|
| 表單/登入頁 load 唔到（白屏、screencap 細 PNG） | 出口斷 | 查 gost sidecar（`docker ps` rdev-e1-gost）、機內 `http_proxy`、宿主 mihomo；重跑 register-aid.sh |
| tick/SUBMIT tap 無反應 | keyboard 食 tap（gotcha ①） | `AID_TAP_METHOD=micro-swipe` 重跑 |
| uiautomator dump 空/0 bounds | gotcha ② — WebView 讀唔到，唔係 bug | 一律 screencap 判讀，唔好再 dump |
| 按返後續行錯亂 | gotcha ③ — KEYCODE_BACK 多步回溯 | 用 `--resume-from`，禁 KEYCODE_BACK |
| CAPTCHA 牆 | 人肉閘 | 人手解 → `--resume-from <step>`；手續檔 `handoff-blocked_pending_review.json` 對住做 |
| 要電話驗證（SMS 牆） | 風控加高 | 紀律 = Skip phone；被強制 = 停手報告（棄號 retire 或人機改道），**唔准自動解** |
| signup 步驟重複失敗 | `TERMINAL_FAILURE STEP_RETRY_EXHAUSTED_*` | 睇對應 NN-<step>.png 核實坐標漂移；調 step table 再跑 |
| 註冊後 Play/服務冇即時變 | Google 側 async | 等數小時覆檢；唔好重刪 datadir 重黎（AID 會死） |
| checkin 冇發生 | reason-1 一次性；冇自然復發 | 等下次 cold restart 或登帳號後 gservices 週期；唔好 poke CheckinService（FGS crash 雷區） |

## 8. 收尾（teardown）

```bash
docker rm -f rdev-g1
# datadir 係 root-owned：用 docker mount 清（宿主 rm 會失敗）：
docker run --rm -v /tmp/rdev-single-state/g1-data:/x --entrypoint rm debian:bookworm-slim -rf /x
# egress sidecar 收口（確認 rdev-f1 唔再需要用先做）：
bash scripts/rdev-single/egress-proxy.sh stop
```

帳號本身**唔會隨機死** — 佢哋喺 vault 入面；機係消耗品，賬本係資產。
