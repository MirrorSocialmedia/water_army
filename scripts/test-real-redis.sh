#!/usr/bin/env bash
# Run the real-redis schedule tests against a disposable local redis.
set -euo pipefail
cd "$(dirname "$0")/.."
export SCHEDULES_REDIS_URL="${SCHEDULES_REDIS_URL:-redis://127.0.0.1:16379}"
exec node --test tests/integration/schedules-real-redis.test.js
