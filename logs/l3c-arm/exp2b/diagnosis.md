# EXP-2b — 出口鑑別結論（2026-10-27，rdev-e1 gms-mtg）

> **修訂判語（boss 21:51 確認 + 本單實測）**：出口層根因 = **國內網絡去 Google 必須經代理，非容器 NAT bug**。
> 「出唔到 Google」係網絡現實（上游對 Google DC 段 ICMP/TCP 全黑洞），EXP-2「egress timeout」即此現象在容器內的表現。
> **生產含義：W3 出口代理綁定由『設計選項』升級為『硬性必須』** —— redroid 出產機無代理 = GMS checkin/register 永遠唔會完成。

## 代理口徑（本宿主發現）

| 項 | 值 |
|---|---|
| 用戶代理 | **mihomo（Clash Verge），HTTP CONNECT，`127.0.0.1:7897`**，僅綁 loopback |
| 宿主環境變量 | `https_proxy=http://127.0.0.1:7897/`（呢個先係早前「宿主直連 checkin=400」嘅真兇——經代理，唔係直連） |
| 容器可用閘道 | mihomo 唔聽 bridge 介面 → 以 **gost sidecar** 做最小中轉（老板指示嘅 socat/DNAT 同位方案）：綁 `172.38.223.1:18443`，chain → `127.0.0.1:7897` |
| 機內姿势 | `adb shell settings put global http_proxy 172.38.223.1:18443`（Android 全局代理，GMS/vending 食呢個；reboot/pm clear 後保留） |
| 用戶棧改動 | **零**（mihomo 配置未郁，我哋只多咗一個 localhost client；中轉只綁 scratch 自建 bridge 閘道） |

## 判定：**出口層 = 宿主上游網絡對 Google 數據中心 IP 段黑洞**（非容器 NAT/FORWARD/MTU、非 Google 認證層）

EXP-2「egress timeout ⇒ 認證面待驗」的深層根因修訂：容器網絡本身正常，
是**宿主所在线上網絡直接黑洞 Google DC 段**（ICMP + tcp80 + tcp443 全丟），
宿主唯二出口路徑 = 用戶 loopback 代理 mihomo `127.0.0.1:7897`（Clash Verge，僅綁 loopback）。
早前「宿主直連 checkin=400 通」實為 **env `https_proxy=127.0.0.1:7897` 經代理**的 400，非直連——直連 timeout 屬誤記。

## 證據矩陣（全部機內/宿主實測，ondevice-diag*.txt / host-net-snapshot.txt）

| 探針 | 結果 | 判定 |
|---|---|---|
| 宿主直連 tcp443 → android.googleapis.com / 142.250.99.100 | 8s timeout | 上游段黑洞（宿主都斷） |
| 宿主經 127.0.0.1:7897 → checkin | **400 (0.89s)** | 「直連 400」實為經代理 |
| 宿主經 gost chain (172.38.223.1:18443→7897) → checkin | **400 (0.25s)** | 修復路徑通 |
| 機內 ICMP → 8.8.8.8 / 1.1.1.1 / 58.254 邊 | OPEN (208–294ms) | 容器 NAT/轉發正常 |
| 機內 DF ping → 8.8.8.8，500/1000/1300/1400/1450B | 全過 | **MTU 假設否**（1472 一輪 loss 係 flake，host 直連 1472 同過） |
| 機內 tcp → 142.250.99.100 :80 / :443 | 兩者 timeout (rc=124) | 段級黑洞（80 同 443 同死 = 非 port 規則、非 GFW port 行為） |
| 機內 ICMP → 142.250.99.100 | 無回應 | **IP 層段黑洞** |
| 機內 tcp443 → 58.254.137.226 (gstatic HK 邊) | **OPEN** | 非 Google-DC 段正常 = 段級過濾 |

層定位：**L3（IP 段路由黑洞）**，容器 L2/L3 NAT、連通、MTU、DNS 全部正常。

## 修復（B — 已落地、可重現）

1. `scripts/rdev-single/egress-proxy.sh` — gost sidecar：綁 **只** 172.38.223.1:18443（scratch bridge GW），
   chain → 127.0.0.1:7897；用戶 mihomo 配置零改動（我哋只係多一個 localhost client）。
2. `boot.sh` 加 `EGRESS_PROXY=1` 選項自動拉起；teardown 隨 rdev-* label 清除。
3. 機內 `settings put global http_proxy 172.38.223.1:18443`（GMS 尊重 global proxy，CONNECT 隧道 TLS 端到端）。
4. 驗證（proxy-retest.txt）：機內 CONNECT android.googleapis.com:443 → `200 Connection established`；
   機內 POST http://android.googleapis.com/checkin（absolute-form 經代理）→ Google ESF `400 Bad Request`
   = **任何 HTTP code 皆代表出到機**，出口層修復成立。

## 對 EXP-2 判語的修訂

- 「POST 從未送達伺服器」根因 = 上游段黑洞，非 GMS/認證問題；**認證面（403 vs 200）仍未判定**，
  由 EXP-2b checkin 重戰（出口已通）給出最終答案。
