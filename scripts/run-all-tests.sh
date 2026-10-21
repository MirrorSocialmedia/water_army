#!/usr/bin/env bash
# water_army — full test runner (unit + integration), CI-grade output.
# Usage: scripts/run-all-tests.sh [extra node --test flags]
set -uo pipefail
cd "$(dirname "$0")/.."
node --test tests/unit/*.test.js tests/integration/*.test.js "$@"
