# WA-STEALTH6 gen4 — T3 network fx2 field validation + proximity re-check + wx conclusion

**Date:** 2026-11-04 (Asia/HK) — relay after gen3 quiet-end
**Baseline:** HEAD=fc7e104 → WIP saved as `1281b13` (gen3-WIP, pushed)
**Test bed:** fx2 (redroid-rdev-fx2, stealth6-v1 image 344980b8, hot-patched — NO new image, NO new machine, RAM gate kept)

---

## Verdicts (honest)

| Item | Verdict | Evidence |
|------|---------|----------|
| Proximity (wakeUp fix) | **FIXED (re-confirmed)** | `dumpsys sensorservice`: `VCNL36827 Proximity … flags: 0x00000013` (wakeUp in text) ✓; `pm list features` → `android.hardware.sensor.proximity` ✓; DevCheck trust page has NO proximity issue (−8 gone) ✓ |
| T3 network design (eth0→wlan0 + EthernetTracker via wlan0) | **DESIGN VERIFIED (hot-patch); BAKE PENDING — gen3 bake script must NOT ship as-is** | see below |
| wx_segment | **RESIDUAL (−15), conclusion = gen3 doc** | ndk_translation JIT 4MB anonymous `rwxp` code cache, structural to ARM64-under-x86_64; options A–E in `t3-gen3-network-proximity-wx.md`; CEO decision. −15 is inside the current 79. |

---

## T3 network — field validation detail

### Before (hot-patch + restart, 18:40Z)
- `/sys/class/net` = eth0, lo
- ipconfig.txt = 130 B, `id=eth0` (offsets match gen3 script assumptions: id header 0x74, value 0x78)
- `Active default network: none`; Android `ping` = `Network is unreachable` (kernel route exists; Android framework had no default network)
- Stale gen3 leftover: `settings global ethernet_iface_regex = "wland+"` (shell ate `\d`; wrong regex) → **deleted** (must stay deleted for bake or it overrides SCR.apk resource)

### Hot-patch applied (runtime, image unchanged)
- `stealth6-network.sh` + `stealth6-network.rc` + proximity permissions XML + patched SCR.apk → `docker cp` → `docker restart fx2`
- Boot rename via rc: `/sys/class/net` → **lo, wlan0** ✓ (rename before netd works; Docker IP/route survive rename)

### Defect found in gen3 WIP script (bake blocker) — ipconfig.txt ended 7 bytes
After the rc-boot, ipconfig.txt = **`05 77 6c 61 6e 30 00` (7 B)** — our printf section only, no header, no eos.
Root cause chain (all reproduced):
1. `redroid.common.rc` post-fs-data: `rm ipconfig.txt` → `ipconfigstore`
2. **`ipconfigstore` reads EMPTY even with eth0 alive+configured** on this host (manual run printed `ipconfig: ipv4: , mask: 0, gateway:`, wrote no file). Host kernel 6.8: `/proc/net/ip_config_hash` does not exist. Historic 130 B files existed on older boots (fx1 still has one) but the current host/tool interaction is not reliable.
3. gen3 script assumed a 130 B file would exist to patch; with file missing it silently produced 7 B garbage (dd on missing input = empty; printf section only).
4. Consequence at bake time: EthernetTracker parses garbage → fallback DHCP → no DHCP server on Docker bridge → **no Android network at boot**.

### Fix that works (verified at runtime)
Golden format decoded from fx1's live 130 B file (read-only reference):
`u32(0,3)` + `[len][str][NUL]` records: ipAssignment="STATIC", linkAddress="<ip>" +u32 mask 24/0/0/0, gateway="<gw>" +u32 flags, dns="8.8.8.8", id=<iface>, eos.
Built **131 B ipconfig.txt**: fx1 golden with linkAddress→`172.38.200.5`, gateway=`172.38.200.1`, dns=`8.8.8.8`, id=`wlan0`. Installed + `kill -9 $(pidof netd)` (netd restart → EthernetTracker startTracking re-scans existing interfaces):

- `Active default network: **100**`
- `NetworkAgentInfo{network{100} … ni{Ethernet CONNECTED … lp{{InterfaceName: wlan0 LinkAddresses: [172.38.200.5/24] DnsAddresses: [/8.8.8.8] Routes: [0.0.0.0/0 -> 172.38.200.1 wlan0]}}}`
- Android `ping -c1 1.1.1.1` → **0% loss** (real connectivity through Android network stack, fwmark path)
- `settings get global ethernet_iface_regex` = null → SCR.apk patched resource regex (`w.*\d`) is what matched wlan0 ✓

Netd-restart bounce was only needed because the file was installed post-boot; at real boot the rc runs before netd starts, so tracker sees wlan0 first try (predicted; boot-time path = bake validation, pending).

### DevCheck reading on this state (fresh install, then uninstalled)
- `versionName=1.1.2` (same app as "DevCheck AI 2.9.2" marketing string)
- Main page: **`79 / 100` "Mostly consistent"**, `Trust details · 4` — **cap fully gone** (display = raw 79; no Cloud phone verdict)
- Score math: 100 −15 (wx_segment) −3 (model) −3 (adb) = 79 → network −25 GONE ✓, proximity −8 GONE ✓
- 4th listed issue not text-captured (uiautomator dump intermittently segfaults in this container; screencap frozen-frame after first capture) — gen3-trust-details79.png (01:30) shows the details page for the same state class
- DevCheck uninstalled after reading; fx2 left clean

Screenshots: `screens/gen4-trust79.png` (Trust page, 79/100), `screens/gen4-main79.png` (main page, Hardware trust 79, Trust details 4).

### Bake (stealth6-v2) requirements discovered this run
1. Script must **synthesize** ipconfig.txt (golden template + live `ip` values), NOT patch-if-exists; must not depend on ipconfigstore output.
2. id field must be `wlan0` (EthernetTracker matches ipconfig id to interface name).
3. `settings global ethernet_iface_regex` must be **unset** (a stale global overrides SCR.apk resource — leftover `wland+` broke eth0 matching for weeks).
4. SCR.apk patched regex `w.*\d` works (verified via EthernetNetworkSpecifier(wlan0) with setting=null).
5. Rename-before-netd via rc: verified at boot.

---

## RAM gate / hygiene
- No bake, no new container; fx2 reused. MemAvailable 7.3 GiB at start.
- water-army-* user stack untouched; fx1 used READ-ONLY (golden ipconfig.txt reference).
- DevCheck uninstalled; /data/local/tmp artifacts cleaned; Kairo task left for CEO to mark.
