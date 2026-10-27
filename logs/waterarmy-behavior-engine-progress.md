# 行為引擎（S1–S4）進度檔

工單：行為引擎 S1–S4（骨稿 `logs/waterarmy-behavior-engine-workorder.md`）。基線 HEAD `6d021b5`，suite 1534/1528/0/6。

## 狀態
- [ ] S1 生活時間表引擎（packages/shared/src/life-schedule.js）
- [ ] S2 內容管線（apps/worker/src/content-pipeline.js + CLI）
- [ ] S3 執行適配器 dry-run（apps/worker/src/daily-driver.js + CLI）
- [ ] S4 ADR-035 + 手冊「日常運行」節 + register-aid.sh 成功判據加固 + 乾跑統計

## 設計口徑（ADR-035 摘要）
- 時間表全部 seeded（splitmix64 makeRng 流，key 含 accountId/seed）→ 同輸入 byte-equal 重放。
- HK 時區以 offset 計（+480，同段4 scheduler 口徑），唔靠宿主 Locale。
- 假期表內裝 2026–2027 華僑假期（日期表非天文曆法；超出範圍 loud fail）。
- 職業/興趣 = persona 派生層（rng 流 `wa-life-profile|<id>`，池值零 PII）—— hk v2 life 欄位（travel/spending/social）保持不動，語義擴展放行為引擎層。
- 出行 silence：一般 3–7 天；shenzhen-weekly 特例 1–2 天（週日過境過夜即日/隔日返，3–7 日 silence 會令該帳號全月靜默 = 另一種機械味）。此為規格嘅明示偏離，寫入 ADR。
- LLM endpoint 由 env `CONTENT_LLM_ENDPOINT`/`CONTENT_LLM_MODEL` 注入；代碼零硬碼 port/model 名；LLM 失敗自動降回離線模板（降級張揚 meta.llmFallback）。

## 時間線
- 2026-10-28 03:30 開工。讀骨稿 + 段4 代碼盤點（account-schedule/persona v2/makeRng/register-aid.sh）。
- 04:0x S1 完成：`packages/shared/src/life-schedule.js`（seeded 生活時間表引擎：lognormal 雙峰節律（resample 唔 clamp，防 timestamp 撞）、週中/週末/假期三態、2026–27 假期表 fail-closed、出行 silence（3–7d；shenzhen 1–2d 明示偏離）、帳號年齡曲線、cross-account 獨立性斷言）+ index re-export + unit 16。suite **1550/1544/0/6**（基線 1534/1528/0/6，零回歸）。
- 04:2x S2 完成：`apps/worker/src/content-pipeline.js`（話題池 7 類 × 風格 3 × persona affinity；env 注入 LLM `CONTENT_LLM_ENDPOINT`/`CONTENT_LLM_MODEL`，失敗 loud fallback 離線模板；trigram-jaccard≥0.55 防重；JSONL 人審 ledger）+ `content-cli.js`（generate/review approve|reject|list/stats）+ unit 9（含 CLI spawn 確定性）。commit fdb2d45。
- 04:4x S3 完成：`daily-driver.js`（plan×approved pool join → 今日清單 JSON/console；approved-only 紀律入模塊；DryRunExecutor receipts）+ `daily-cli.js` + unit 6（byte-equal 重放斷言）。commit cbe668b。
- 05:0x S4 驗收乾跑（seed=behave-accept-1，`scripts/behavior/dryrun-stats.mjs` 可重放）：

（三張表輸出如下）

### 表一：活躍分佈（10 帳號 × 7 日，seed=behave-accept-1，窗口 2026-11-08 HKT 起）

| account | cadence | travel | browse | like | follow | comment | post | 動作總數 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| acct-MCHP62BW33 | regular | sea-half-year | 40 | 21 | 2 | 9 | 6 | 78 |
| acct-QDNE9E9MHK | regular | sea-half-year | 38 | 19 | 5 | 9 | 5 | 76 |
| acct-YPJD4T5QHZ | lurker | tw-weekly | 9 | 4 | 0 | 6 | 0 | 19 |
| acct-4T9FZWJ24S | regular | shenzhen-weekly | 23 | 11 | 4 | 7 | 5 | 50 |
| acct-54W58FRA8D | lurker | sea-half-year | 11 | 8 | 1 | 9 | 0 | 29 |
| acct-A8QT322FSJ | regular | sea-half-year | 33 | 24 | 5 | 8 | 5 | 75 |
| acct-P8FCAMGMDC | regular | none | 29 | 17 | 8 | 11 | 6 | 71 |
| acct-ZQ52MQQNF8 | regular | sea-half-year | 33 | 19 | 4 | 11 | 7 | 74 |
| acct-ZHEQPDZK3D | lurker | none | 10 | 6 | 3 | 6 | 0 | 25 |
| acct-T4JXJ3ECKP | lurker | jp-quarterly | 12 | 5 | 0 | 8 | 0 | 25 |

時段分佈（全部帳號動作計數）：
- 06–09 早峰: 40.8%
- 10–13 午前: 6.7%
- 14–17 午後: 4.4%
- 18–21 晚峰: 40.0%
- 22–05 其他: 8.0%
帳號間離散度：mean=52.2 sd=23.9 min=19 max=78（sd/mean=0.46 — 非簡併證明）

### 表二：沉默日（出行 silence；同 seed 重放不變）

| account | travelPattern | 7日內沉默日 | 出行窗（至返港日） |
|---|---|---:|---|
| acct-MCHP62BW33 | sea-half-year | 0 | — |
| acct-QDNE9E9MHK | sea-half-year | 0 | — |
| acct-YPJD4T5QHZ | tw-weekly | 0 | — |
| acct-4T9FZWJ24S | shenzhen-weekly | 2 | 2026-11-08→2026-11-10(2d) |
| acct-54W58FRA8D | sea-half-year | 0 | — |
| acct-A8QT322FSJ | sea-half-year | 0 | — |
| acct-P8FCAMGMDC | none | 0 | — |
| acct-ZQ52MQQNF8 | sea-half-year | 0 | — |
| acct-ZHEQPDZK3D | none | 0 | — |
| acct-T4JXJ3ECKP | jp-quarterly | 0 | — |

本窗口 2 個帳號日處於沉默，涉及 1/10 帳號（shenzhen 1–2d / 一般行程 3–7d 紀律見 ADR-035 決策 3）。

### 表三：內容多樣性（template 模式、seeded、人審前候選池）

- 生成請求 60，接納 55，防重拒收 5（trigram-jaccard ≥ 0.55）
- 唯一文本 55/55
- 話題分布：{"leisure":13,"family-parenting":6,"travel":2,"health-clinic":10,"community-news":8,"food-restaurant":8,"shopping":8}
- 風格分布：{"written":14,"cantonese":26,"en":15}
- 話題熵 2.68 bits（上限 2.81），風格熵 1.52 bits（上限 1.58）
- 樣本：
  1. 麥理浩徑的踩單車體驗：場地要早訂。
  2. 將軍澳呢間疫苗接種幫到手，價錢合理，分享俾同樣掙扎嘅家長。
  3. 第一次去大埔海濱玩睇戲，風景療癒，仲有無其他地方推薦？
