#!/usr/bin/env bash
# BR-B2 G8 — standalone teardown (idempotent; safe to run repeatedly).
# Removes ONLY br-b2-* containers + their volumes and the smoke processes.
set -uo pipefail
cd "$(dirname "$0")/../.."

RUN=.dev/br-b2-smoke
dc() { sg docker -c "docker $*"; }

# pidfile-only kills (never pattern-kill: other tenants may run water_army
# processes from the same repo path).
for f in "$RUN"/pids/*; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
sleep 1
for f in "$RUN"/pids/*; do [ -f "$f" ] && kill -9 "$(cat "$f")" 2>/dev/null; done
dc rm -v -f br-b2-pg br-b2-redis >/dev/null 2>&1 || true

echo "br-b2-* containers remaining: $(dc ps -a --format '{{.Names}}' 2>/dev/null | grep -c '^br-b2-' || true)"
echo "smoke pids still alive: $(ls "$RUN"/pids 2>/dev/null | while read f; do kill -0 "$(cat "$RUN/pids/$f")" 2>/dev/null && echo "$f"; done | wc -l)"
echo "done"
