#!/usr/bin/env bash
# single-file test runner
set -uo pipefail
cd "$(dirname "$0")/.."
node --test "$1" "${@:2}"
