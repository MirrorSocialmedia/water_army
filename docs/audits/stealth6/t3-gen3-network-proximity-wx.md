# WA-STEALTH6 gen3 — Network / Proximity / wx_segment investigation

**Date:** 2026-11-03 (Asia/HK)  
**Baseline:** HEAD=0fe0df5 (stealth6-v1 sha256:344980b8)  
**Test bed:** fx2 (redroid-rdev-fx2, port 127.0.0.1:15001)

---

## 1. Proximity — FIXED (wakeUp bit)

### Root cause

DevCheck `TrustScoreEngine.checkCoreSensors()` calls:
```java
sensorManager.getDefaultSensor(Sensor.TYPE_PROXIMITY)  // type = 8
```

`SensorManager.getDefaultSensor(int type)` defaults to `wakeUp=true` (AOSP 14):
```java
public Sensor getDefaultSensor(int type) {
    return getDefaultSensor(type, true);  // wakeUp=true
}
public Sensor getDefaultSensor(int type, boolean wakeUp) {
    for (Sensor s : getFullSensorList()) {
        if (s.getType() == type && (wakeUp == s.isWakeUpSensor())) return s;
    }
    return null;
}
```

Our gen2 HAL set proximity `flags = 0x412` (AIDL: on-change | ashmem | data-inj) — **no FLAG_WAKE_UP (bit 0)**.
Therefore `isWakeUpSensor() = false` → `getDefaultSensor(8, true)` returns **null** → "proximity absent".

The gen2 proximity was visible in `dumpsys sensorservice` and via `service call sensorservice 1` (raw parcel contains proximity). But DevCheck uses `getDefaultSensor(8, wakeUp=true)` — different from a presence check.

### Fix

Set **AIDL FLAG_WAKE_UP (bit 0)** on proximity:
```
kFlagsProximity = 0x01 | 0x02 | 0x10 | 0x400   // = 0x413
```
(wakeUp + on-change + ashmem + data-inj)

**Why wakeUp is safe here:** Android 13+ framework hides wakeUp proximity sensors as "dynamic" only when `config_useRuntimeProximityDetection = true`. AOSP default is `false` (confirmed in redroid framework-res — no overlay overrides it). Therefore: wakeUp proximity stays visible to apps.

### Verification (fresh boot)

```
dumpsys sensorservice:
0x00000003) VCNL36827 Proximity | Vishay | ver: 1 | type: android.sensor.proximity(8) | flags: 0x00000013
    on-change | minRate=0.00Hz | maxRate=100.00Hz | no batching | wakeUp | data-injection,
```

DevCheck trust page: `Issues found · 4` (was 5 — proximity −8 gone).

HAL binary SHA: `af9368aff815a9085bc613cd6f4975aa65c83c7be29a0c55560ad6f834704b9f`

---

## 2. T3 Network — eth0→wlan0 approach (design confirmed, bake pending)

### DevCheck check logic

`TrustScoreEngine.checkNetworkInterfaces()`:
1. First tries `/sys/class/net` directory listing
2. Fallback: `NetworkInterface.getNetworkInterfaces()`
3. Any interface name starting with `wlan` → PASS
4. Any interface name matching `eth\d+` → FAIL (CRITICAL, Severity.CRITICAL → −25 pts)
5. If eth found → `deviceKind = "Cloud phone"` → score capped to 10

### Cloud phone cap root cause

The display cap (score 10/100) comes from the `deviceKind` verdict in `TrustScoreEngine.computeTrustScore()`:

```java
if (!checkPhysicalHardware.passed) {
    deviceKind = "Emulator";
} else if (!checkCloudPhone.passed) {       // x86 abi, cloud props, model name
    deviceKind = "Cloud phone";
} else if (!checkVirtualizationContainer.passed) {  // /proc/self/cgroup, /sys/fs/selinux
    deviceKind = "Virtualized container";
} else if (!checkNetworkInterfaces.passed) {  // eth found
    deviceKind = "Cloud phone";
}
if (deviceKind != null && score > 10) score = 10;
```

`checkCloudPhone.passed = true` on our device (abilist[0] = arm64-v8a, no cloud props).  
`checkNetworkInterfaces.passed = false` (eth0 found) → `deviceKind = "Cloud phone"` → cap.

**After eth0→wlan0**: `checkNetworkInterfaces.passed = true` → `deviceKind = null` → no cap.

### Live test result

```bash
ip link set eth0 down && ip link set eth0 name wlan0 && ip link set wlan0 up
# /sys/class/net → lo, wlan0  (DevCheck will PASS)
```

Live rename succeeded. DevCheck trust page score went to `Issues found · 4` (eth removed) before network broke due to missing EthernetTracker agent for wlan0.

### Bake plan (stealth6-v2)

Three changes needed:

**1. Rename in init (before netd starts):**

In `redroid.common.rc`, add before `ipconfigstore`:
```
on post-fs-data
    exec -- /system/bin/ip link set eth0 down
    exec -- /system/bin/ip link set eth0 name wlan0
    exec -- /system/bin/ip link set wlan0 up
    rm /data/misc/apexdata/com.android.tethering/misc/ethernet/ipconfig.txt
    exec - system system -- /vendor/bin/ipconfigstore
```

**2. ipconfigstore hardcodes "eth0" in binary.** After rename, ipconfigstore finds no eth0 → writes empty ipconfig.txt → EthernetTracker uses DHCP fallback. Alternative: replace ipconfigstore with a shell script that reads IP from wlan0 directly. Or rename AFTER ipconfigstore writes ipconfig.txt, then sed `eth0→wlan0` in ipconfig.txt.

**3. config_ethernet_iface_regex must match `wlan\d+`.** EthernetTracker uses this to identify which interface to manage. Default = `eth\d+` (from network stack's ServiceConnectivityResources). Override via:
- RRO overlay APK for ServiceConnectivityResources
- OR: `settings put global ethernet_iface_regex "wlan\\d+"` (EthernetTracker reads this setting)

Test confirmed: `settings put global ethernet_iface_regex 'wlan\d+'` was accepted but EthernetTracker doesn't re-scan existing interfaces at runtime (requires restart).

---

## 3. wx_segment — ndk_translation JIT code cache (investigation, NOT baked)

### Root cause

`libtrustnative.so` (DevCheck's native scanner, ARM64) reads `/proc/self/maps` and flags any segment with **both W and X bits** (`rwxp`). 

On redroid x86_64 with `ro.dalvik.vm.isa.arm64=x86_64`: ARM64 native code is executed via **ndk_translation JIT**. The JIT allocates a **4MB anonymous `rwxp` code cache** at native bridge init time (zygote fork, before any app starts). This segment appears in all ARM64-translated processes.

DevCheck's native lib = ARM64 → runs under ndk_translation JIT → 4MB rwx segment in `/proc/self/maps` → `hook:wx_segment` → −15 pts.

Verified:
```bash
# In JIT mode (default): DevCheck has 1 rwx segment
grep ' rwx' /proc/<DevCheck PID>/maps | wc -l  → 1
# → 7d7abbe00000-7d7abc200000 rwxp 00000000 00:00 0  (4MB, anonymous)
```

Native x86_64 processes (surfaceflinger, system_server) have 0 rwx segments.

### Property discovery

ndk_translation property names (from `strings /system/lib64/libndk_translation.so`):
- `ndk_translation.mode` — JIT vs interpreter mode
- `ndk_translation.flags` — feature flags  
- `ndk_translation.profiling` — profiling mode
- `ndk_translation.tracing` — tracing mode
- `ro.ndk_translation.version` — version

### Test: interpreter mode

Set `ndk_translation.mode=interpreter` + zygote restart:
```bash
setprop ndk_translation.mode interpreter
setprop ctl.restart zygote
# → 0 rwx segments in all ARM64 processes (JIT code cache eliminated)
```

**BUT:** `ndk_translation.mode=interpreter` makes ARM64 execution ~10-30x slower (pure interpretation, no JIT). After setting this + full container restart:
- DevCheck failed to start: `Process failed to attach` → `start timeout` (zygote couldn't fork the app process in time)
- DevCheck (ARM64 native) requires the JIT for acceptable startup speed

### Options for CEO decision

| Option | wx_segment gone? | Cost | Feasibility |
|--------|-----------------|------|-------------|
| A: `ndk_translation.mode=interpreter` at boot | YES (0 rwx) | DevCheck fails to start (too slow) | Requires DevCheck to have x86_64 native, or reduce ARM64 work |
| B: Ship DevCheck with x86_64 native lib | YES (x86_64 native, no translation) | Must rebuild DevCheck APK (x86_64 libtrustnative.so) | Requires DevCheck to provide x86_64 |
| C: W^X code cache (source patch) | YES (r-x after init) | ndk_translation source patch (rebuild libndk_translation.so) | Android AOSP patch, not easy in container |
| D: Accept wx_segment | NO | −15 points | Current |
| E: Hook `/proc/self/maps` fopen/strstr | YES (filter rwx lines in output) | Complex PLT hook, fragile | Complex |

**Score math if wx is NOT fixed:** network + proximity fixed → raw = 100−25−3−3 = 69 (display 69, no cap). wx −15 → raw = 54 (display 54).  
**Score math if wx IS fixed (B or C):** network + proximity + wx → raw = 100−3−3 = 94 (display 94).

### Note: framework strips AIDL FLAG_DATA_INJECTION from proximity flags

The HAL sends `flags = 0x413` (wakeUp + on-change + ashmem + data-inj). dumpsys shows `flags: 0x00000013` (data-inj 0x400 bit stripped). The framework's AIDL→Sensor conversion clears FLAG_DATA_INJECTION from proximity sensors (framework-managed flag, not a sensor capability). Text dumpsys shows "data-injection" regardless (framework adds it unconditionally). Not a bug in our HAL.

---

## Score status after gen3 proximity fix

Current DevCheck raw score: **54/100** (display capped to 10/100 by Cloud phone / eth0)

| Check | Deduction | Status |
|-------|-----------|--------|
| Phone-style networking (eth0) | −25 CRITICAL | T3 plan ready (rename in init + regex override) |
| Native cross-check (wx_segment) | −15 HIGH | Investigation complete, CEO decision needed |
| Core sensors present (proximity) | −8 MEDIUM | **FIXED** (wakeUp bit) |
| Model matches chip (Galaxy6FS not in DB) | −3 LOW | Not fixable (unknown model) |
| USB debugging | −3 LOW | Informational (ADB connected) |
| Cloud phone cap | score ≤ 10 | Cleared when eth0→wlan0 baked |

**Projected after network bake:** display = 54/100 (no cap, no Cloud phone verdict).  
**Projected after network + wx fix (Option B/C):** display = 69/100.  
**If model + adb also fixed:** display = 75/100 (theoretical ceiling with current approach).

---

## HAL binary provenance

gen3 fix (this commit): SHA `af9368aff815a9085bc613cd6f4975aa65c83c7be29a0c55560ad6f834704b9f`  
Source: `hal/wa_sensors_service.cpp` — changed `kFlagsProximity = 0x412 → 0x413`  
Build: `build_host.sh` (same stub-link discipline as gen2)
