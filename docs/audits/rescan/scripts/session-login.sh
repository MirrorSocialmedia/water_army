#!/bin/bash
# WA-RESCAN ops helper: admin session cookie for the product API (no password in cmdline).
# NOTE: this environment mangles "$(cmd)" on write; backticks are stable here.
set -euo pipefail
TOKEN="`node -p "require('crypto').randomBytes(24).toString('hex')"`"
HASH="`node -p "require('crypto').createHash('sha256').update(process.argv[1]).digest('hex')" "$TOKEN"`"
docker exec -i water-army-postgres-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (gen_random_uuid(), '$HASH', (SELECT id FROM users WHERE username='admin'), now()+interval '4 hours', now(), now()) RETURNING id;\""
printf '%s' "$TOKEN" > /tmp/wa-rescan-cookie.txt
echo "cookie file: /tmp/wa-rescan-cookie.txt"
