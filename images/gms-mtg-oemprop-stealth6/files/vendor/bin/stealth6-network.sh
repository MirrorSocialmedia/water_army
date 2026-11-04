#!/system/bin/sh
# stealth6-network.sh — eth0->wlan0 rename + SYNTHESIZE golden ipconfig.txt (stealth6-v2)
# Runs in post-fs-data AFTER redroid.common.rc's ipconfigstore (init rc alphabetical order).
#
# Why synthesize (gen4 bake blocker, docs/audits/stealth6/t4-gen4-t3-validation.md):
# ipconfigstore reads EMPTY on this host class (kernel 6.8: no /proc/net/ip_config_hash),
# so the file may be absent/garbage — do NOT patch-if-exists; WRITE the golden file from
# live Docker-assigned values (Docker sets IP before PID1, so `ip` is authoritative here).
#
# Golden binary layout (byte-exact from boot-verified 131 B fx2 file; big-endian):
#   u32(3) | u16(12)"ipAssignment" | u16(6)"STATIC" | u16(11)"linkAddress"
#   | u16(12)<ip> NUL | 00 00 u8(prefix) 00
#   | u8(7)"gateway" NUL | 00 00 01 00 | u8(7)"0.0.0.0" NUL | 00*6 01 00
#   | u8(len)<gw> NUL | u8(3)"dns" NUL u8(len)<dns> NUL
#   | u8(2)"id" NUL u8(len)<iface> NUL | u8(3)"eos"   (no NUL after eos)
# EthernetTracker matches the ipconfig "id" field against interface name (must be wlan0).

IPC="/data/misc/apexdata/com.android.tethering/misc/ethernet/ipconfig.txt"
TMP="/data/local/tmp/ipconfig_wlan0.bin"

# Step 1: rename eth0 -> wlan0 (kernel-level, before netd/EthernetTracker start)
ip link set eth0 down 2>/dev/null
ip link set eth0 name wlan0 2>/dev/null
ip link set wlan0 up 2>/dev/null

# Step 2: live network values (Docker bridge assignment; IP survives the rename)
IFACE=wlan0
IPADDR=$(ip -4 -o addr show dev "$IFACE" 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/\([0-9]*\).*/\1/p' | head -n1)
PREFIX=$(ip -4 -o addr show dev "$IFACE" 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/\([0-9]*\).*/\2/p' | head -n1)
GW=$(ip -4 -o route show 2>/dev/null | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -n1)
# Docker bridge gateway = subnet .1 when the kernel carries no default route
# (fwmark route 0.0.0.0/0 -> <gw> wlan0 verified working, gen4 field run)
[ -z "$GW" ] && GW="${IPADDR%.*}.1"
DNS=$(sed -n 's/^nameserver \([0-9.]*\)$/\1/p' /etc/resolv.conf 2>/dev/null | head -n1)
[ -z "$DNS" ] && DNS=8.8.8.8

# Step 3: synthesize golden ipconfig.txt (dynamic string lengths as octal escapes)
if [ -n "$IPADDR" ]; then
    OIPL=$(printf '%03o' ${#IPADDR})
    OGWAL=$(printf '%03o' ${#GW})
    ODNSL=$(printf '%03o' ${#DNS})
    OIDL=$(printf '%03o' ${#IFACE})
    OMASK=$(printf '%03o' "${PREFIX:-24}")
    {
        printf '\000\000\000\003\000\014ipAssignment\000\006STATIC\000\013linkAddress'
        printf "\000\\$OIPL$IPADDR\000\000\000"
        printf "\\$OMASK\000\007gateway\000\000\000\001\000\0070.0.0.0\000"
        printf '\000\000\000\000\000\000\001\000'
        printf "\\$OGWAL$GW\000\003dns\000"
        printf "\\$ODNSL$DNS\000\002id\000"
        printf "\\$OIDL$IFACE\000\003eos"
    } > "$TMP"
    # Step 4: install (dir normally exists from tethering; tolerate pre-existence)
    mkdir -p "${IPC%/*}" 2>/dev/null
    cp "$TMP" "$IPC"
    chmod 644 "$IPC"
    chown system:system "$IPC" 2>/dev/null
fi
