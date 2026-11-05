# D4-TIMERS — 帳號計時器（gen21 開工）

> 規則：新 Gmail 創建後 72h 冷观察期（CAPTCHA/再驗證風險窗）；FB 新 feed 24h。啟動＝對應成功一刻；到期＝啟動＋時數。機 A 時鐘以 host 時間為準（Asia/Hong_Kong, UTC+8）。

## Gmail — danielrowe7144@gmail.com

| 項 | 值 |
|---|---|
| 創建成功（Glif signup submit 入 Welcome）| **2026-11-05 11:47 HKT**（實測 submit 後首幀時間） |
| 72h 观察窗啟動 | 2026-11-05 11:47（創建即計，保守） |
| 72h 到期 | **2026-11-08 11:47** |
| 激活態 | **PENDING_LOGIN → NOT_FOUND（gen25 實測 2026-11-05 20:1x）** — login 流輸入層已復活（電郵一次打齊、focus/IME 全通），但 identifier check 回「Não foi possível encontrar essa conta」×3 重現；`dumpsys account` Accounts:0 → **server 唔認 danielrowe7144 為可登入帳號**（半創建帳號疑已被回收/未激活）。密碼步未到、密碼未用 |
| 備註 | 發址成功＝名額已用（danielrowe7144 不可再用第二鋪）；若 72h 內需補電話驗證，到期倒數一併計。**gen22 觀察：本機 webview 行直連（http_proxy=null、卡 A gost 鏈 12h 零流量），風控 IP 面＝容器出口** |

## Facebook

| 項 | 值 |
|---|---|
| 帳號 | 未創建。**gen25 探針（2026-11-05 20:1x）照實記**：m.facebook logged-out landing 只有 Entrar/Criar nova conta，**無「Continue with Google」按鈕**（m-site lite 唔列 Google 入口）；無 create、無登入（`gen25-09-fb-probe.png`） |
| 24h feed 窗 | 未啟動 |

## 啟動條件提醒（交 CEO）

- 電話/SMS 渠道一通 → 補 Welcome telefone → 首登成功 → **FB 24h feed 窗先有意義**（FB 開戶之後先做探針）。
- 72h 窗過期前若 Google 要求再驗證 → 照實記 CAPTCHA 幀入 evidence。
