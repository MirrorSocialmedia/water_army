#!/usr/bin/env bash
# WA-STEALTH6 gen11: build the maps-shim (LD_PRELOAD, /proc/self/maps rwx-line
# filter for the DevCheck native cross-check). Host gcc, NO NDK, NO sysroot.
#
# Mechanism (gen10 finding, t9-gen10-maps-shim.md §1):
#   -nostdlib keeps the shim tiny & silent (ctor must stay a no-op — pitfall #6:
#   a ctor that touches /data/local/tmp hung adbd's CNXN -> adb offline).
#   The two stub .so's exist ONLY to record DT_NEEDED = libc.so, libdl.so
#   (bionic sonames) so Android's linker loads the host-built ELF; the real
#   symbols (dlsym/fmemopen/memcpy/syscall) bind to bionic at load time.
#
# Deployed field binary (fx2, sha256 3574cc7b...) is what gets baked; this
# script is for source-change iterations only. Output: ./shim.so
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CC="${CC:-gcc}"

# stubs (only if missing — they're link-time fakes, contents irrelevant)
mkdir -p "$DIR/stub"
[ -e "$DIR/stub/libc.so" ] || echo 'static void __wa_stub_c(void){};' | "$CC" -shared -fPIC -x c - -o "$DIR/stub/libc.so" -Wl,-soname,libc.so
[ -e "$DIR/stub/libdl.so" ] || echo 'static void __wa_stub_d(void){};' | "$CC" -shared -fPIC -x c - -o "$DIR/stub/libdl.so" -Wl,-soname,libdl.so

"$CC" -shared -fPIC -nostdlib -O2 -fno-stack-protector \
  "$DIR/shim.c" -Wl,--no-as-needed \
  -o "$DIR/shim.so" \
  "$DIR/stub/libc.so" "$DIR/stub/libdl.so"

echo "built: $DIR/shim.so"
sha256sum "$DIR/shim.so"
readelf -d "$DIR/shim.so" | grep NEEDED
