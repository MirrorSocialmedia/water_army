# R2 (Phase 2) diagnostic tooling — static binaries for the redroid device.
#
# Both tools are host-compiled (x86-64 static) and `adb push`-ed to
# /data/local/tmp/ on the spike device (the redroid userspace is x86-64 on
# the same host kernel — the same contract the tun2socks static ELF relies
# on, see docker/redroid-matrix/tun2socks.env).
#
#   probe      — controlled-geometry TCP client (see probe.c header)
#   tproxy-mini — single-target TCP forwarder for the REDIRECT pilot (see tproxy-mini.c header)
#
# Build (host, dev container or Ubuntu with gcc):
#   make -C tests/tools
#
# These are DIAGNOSTIC assets (R2 spike), not product code.

CC ?= gcc
CFLAGS ?= -O2 -static -Wall -Wextra

all: probe tproxy-mini

probe: probe.c
	$(CC) $(CFLAGS) -o $@ $<

tproxy-mini: tproxy-mini.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f probe tproxy-mini

.PHONY: all clean
