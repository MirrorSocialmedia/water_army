#!/usr/bin/env bash
# AB4 teardown (mandatory): stop + disable + delete the BR-B6-Acceptance A+B
# sampler+watcher user units, then verify they are gone.
set -uo pipefail
for u in br-b6accab-sampler br-b6accab-watcher; do
  systemctl --user disable --now "$u.service" 2>/dev/null || true
done
rm -f "$HOME/.config/systemd/user/br-b6accab-sampler.service" \
      "$HOME/.config/systemd/user/br-b6accab-watcher.service"
systemctl --user daemon-reload
left=$(systemctl --user list-unit-files 2>/dev/null | grep 'br-b6accab' || true)
if [ -z "$left" ]; then
  echo "units removed: PASS (zero br-b6accab units)"
  exit 0
fi
echo "FATAL: units still present:"; echo "$left"
exit 1
