#!/usr/bin/env bash
# Install the BR-B6-Acceptance A+B sampler+watcher as persistent systemd USER
# units (idempotent). Survives openclaw-gateway restarts (user-manager cgroup).
#
# Verification: samples-30s.csv must gain a new row within ~30s;
# window-watch.log must gain a row within ~60s.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEST="$HOME/.config/systemd/user"
mkdir -p "$DEST"
cp "$REPO/scripts/br-b6accab/systemd/br-b6accab-sampler.service" "$DEST/"
cp "$REPO/scripts/br-b6accab/systemd/br-b6accab-watcher.service" "$DEST/"
systemctl --user daemon-reload
systemctl --user enable --now br-b6accab-sampler.service
systemctl --user enable --now br-b6accab-watcher.service
echo "--- status ---"
systemctl --user is-active br-b6accab-sampler br-b6accab-watcher
