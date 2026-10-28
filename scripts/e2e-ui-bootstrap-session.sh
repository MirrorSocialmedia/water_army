#!/bin/bash
# s6 e2e session bootstrap: throwaway admin user + opaque session token.
# Token stays local (logs/ui-surfacy/.token, gitignored); report carries none.
set -e
cd /home/kenneth/.openclaw/workspace/water_army
mkdir -p logs/ui-surfacy
TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
HASH=$(node -e "const c=require('crypto');console.log(c.createHash('sha256').update(process.argv[1]).digest('hex'))" "$TOKEN")
docker exec -i water-army-postgres-1 psql -U app -d water_army -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DELETE FROM sessions WHERE token_hash='$HASH';
INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
VALUES (gen_random_uuid(), 'ui-e2e', '\$argon2id\$e2efake\$ui-e2e', 'admin', true, now(), now())
ON CONFLICT (username) DO NOTHING;
INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at, last_seen_at)
VALUES (gen_random_uuid(), '$HASH', (SELECT id FROM users WHERE username='ui-e2e'), now() + interval '6 hours', now(), now());
COMMIT;
SQL
printf '%s' "$TOKEN" > logs/ui-surfacy/.token
# verify via API
curl -s -o /dev/null -w "me=%{http_code}\n" -H "Cookie: session=$TOKEN" http://127.0.0.1:3012/api/auth/me
