# EXP-2 — MTG checkin 鑑別（rdev-c1, redroid:14.0.0-240527-gms-mtg）— 2026-10-27

CEO 批准 scratch 口徑執行；RAM gate boot 前實測 PASS（見 ramgate.log，MemAvailable 12069MiB、規劃後 9509MiB ≥ 6144 floor）。
鏡像 digest 02ab5675ba15 ✓；port 127.0.0.1:16512；datadir /tmp/rdev-single-state/c1-data；零 override。

## 四類判定（誠實）

### 1) 成功事實
- GMS 22.21.16 + vending 30.4.17 + gsf 全裝正常运行（attest-logcat.txt `probe:gms`）。
- checkin task 確實被觸發兩次（reason 1 @12:53:46、reason 5 @12:58:39，`AndroidCheckinProtoModule` INFO 級可見）。
- 強制 CHECKIN_NOW（verbose tag）成功抓到 POST 層失敗 + 真實 endpoint（p3-forced-checkin-failure.txt）。

### 2) 失敗事實（根因鏈）
- **GMS 22.21.16 checkin URL = `https://android.googleapis.com/checkin`**；失敗 = `SocketTimeoutException` connect 30s（p3）。POST 從未送達伺服器。
- egress 可達矩陣（host direct = 容器同出口，reachability-matrix.txt）：`android.googleapis.com` / `android.clients.google.com` / `play.googleapis.com` / `clients3.google.com` / `mtalk.google.com`（172.217/142.250/173.194/74.125 段）**全部 tcp443 timeout/unreachable**；只有 `checkin.gstatic.com`（58.254.x HK edge）OPEN。
- 舊 host 名 `android-checkin.google.com` / `.l.google.com` = **全球 NXDOMAIN**（Google 自己的 DoH 权威 Status:3，raw-checkin-post-probe.txt + 本單 log）— 名已死，與我哋 resolver 無關。
- 後果鏈：POST 唔達 → GSF `googlesettings.db` **android_id 表從未建立**（p1/p2/p3 DB 證據；digest=SHA1(空)=`1-da39a…09`）→ Finsky `Unable to fetch checkin consistency token: empty token` → Phenotype 同步失敗（29504 ×4→×14，keyword-matrix.txt）。
- `pm clear com.google.android.gms` 重 checkin（p2）**不改變任何結論**（同一 connect timeout）；framework `settings secure android_id`=c8a1062761000946 係 Android framework 自生 ID，**唔係** GMS/GSF checkin android_id（兩者唔同源，勿混淆）。

### 3) INCONCLUSIVE（待條件）
- **伺服器鑑別判定（403 拒 vs 200 派 android_id）未驗證** — 因為 TCP 都連唔切，白名單（google.com/android/uncertified）槍未開之因 = **egress 網絡可達性，唔係認證層**。raw POST 探針到可達嘅 `checkin.gstatic.com/checkin` 得 400（我嘅 hand-crafted proto 過唔到 validation，非 401/403 — 無鑑別訊號可言）。
- 解套槓桿（俾老細拍板）：俾容器一個出口 proxy（`settings put global http_proxy <bridge-ip>:<port>` + clash allow-lan）令 GMS 行得通 172.217 段 → checkin 先會真正到達伺服器，届时再二元判定。

### 4) Integrity 訊號（attest-app 順手採，同鏡像）
- `atom.attest.BIND` / `safetynet.BIND` / `zinzi.BIND` = **NO_RESOLVER**（bind 矩陣）。
- legacy `IntegrityApi` class = absent；`StandardIntegrityManager.prepareIntegrityToken` present 但回 **-9（Binding to the service in the Play Store has failed）** — 新版 Integrity 靠 **vending bind**，MTG vending 2022 太舊。
- legacy SafetyNet.attest：manifest 修復後 handshake 成立（status=10 消失）但 45s 內唔 completing（`unknown/incomplete`）— 同 egress 根因自洽（attest 都要埋得落 Google）。
- 結論：**MTG GMS 22.21.16 喺 A14 x86_64 redroid 上 Integrity 全徑不可用**（binder 無 + vending 太舊 + 網絡唔達三重）；INCONCLUSIVE 部分全部標明待網絡解套。

## 檔案地圖
p1-firstboot-* = 首次開機基線；p2-afterclear-* = pm clear 後；p3-* = verbose 強制 checkin + 最終 DB；attest-* = wa-attest.apk（sha256 8f94c32…）採集；raw-checkin-post-probe.txt + reachability-matrix.txt = 出口探針；keyword-matrix.txt = logcat 關鍵字計數。secrets：本目錄無 token 明文（mask 於 exp2-checkin.sh 寫入前執行）。

## 【修訂 2026-10-27 晚 — EXP-2b】
本 verdict「認證面 INCONCLUSIVE 待出口」嘅深層根因已鑑定：**出口層 = 國內上游網絡需經代理**（非容器 bug、非認證面）。
出口經 gost→mihomo 修復後 checkin **SUCCESS、android_id=3916878313160989068（非零）到手**，白名單可直接註冊。
詳見 `logs/l3c-arm/exp2b/README.md`。另外 MTG 變體注意：android_id 判據 = gms `files/checkin_id_token`，
唔係本單一直盯嘅 gsf `googlesettings.db` stub 表。
