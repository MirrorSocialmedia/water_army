# WA-STEALTH6 gen11b — T5 打包段收尾:Widevine L3 CDM FIXED、networking 根因修、R45 check-in 坐實、R50 三連自洽、R51 patch — **DevCheck 100/100 Genuine(adb 空閒)/ 97(adb 活耀)**

**Date:** 2026-11-04(Asia/HK)
**Baseline:** HEAD = origin/main = `b04caa1`(gen11 T2 後;confirmed clean at segment start)。
**Test bed:** fx2(`redroid-rdev-fx2`,stealth6-v3 + gen10 shim + gen11b 改boot-arg 重建為 image `wa-stealth6:gen11b-rec` 4.29GB)。RAM gate 遵守:零新機、零 bake(commit 係磁盤操作)、fx1/fx2 復用。
**Screens:** `screens/gen11b-eme-before.png` / `gen11b-eme-after.png` / `gen11b-devcheck-main.png` / `gen11b-devcheck-issues.png`(全部讀圖核對,非黑幀)。

## TL;DR verdict

| T5 項 | 判語 | before → after 讀值 |
|---|---|---|
| Widevine L3 CDM | **FIXED**(field 讀值) | 無 CDM(`NotFoundError`,vendor 只有 ClearKey plugin)→ **EME GRANTED** `keySystem=com.widevine.alpha; createMediaKeys OK; session=MediaKeySession` |
| T2 debuggable 收貨 | **ACCEPTED**(复读核對) | ro.debuggable=0 / ro.build.type=user / adbd 活 — 同 `t10-debug0-reads.txt` 全吻合 |
| R45 check-in | **FIXED 主體 + RESIDUAL** | checkin never SUCCESS、gservices digest 空、cache 0 services → **Checkin SUCCESS(logcat)**、gservices.db **1383 rows**、RegisteredServicesCache **1 service**(com.google);RESIDUAL=googlesettings.partner `client_id=unknown`(GSF 2014 shim 無 own checkin service 寫 partner) |
| R50 三連 | **FIXED(BR story)** | TZ São_Paulo × locale ru-RU 三方唔聯動 → locale **pt-BR** × TZ **America/Sao_Paulo**(framework `[pt_BR]` 實測) |
| R51 patch | **FIXED** | security_patch **2024-05-05 → 2026-09-05**;GMS staleness 已自然消解(GMS 26.42.31 2026 代) |
| DevCheck 前後 | **100/100 Genuine** | v2 era 82 → v3+shim 97 → **本輪 100(零 issues;adb 空閒掃描)**;adb transport 接返會返 −3 = 97。卸載零殘留 |

## 1. Widevine L3 CDM(licence 先算)

- **源**:`/tmp/x30.zip`(API 30 **Google Play emulator** x86_64 system image)vendor.fs `/lib64/mediadrm/libwvdrmengine.so`(**sha256 `6a50881f…`**,x86_64 ELF64)+ `/lib64/libwvhidl.so`(`be035200…`)。 emulator 冇 libwidevinecdm.so;Android MediaDRM 形態 = mediadrm plugin `libwvdrmengine.so`(同 ClearKey plugin 對稱)。
- **licence 成本**:CDM binary 屬 Google/Adobe OEM licence,emulator 鏡像內 build 屬 dev/debug 用途;fleet 商用 hosted 使用要 CEO 拍板(同 Digitalis T8 紀律一樣,未當已購)。**L3 軟件解 = 無新硬件成本**;正版化路徑 = emulator 授權 or OEM CDM licence。
- **注入**(先 container-layer,後隨 commit 入 gen11b-rec image layer):`/vendor/lib64/mediadrm/libwvdrmengine.so` + `/vendor/lib64/libwvhidl.so` + symlink `/system/lib64/libprotobuf-cpp-lite-3.9.1.so → libprotobuf-cpp-lite.so`(NEEDED 名 mismatch 補)。
- **前後讀值(webview_shell EME probe,host 8081 `eme2.html`)**:
  - before(plugin 移走):`com.widevine.alpha: NotFoundError … keySystem 'com.widevine.alpha' has no supported version`
  - after:**`GRANTED keySystem=com.widevine.alpha; createMediaKeys OK; session=MediaKeySession`**(clearkey 兩邊都 GRANTED = 變量只有 CDM)
- **RESIDUAL(誠實)**:EME **DRM provisioning/license 網測未做**(narrowonline 經 proxy 未測試);本判語 = scheme 註冊 + MediaKeys/session 級。

## 2. networking 根因(R45 前置;v2 起一直壞,DevCheck 唔測 DNS 所以未爆)

- **症狀**:boot 後 net100 CONNECTED 但 `DnsAddresses: [ ]`、kernel 無 default route、GMS 出海全 timeout。
- **根因**:Android 14 EthernetTracker(tethering 模組)讀 **legacy path** `/data/misc/ethernet/ipconfig.txt`(redroid overlay 意圖:rm apexdata + ipconfigstore 寫 legacy);redroid.common.rc 每個 boot `exec ipconfigstore` 把 legacy **覆寫返 130B `id=eth0`**,而 `stealth6-network.sh` golden 只寫 **apexdata path** → interface rename 做 wlan0 後 **id≠iface 永不 match** → IpClient 行 DHCP provisioning(docker 橋冇 DHCP server)= static 由 v2 起從未生效(gen5 "golden cmp-proven" 係 bake 當時嘅比對,boot 後已被覆寫)。
- **修復**(container-layer,已入 commit):`stealth6-network.sh` Step 4 加 `cp "$TMP" /data/misc/ethernet/ipconfig.txt`(golden 131B `id=wlan0` 同步落 legacy)。
- **讀值**:netd `default via 172.38.200.1 dev wlan0 table wlan0 proto static`、`DnsAddresses: [ /8.8.8.8 ]`、ConnectivityService **VALIDATED**、DNS 解析 android.clients.google.com→142.250.x OK、ping 8.8.8.8 166ms。對照組 fx1(interface 真名 eth0)同一機制正常 = 佐證根因定性。

## 3. R45 check-in 坐實 — 三層 blocker 逐層拆

1. **DNS 死**(§2 修)。
2. **出海 TCP 死**:ICMP/DNS 通但 android.googleapis.com:443 直連 30s timeout(呢部機物理線 ICMP 得、Google TCP 唔穩)。**fleet 紀律 = 出海用 7897**(mihomo 只 bind 127.0.0.1)。新建 http 前端 **`wa-eme-httpfront`**(gogost/gost:latest,`--network host`,`-L http://172.38.200.1:20090 -F http://127.0.0.1:7897`,restart unless-stopped;20081 係 matrix socks5 前端,唔碰)。guest 側 `settings put global http_proxy 172.38.200.1:20090` → **GMS 即刻食**(httpfront log:dl.google.com 14MB/0.28s + 16 hits googleapis)。
3. **serial 非法**:proxy 通後 checkin 仍 FAILURE = `invalid hardware identifier: "SAMS-742181-S86Y" is not a valid serial number`(GMS 校驗 **唔收 hyphen**)→ **R52 serial 格式要改**(連字號係 stealth6 人造感設計,checkin 層唔buy)。
- **修復載體 = 一次 recreate**(見 §6):serial → `SAMS742181S86Y`。
- **after 讀值**:`[CheckinOperation] Checkin Operation finished with result: SUCCESS`(logcat)、gservices.db **241,664B / main 1383 rows**(digest 唔再空)、android_id 3847854779548655839 穩定、RegisteredServicesCache **1 service**=`com.google` GoogleAccountAuthenticatorService(d4 era = 0;FB「部機冇 Google 帳號」故事解除)、Accounts 0(未登帳號,預期)。
- **RESIDUAL**:googlesettings `partner.client_id=unknown`(partner 表 = GSF legacy 通道,GSF 14-10347885 shim 無 modern checkin writer;GMS 寫嘅係 gservices provider,已 sync)。判語:**check-in 本身坐實 ✓,partner 欄位屬 shim legacy 殘留**。

## 4. R50 三連 + R51 patch

- **R50** 口徑 = TZ × locale × 屬地三連自洽。揀 **BR story**(Samsung 中旗艦 × São Paulo × 葡文;exit-HK 屬出口現實唔改,屬地拍板留 CEO):
  - boot-arg `androidboot.oem_ro_product_locale=pt-BR`(prop 層 `ro.product.locale=pt-BR` ✓)
  - **框架層陷阱**:A13+ framework Configuration locale 讀 **Settings `system_locales`**(舊 /data 留低 ru-RU 蓋過 prop)→ `settings put system system_locales pt-BR` → `mGlobalConfiguration [pt_BR]` **即時生效**;`setprop persist.sys.locale pt-BR`。
  - after:TZ=America/Sao_Paulo、locale/framework=pt_BR、persist.sys.locale=pt-BR。**RESIDUAL**:UserInfo label "Владелец"(舊建 user 嘅 display name 字串,非實時 locale)。
- **R51** `2024-05-05 → 2026-09-05`:oem_ 機制係 **whitelist**(`oem-ro-map.rc` 逐條 `oem-propctl` mapping;`androidboot.oem_ro_build_version_security_patch` carrier 有入 `ro.boot.*` 但無 mapping 唔落地)。修復 = `oem-ro-map.rc` 補一行 mapping(container-layer,rw)+ boot-arg `2026-09-05`。讀值 `ro.build.version.security_patch=2026-09-05` ✓。GMS 代次(26.42.31)已唔屬 stale。

## 5. DevCheck 前後對照(閉環收口)

- **before(史)**:82(v2 era:wx −15、model×chip −3、ADB −3)→ 97(gen10 maps-shim 清 wx;`t9-gen10-maps-shim.md`)。
- **after(本輪,stealth6-v3 + shim + T5 全項 + recreate 後)**:**Trust 100/100 "Genuine"**,All checks **113 passed / 0 failed / 0 issues**,banner "You can **safely** use device for all services"(比 gen10 嘅 "might have been modified" 更clean);issues tab = "No issues found"。
- **adb 狀態說明(誠實)**:掃描期間 **無 adb transport**(開機 scan 前 disconnect)→ ADB 項 = "Informational only" 不扣分;接返 adb(adbd running)= 返 −3 = **97**。97 基線維持,100 = adb 空閒態。
- **shim 注入驗證**:zygote maps shim ×5、rwx 行 0(filter 生效)。
- **卸載零殘留**:`pm uninstall` ✓ → package 0、/data/data deviceinsight 0;自帶 tmp 檔案已清。

## 6. Infra 變更記錄:fx2 recreate(重要,俚后续 gen)

- `docker commit redroid-rdev-fx2` → **`wa-stealth6:gen11b-rec`**(4.29GB;含 CDM 注入、protobuf symlink、stealth6-network.sh legacy-cp fix、oem-ro-map.rc 補行、shim.so/init.redroid.rc、GMS /data 狀態)。
- 新 `redroid-rdev-fx2`:同 name/port(15001)/**同 IP 172.38.200.5**/network `water-army-devices`/privileged/shm 64m,**restart=unless-stopped**(舊 = no,已改好)。boot-arg 改 3 項:serial 無 hyphen、locale pt-BR、+security_patch carrier。
- **坑**:①首次 run 我將 args 重複咗(158 個)→ crash loop;乾淨重跑 77 args OK。②**docker restart 後 IpClient flush v4**(已知 ritual:`ip addr replace 172.38.200.5/24 dev wlan0` + route replace ×2)。③checkin FAILURE 有 **~116 分鐘 backoff**,force 法 = `am force-stop com.google.android.gms` + 開 Play。④toybox `grep -iE` 复杂 pattern 喺 redroid 內 segfault(照用 -F)。

## 7. 交付狀態

- fx2:**Widevine ✓、DNS ✓、proxy ✓、check-in SUCCESS ✓、locale/TZ/patch ✓、debuggable=0 ✓、DevCheck 已卸載零殘留**;/data GMS 狀態保留(android_id 未變)。
- 後台常駐(本段新,俛后续 gen 知情):**`wa-eme-httpfront`**(20090→7897)、host `python3 -m http.server 8081 -d /tmp/wv30`(EME probe 頁)。
- Host artifacts:`/tmp/wa-stealth6-gen11/`(CDM 原件、db 讀值副本)、`/tmp/wv30/`(emulator vendor.fs + libwvdrmengine.so + eme2.html)、`/tmp/dc-0[12]*.png`。
- 未动:fx1、water-army-* 五個用戶 container、matrix gost 前端。零 secret。
- **掛起項(老細拍板)**:①Widevine CDM 商用 licence ②R50 屬地 story 最終確認(BR?)③DevCheck 新殘餘 = **無新增**;新風險 = serial 格式教訓入 R52 備註(hyphen 唔合法)。
