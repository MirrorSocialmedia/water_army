#!/usr/bin/env bash
# BR-B1 migration check — MD §14.2 (PostgreSQL migration on EMPTY db and on an
# EXISTING-db upgrade must both succeed; migrations must be re-runnable).
#
# Runs against a SCRATCH Postgres (own container + own volume on host port
# 16300) — it NEVER touches the user compose stack or its volumes.
#
#   Path A (fresh):   empty db      → `prisma migrate deploy` (ALL migrations)
#                      → redeploy (idempotency) → new objects exist
#   Path B (upgrade): 7 pre-B1 migrations hand-applied via psql +
#                      `prisma migrate resolve --applied` → seed legacy rows
#                      → `prisma migrate deploy` applies ONLY the B1 file
#                      → legacy data byte-identical (data-only dump diff)
#                      → unique constraints smoke-tested
#
# Teardown (always, via trap): docker rm -f + docker volume rm (scratch only).
#
# Usage:  bash scripts/migration-b1-check.sh [port]     (default 16300)
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${1:-16300}"
CTN="wa-br-b1-scratch"
VOL="wa-br-b1-scratch-pgdata"
PG_IMAGE="postgres:17.6"
DB_A="water_army"            # fresh path
DB_B="water_army_upgrade"    # existing-db path
PG_USER="app"
# Random per-run scratch password (never a literal — gitleaks-clean; the scratch
# container is ephemeral and torn down by the trap, so no rotation concern).
PG_PASS="$(openssl rand -hex 12)"
B1_DIR="$(ls -d prisma/migrations/*_batch_rotation_b1 | head -1)"
B1_NAME="$(basename "$B1_DIR")"
PRE_B1="$(ls -d prisma/migrations/*/ | grep -v "$B1_NAME" | sort)"

DOCK() { sg docker -c "docker $*"; }

cleanup() {
  DOCK rm -f "$CTN" >/dev/null 2>&1 || true
  DOCK volume rm "$VOL" >/dev/null 2>&1 || true
  rm -f /tmp/wa-br-b1-*.sql
}
trap cleanup EXIT

step() { echo "[migration-b1-check] $*"; }

# ------------------------------------------------------------------ scratch PG
if [ -n "$(ss -ltn 2>/dev/null | grep ":$PORT " || true)" ]; then
  echo "FATAL: port $PORT already in use — pick another port (arg 1)" >&2
  exit 1
fi
step "starting scratch $PG_IMAGE on 127.0.0.1:$PORT (container $CTN, volume $VOL)"
DOCK run -d --name "$CTN" -p "127.0.0.1:$PORT:5432" \
  -e "POSTGRES_USER=$PG_USER" -e "POSTGRES_PASSWORD=$PG_PASS" -e "POSTGRES_DB=$DB_A" \
  -v "$VOL:/var/lib/postgresql/data" "$PG_IMAGE" >/dev/null

for i in $(seq 1 30); do
  if DOCK exec "$CTN" pg_isready -U "$PG_USER" >/dev/null 2>&1; then
    step "scratch pg ready after ${i}s"; break
  fi
  [ "$i" -eq 30 ] && { echo "FATAL: scratch pg never became ready" >&2; exit 1; }
  sleep 1
done

PSQL_A() { DOCK exec -i "$CTN" psql -U "$PG_USER" -d "$DB_A" -v ON_ERROR_STOP=1 -q -f -; }
PSQL_B() { DOCK exec -i "$CTN" psql -U "$PG_USER" -d "$DB_B" -v ON_ERROR_STOP=1 -q -f -; }
PSQL_A_VAL() { DOCK exec -i "$CTN" psql -U "$PG_USER" -d "$DB_A" -v ON_ERROR_STOP=1 -qtA -f -; }

# ------------------------------------------------------------------ Path A
step "PATH A — fresh db: full migrate deploy"
DATABASE_URL="postgresql://$PG_USER:$PG_PASS@127.0.0.1:$PORT/$DB_A" npx prisma migrate deploy >/dev/null
DATABASE_URL="postgresql://$PG_USER:$PG_PASS@127.0.0.1:$PORT/$DB_A" npx prisma migrate status >/dev/null
step "PATH A — redeploy must be a no-op (idempotent)"
OUT="$(DATABASE_URL="postgresql://$PG_USER:$PG_PASS@127.0.0.1:$PORT/$DB_A" npx prisma migrate deploy 2>&1)"
echo "$OUT" | grep -q "No pending migrations to apply" || { echo "FATAL: redeploy not idempotent: $OUT" >&2; exit 1; }
TABLEN="$(PSQL_A_VAL <<'SQL'
SELECT count(*) FROM information_schema.tables
 WHERE table_schema='public'
   AND table_name IN ('identities','batches','batch_identities','resource_leases','state_events');
SQL
)"
[ "$TABLEN" = "5" ] || { echo "FATAL: expected 5 new tables on fresh db, got $TABLEN" >&2; exit 1; }
COLS="$(PSQL_A_VAL <<'SQL'
SELECT count(*) FROM information_schema.columns
 WHERE table_name='task_runs'
   AND column_name IN ('batch_id','identity_id','lease_owner','lease_expires_at','heartbeat_at','max_attempts');
SQL
)"
[ "$COLS" = "6" ] || { echo "FATAL: expected 6 new task_runs columns, got $COLS" >&2; exit 1; }
step "PATH A OK (5 tables + 6 task_runs columns, idempotent redeploy)"

# ------------------------------------------------------------------ Path B
step "PATH B — existing db: hand-apply pre-B1 migrations + resolve markers"
DOCK exec "$CTN" createdb -U "$PG_USER" "$DB_B" >/dev/null
for d in $PRE_B1; do
  name="$(basename "$d")"
  PSQL_B < "prisma/migrations/$name/migration.sql"
  DATABASE_URL="postgresql://$PG_USER:$PG_PASS@127.0.0.1:$PORT/$DB_B" \
    npx prisma migrate resolve --applied "$name" >/dev/null
  step "  applied+marked $name"
done

cat > /tmp/wa-br-b1-seed.sql <<'SQL'
BEGIN;
INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111','seed-user','seedhash-not-real','operator',true,now(),now());
INSERT INTO provider_configs (id, name, provider_type, base_url, model_id, timeout_ms, is_enabled, created_at, updated_at) VALUES ('22222222-2222-4222-8222-222222222222','seed-prov','openai_compatible','http://seed.local/v1','seed-model',120000,true,now(),now());
INSERT INTO task_definitions (id, title, task_type, provider_config_id, prompt_template, mode, timeout_ms, max_attempts, created_by, created_at, updated_at) VALUES ('33333333-3333-4333-8333-333333333333','seed-def','ai','22222222-2222-4222-8222-222222222222','seed prompt','analysis_only',120000,3,'11111111-1111-4111-8111-111111111111',now(),now());
INSERT INTO task_runs (id, task_definition_id, status, input_json, attempt, queued_at, requested_by, created_at, updated_at) VALUES ('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','succeeded','{"prompt":"seed"}'::jsonb,1,now(),'11111111-1111-4111-8111-111111111111',now(),now());
INSERT INTO task_runs (id, task_definition_id, status, attempt, queued_at, created_at, updated_at) VALUES ('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333','running',2,now(),now(),now());
INSERT INTO task_run_events (id, task_run_id, event_type, message, created_at) VALUES ('66666666-6666-4666-8666-666666666666','44444444-4444-4444-8444-444444444444','succeeded','seed ok',now());
INSERT INTO schedules (id, name, task_definition_id, schedule_type, cron_expression, timezone, overlap_policy, is_enabled, bullmq_scheduler_id, sync_status, created_at, updated_at) VALUES ('77777777-7777-4777-8777-777777777777','seed-sched','33333333-3333-4333-8333-333333333333','cron','0 9 * * *','Asia/Taipei','skip_if_running',true,'sched-seed-1','synced',now(),now());
COMMIT;
SQL
PSQL_B < /tmp/wa-br-b1-seed.sql
DOCK exec "$CTN" pg_dump -U "$PG_USER" "$DB_B" --data-only --no-owner --no-privileges \
  --table=users --table=provider_configs --table=task_definitions \
  --table=task_runs --table=task_run_events --table=schedules > /tmp/wa-br-b1-pre-seed.sql

step "PATH B — migrate deploy must apply ONLY the B1 file"
OUT="$(DATABASE_URL="postgresql://$PG_USER:$PG_PASS@127.0.0.1:$PORT/$DB_B" npx prisma migrate deploy 2>&1)"
echo "$OUT" | grep -q "Applying migration \`$B1_NAME\`" || { echo "FATAL: B1 not applied: $OUT" >&2; exit 1; }
OUT2="$(DATABASE_URL="postgresql://$PG_USER:$PG_PASS@127.0.0.1:$PORT/$DB_B" npx prisma migrate deploy 2>&1)"
echo "$OUT2" | grep -q "No pending migrations to apply" || { echo "FATAL: upgrade redeploy not idempotent: $OUT2" >&2; exit 1; }

DOCK exec "$CTN" pg_dump -U "$PG_USER" "$DB_B" --data-only --no-owner --no-privileges \
  --table=users --table=provider_configs --table=task_definitions \
  --table=task_runs --table=task_run_events --table=schedules > /tmp/wa-br-b1-post-seed.sql

# Diff ignoring: pg_dump session tokens + the task_runs COPY header (gains 6
# new columns in the post dump) + the 6 new-column cells on legacy rows
# (NULL×5 + max_attempts=3).
if ! diff <(grep -vE '^\\(un)?restrict ' /tmp/wa-br-b1-pre-seed.sql \
            | grep -vE '^COPY public\.task_runs \(' \
            | sed -E 's/(\t\\N){5}\t3$//') \
        <(grep -vE '^\\(un)?restrict ' /tmp/wa-br-b1-post-seed.sql \
            | grep -vE '^COPY public\.task_runs \(' \
            | sed -E 's/(\t\\N){5}\t3$//') >/tmp/wa-br-b1-diff.txt; then
  echo "FATAL: legacy data changed by B1 migration:" >&2
  cat /tmp/wa-br-b1-diff.txt >&2
  exit 1
fi
step "PATH B — legacy data byte-identical after upgrade"

# Constraint smoke (each duplicate must be REJECTED, non-duplicate accepted).
# NOTE: psql exits non-zero under ON_ERROR_STOP, so capture output first —
# a bare `psql | grep` pipeline would trip `set -o pipefail` on the EXPECTED
# error exit.
cat > /tmp/wa-br-b1-constraints.sql <<'SQL'
INSERT INTO batches (id, name, cycle_id, batch_no, status, batch_size, max_active_containers, failure_policy, created_at) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','b1','cycle-x',1,'PLANNED',50,50,'stop_batch',now());
SQL
PSQL_B < /tmp/wa-br-b1-constraints.sql
cat > /tmp/wa-br-b1-constraints.sql <<'SQL'
INSERT INTO batches (id, name, cycle_id, batch_no, status, batch_size, max_active_containers, failure_policy, created_at) VALUES ('aaaaaaaa-0000-4000-8000-000000000002','b1-dup','cycle-x',1,'PLANNED',50,50,'stop_batch',now());
SQL
OUT="$(PSQL_B < /tmp/wa-br-b1-constraints.sql 2>&1 || true)"
echo "$OUT" | grep -q "batches_cycle_id_batch_no_key" || { echo "FATAL: (cycle_id,batch_no) unique not enforced: $OUT" >&2; exit 1; }
cat > /tmp/wa-br-b1-constraints.sql <<'SQL'
INSERT INTO identities (id, display_name, identity_type, status, data_path, metadata_json, created_at, updated_at) VALUES ('bbbbbbbb-0000-4000-8000-000000000001','id-1','qa_device','READY','/data/water_army/identities/uuid-1/data','{}',now(),now());
INSERT INTO identities (id, display_name, identity_type, status, data_path, metadata_json, created_at, updated_at) VALUES ('bbbbbbbb-0000-4000-8000-000000000002','id-2','qa_device','READY','/data/water_army/identities/uuid-1/data','{}',now(),now());
SQL
OUT="$(PSQL_B < /tmp/wa-br-b1-constraints.sql 2>&1 || true)"
echo "$OUT" | grep -q "identities_data_path_key" || { echo "FATAL: identities.data_path unique not enforced: $OUT" >&2; exit 1; }
cat > /tmp/wa-br-b1-constraints.sql <<'SQL'
INSERT INTO resource_leases (id, resource_type, resource_key, owner_run_id, lease_expires_at, created_at, updated_at) VALUES ('cccccccc-0000-4000-8000-000000000001','container_slot','slot-0',NULL,now()+interval '5 minutes',now(),now());
INSERT INTO resource_leases (id, resource_type, resource_key, owner_run_id, lease_expires_at, created_at, updated_at) VALUES ('cccccccc-0000-4000-8000-000000000002','container_slot','slot-0',NULL,now()+interval '5 minutes',now(),now());
SQL
OUT="$(PSQL_B < /tmp/wa-br-b1-constraints.sql 2>&1 || true)"
echo "$OUT" | grep -q "resource_leases_resource_type_resource_key_key" || { echo "FATAL: resource_leases (type,key) unique not enforced: $OUT" >&2; exit 1; }
step "PATH B — unique constraints enforced (cycle+batch_no, data_path, lease key)"

step "ALL OK — teardown"
