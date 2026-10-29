#!/bin/bash
# D3-1 extension: identity COMPLETED is a closed leaf (IDENTITY_TRANSITIONS COMPLETED:[])
# → new sessions need fresh identities. Scaffold 4 (adv-e1) + 2 (adv-e2) identity rows
# (harness INSERT, product dispatch path untouched), then POST warming cycles.
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
D=20261029
docker exec -i water-army-postgres-1 psql -U app -d water_army -t -A <<'SQL' > x-ids.txt
INSERT INTO identities (id, external_ref, display_name, identity_type, status, data_path, metadata_json, created_at, updated_at)
VALUES
 (gen_random_uuid(),'redroid-rdev-adv-a1x','redroid-rdev-adv-a1x','qa_device','READY','/var/lib/water-army/redroid/redroid-rdev-adv-a1x','{"egressGroup":"adv-e1"}',now(),now()),
 (gen_random_uuid(),'redroid-rdev-adv-a2x','redroid-rdev-adv-a2x','qa_device','READY','/var/lib/water-army/redroid/redroid-rdev-adv-a2x','{"egressGroup":"adv-e1"}',now(),now()),
 (gen_random_uuid(),'redroid-rdev-adv-a3x','redroid-rdev-adv-a3x','qa_device','READY','/var/lib/water-army/redroid/redroid-rdev-adv-a3x','{"egressGroup":"adv-e1"}',now(),now()),
 (gen_random_uuid(),'redroid-rdev-adv-a4x','redroid-rdev-adv-a4x','qa_device','READY','/var/lib/water-army/redroid/redroid-rdev-adv-a4x','{"egressGroup":"adv-e1"}',now(),now()),
 (gen_random_uuid(),'redroid-rdev-adv-b1x','redroid-rdev-adv-b1x','qa_device','READY','/var/lib/water-army/redroid/redroid-rdev-adv-b1x','{"egressGroup":"adv-e2"}',now(),now()),
 (gen_random_uuid(),'redroid-rdev-adv-b2x','redroid-rdev-adv-b2x','qa_device','READY','/var/lib/water-army/redroid/redroid-rdev-adv-b2x','{"egressGroup":"adv-e2"}',now(),now())
RETURNING display_name, id;
SQL
cat x-ids.txt
A=./d3-api.sh
: > batch-create-x.log
while read -r name id; do
  [ -z "$id" ] && continue
  grp=adv-e1; case "$name" in *b*x) grp=adv-e2;; esac
  tag=${name#redroid-rdev-adv-}
  echo "== advd3-warm-${tag}-1-${D} ==" >> batch-create-x.log
  $A POST /api/batches "{\"name\":\"adv-D3 warm ${tag} s1\",\"idempotencyKey\":\"advd3-warm-${tag}-1-${D}\",\"identities\":[\"${id}\"],\"batchSize\":1,\"maxActiveContainers\":1,\"failurePolicy\":\"continue_and_report\",\"config\":{\"purpose\":\"warming\",\"adapter\":{\"type\":\"noop\",\"outcome\":\"ok\"},\"d3Group\":\"${grp}\"}}" >> batch-create-x.log 2>&1
done < x-ids.txt
grep -c "HTTP 201" batch-create-x.log
echo "X_CREATE_END $(date -u +%FT%TZ)" | tee -a batch-create-x.log
