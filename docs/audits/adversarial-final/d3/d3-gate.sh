#!/bin/bash
# Phase A — D3-4 養號閘 real-API matrix (uses adv-b1/b2 identities; a-group untouched)
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d3
A=./d3-api.sh
L=gate-matrix.log
: > "$L"
python3 - <<'EOF' > ids.env
import json
ids=json.load(open('identities.json'))['items']
m={i['displayName']: i['id'] for i in ids}
for k,v in m.items():
    if 'adv' in k: print(f"ID_{k.replace('redroid-rdev-adv-','').upper()}={v}")
EOF
cat ids.env; . ./ids.env
req(){ echo "== $* ==" >> "$L"; }

req "GET warm(b2) baseline"
$A GET "/api/identities/$ID_B2/warm" >> "$L" 2>&1
req "POST start(b2): cold->warming"
$A POST "/api/identities/$ID_B2/warm/start" '{}' >> "$L" 2>&1
req "POST start(b2) again: expect 409"
$A POST "/api/identities/$ID_B2/warm/start" '{}' >> "$L" 2>&1
req "business batch (b2, no purpose): expect 409 WARM_GATE_BLOCKED"
$A POST /api/batches '{"name":"adv-d3 gate bus b2","idempotencyKey":"advd3-gate-bus-b2-20261029","identities":["'$ID_B2'"],"batchSize":1,"maxActiveContainers":1,"failurePolicy":"continue_and_report","config":{"adapter":{"type":"noop","durationMs":5000,"outcome":"ok"}}}' >> "$L" 2>&1
req "business batch + warmOverride(admin+reason): expect 201"
$A POST /api/batches '{"name":"adv-d3 gate ovr b2","idempotencyKey":"advd3-gate-ovr-b2-20261029","identities":["'$ID_B2'"],"batchSize":1,"maxActiveContainers":1,"failurePolicy":"continue_and_report","warmOverride":true,"warmOverrideReason":"WA-ADVERSARIAL-FINAL D3-4 override audit probe","config":{"purpose":"signup","adapter":{"type":"noop","durationMs":5000,"outcome":"ok"}}}' >> "$L" 2>&1
req "POST force(b1) no reason: expect 400"
$A POST "/api/identities/$ID_B1/warm/force" '{}' >> "$L" 2>&1
req "POST force(b1) reason: expect 200 warm"
$A POST "/api/identities/$ID_B1/warm/force" '{"reason":"D3-4 admin force probe"}' >> "$L" 2>&1
req "GET warm(b1): derived warm"
$A GET "/api/identities/$ID_B1/warm" >> "$L" 2>&1
req "warm-gate retest b1 (business, warm state): expect NOT blocked -> 201"
$A POST /api/batches '{"name":"adv-d3 gate warmpass b1","idempotencyKey":"advd3-gate-wp-b1-20261029","identities":["'$ID_B1'"],"batchSize":1,"maxActiveContainers":1,"failurePolicy":"continue_and_report","config":{"purpose":"signup","adapter":{"type":"noop","durationMs":5000,"outcome":"ok"}}}' >> "$L" 2>&1
req "POST reset(b1) -> cold"
$A POST "/api/identities/$ID_B1/warm/reset" '{}' >> "$L" 2>&1
req "POST reset(b2) -> cold"
$A POST "/api/identities/$ID_B2/warm/reset" '{}' >> "$L" 2>&1
req "audit trail (warm actions + override reason)"
$A GET "/api/audit-events?pageSize=40" > /tmp/adv-audit-tmp.json 2>&1
tail -c 4000 /tmp/adv-audit-tmp.json >> "$L"; head -c 1200 /tmp/adv-audit-tmp.json > audit-events-head.json
req "threshold GET"
$A GET /api/warm/threshold >> "$L" 2>&1
echo DONE; grep -c "^HTTP" "$L"
