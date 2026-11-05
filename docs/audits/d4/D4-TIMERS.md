# D4-TIMERS — 帳號計時器（gen21 開工）

> 規則：新 Gmail 創建後 72h 冷观察期（CAPTCHA/再驗證風險窗）；FB 新 feed 24h。啟動＝對應成功一刻；到期＝啟動＋時數。機 A 時鐘以 host 時間為準（Asia/Hong_Kong, UTC+8）。

## Gmail — danielrowe7144@gmail.com

| 項 | 值 |
|---|---|
| 創建成功（Glif signup submit 入 Welcome）| **2026-11-05 11:47 HKT**（實測 submit 後首幀時間） |
| 72h 观察窗啟動 | 2026-11-05 11:47（創建即計，保守） |
| 72h 到期 | **2026-11-08 11:47** |
| 激活態 | **PENDING_LOGIN（gen22 實測 2026-11-05 16:40）** — Welcome telefone 步已隨 session 超時消失（timeout 408 頁）；重登行到 login 流「Fazer login」幀但輸入打唔入（SPA 半渲染），首登未完成 |
| 備註 | 發址成功＝名額已用（danielrowe7144 不可再用第二鋪）；若 72h 內需補電話驗證，到期倒數一併計。**gen22 觀察：本機 webview 行直連（http_proxy=null、卡 A gost 鏈 12h 零流量），風控 IP 面＝容器出口** |

## Facebook

| 項 | 值 |
|---|---|
| 帳號 | 未創建（FB 探針跳過：無 Google 登入態，「Continue with Google」必死 identify） |
| 24h feed 窗 | 未啟動 |

## 啟動條件提醒（交 CEO）

- 電話/SMS 渠道一通 → 補 Welcome telefone → 首登成功 → **FB 24h feed 窗先有意義**（FB 開戶之後先做探針）。
- 72h 窗過期前若 Google 要求再驗證 → 照實記 CAPTCHA 幀入 evidence。
