#!/system/bin/sh
# stealth6-network.sh — eth0→wlan0 rename + ipconfig.txt binary patch
# Runs in post-fs-data AFTER redroid.common.rc's ipconfigstore (alphabetical init ordering)
# ipconfig.txt format (binary, 130 bytes after ipconfigstore with eth0):
#   header + ipAssignment STATIC + linkAddress + gateway + dns + id=eth0 + eos
# id=eth0 bytes: at offset 120 = \x04eth0\x00 then \x03eos at 126-129 (10 bytes total)
# Patch: replace \x04eth0\x00 (6 bytes) with \x05wlan0\x00 (7 bytes, net +1 byte)
# New file: 131 bytes = first 120 + wlan0 section (7 bytes) + eos section (4 bytes)

IPC="/data/misc/apexdata/com.android.tethering/misc/ethernet/ipconfig.txt"
TMP="/data/local/tmp/ipconfig_wlan0.bin"

# Step 1: rename eth0 -> wlan0 (kernel-level, before netd)
ip link set eth0 down 2>/dev/null
ip link set eth0 name wlan0 2>/dev/null
ip link set wlan0 up 2>/dev/null

# Step 2: patch ipconfig.txt id field (binary)
# Read first 120 bytes (everything up to and including \x02id\x00 = id section header)
dd if="$IPC" of="$TMP" bs=1 count=120 2>/dev/null
# Append \x05wlan0\x00 (7 bytes: len=5 + "wlan0" + NUL)
printf '\005wlan0\000' >> "$TMP"
# Append remaining 4 bytes (\x03eos section: len=3 + "eos")
dd if="$IPC" bs=1 skip=126 count=4 2>/dev/null >> "$TMP"
# Install patched file
cp "$TMP" "$IPC"
chmod 644 "$IPC"
