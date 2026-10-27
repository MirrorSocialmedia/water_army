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
