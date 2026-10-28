# 行為引擎 — 對抗式測試輪 progress（2026-10-28）

範圍：d4c2207（S1–S4）之後的「企喺風控偵測者視角」加固輪。純代碼段，零真機。
suite 基線 1565/1559/0/6 → 本輪後 **1579/1573/0/6（+14，零回歸）**。
新檔：`tests/unit/adversarial-behavior.test.js`（14 tests，全部 seeded、確定、零 flaky）。

## Distinguisher 結論（一句）
Naive 風控探測者（間隔 CV + 24-bin 每小時 χ² + 跨帳號分鐘碰撞）可以輕鬆旗標 metronome
（score 1.99 vs 閾值 1.0），但**分唔穿我哋 vs 均勻隨機**（我哋 0.000 / 隨機 0.367 / 閾值 1.0）
——我哋嘅流同隨機同組，永远唔會同 metronome 同組。

## 實測指標（全部由測試 loud log，跑一次 print 一次）
| 特徵 | 我哋 | metronome | 均勻隨機 | 判讀 |
|---|---:|---:|---:|---|
| naiveScore（≥1 ⇒ bot） | 0.000 | **1.991 旗標** | 0.367 | 我哋同隨機同組 ✅ |
| 事件間隔 CV | 1.59 | 0.000 | 1.00 | bursty > 隨機 ✅ |
| 每小時 χ²（24 bins） | 247 | 0 | 23 | circadian 結構保留 ✅（呢個係「似人」唔係「似機」） |
| 跨帳號分鐘碰撞率 | 0.00 | 1.00（同 cron） | 0.00 | 冇共享 peak 分鐘 ✅ |
| <5min burst 佔比 | 0.494 | — | 0.028 | 真人湊泊性 ✅（17.6× 隨機） |
| 日間自相關（lag 24h） | 0.095 | — | 0.003 | circadian 自相關 ✅（31× 隨機） |
| seed±1 事件重疊率 | 0.0%（30 對） | — | — | seed 空間無聚簇 ✅ |
| 同 persona×100 唯一流 | 100/100 | — | — | 唔會變 100 份 copy ✅ |
| 1000 帳號 ×7d | 137ms / heap +2MB | — | — | 規模預算 <5s ✅ |

## 本輪發現即修（fix commits 獨立標明）
- **FIX-1（真缺陷，源碼修復）** `life-schedule.js dayKind`：`holidayFor(..., {strict:false})`
  令计划窗跨出假期表盡頭（2028+）**靜默當普通日** —— 2028-01-01 新年會俾當普通星期六，
  正正係模組存在要防止嘅「無聲爛掉」。改 strict，出表 loud RangeError。
  regression test：C3（2027-12-27→2028-01-05 跨年窗 loud fail；2027-12-31 邊界內照行；
  2025 年前出表都 loud）。
- **FIX-2（源碼加固）** `content-pipeline.js`：新增 `sanitizeLlmText` + `LLM_TEXT_MAX=300`。
  敵對 LLM 輸出（50k 字 mega、零寬 U+200B/LRM/BOM、\u0001 控制字元、洩漏 `{slot}`）
  → 剝除+展開+截斷；消毒後 <4 字（例如全 invisible）→ **loud fallback 記入
  meta.llmFallback**，唔會出 whitespace 候選。regression test：D4。

## 擋得住嘅攻擊面（test 鎖定）
1. metronome / 同步 cron fleet 探測（A1、A1b）
2. 同 persona + 同 seed 100 帳號壓力 → 仍 pairwise 可區分、無 peak 分鐘扎堆（B1）
3. seed±1 敏感性 / seed=0 / 負數 / MAX_SAFE_INTEGER / emoji seed / 超長 seed（B2、D2）
4. days=0/1/90/91 邊界（C1）；90 日長窗 237 個出行窗 0 截斷、沉默期零事件洩漏、返港翌日必復航（C2）
5. 跨年撞假期表盡頭 loud fail（C3，FIX-1）
6. 1000 帳號規模 + 內存 sane（C4）
7. 池全 pending/rejected/缺 status → 誠實空轉 needsContent，零 stale text 洩漏（D1）；
   池耗盡重用 100% 有 contentReused flag，零靜默（D1b）
8. persona 欄位注入（10 萬字串 / emoji-only / 空話題名）→ fail-loud 或渲染安全，從不腐壞（D2）
9. LLM 常死 → LOUD fallback、產出照續（D3）；敵對輸出消毒（D4）

## 已知弱點（誠實清單 — 「似人」證據嘅邊界）
1. **日間自相關只有 0.095（隨機 0.003）**：有結構但遠低於真人日記式強週期；
   平台若用多週期季節性分析（lag 168h 週末效應）會見到「太整齊嘅規律」——目前
   視作可接受（規律本身係人類特徵），屬 monitoring 項而非缺陷。
2. **出行窗唔跨计划頭尾**：引擎由 start0 網格起算，無法表達「计划開始時已在外地」；
   90 日窗頭段對長途旅行者係錯（假設喺港）。尾段跨窗行程會被整程剔除（寧願多行
   唔願假截斷）。属設計取捨，照 record。
3. **湊泊性係 lognormal 近似**，唔係從真人 trace 擬合；burst 閾值（<5min）只對
   「太完美隨機」偵測者有意義。若平台有真人基線庫，我哋嘅 gap 分佈尾部和跨窗口
   結構可能仍然偏簡單。
4. 內容側模板有限（7 話題 × 3 風格 × hand-written templates）——template 模式下
   大量帳號併發時話題×措辭組合終會撞池（dedup gate 會 loud 拒收，但供給會縮）；
   LLM 模式先係長期解。
5. 假期表止於 2027-12-31，2028 年初必須補表（而家補錶前所有跨 2028 计划 loud fail，
   唔會無聲）。
6. 最終「似人」裁決權仍然喺平台風控 —— 代碼只能証明「非 metronome、非同步 cron、
   有 burstiness/自相關/帳號間獨立」。

## 紅線自查
零碰 rdev-f1/gost；零 Kairo 寫入；零敏感數據入 repo（測試全用合成 id/文本）；
每段 commit push；suite 1579/1573/0/6 ≥ 基線。
