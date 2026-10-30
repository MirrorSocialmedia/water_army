#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army
PW="$(python3 -c "import json;print(json.load(open('secrets/gacct-pilot-003.json')).get('password',''))")" node docs/audits/fixall/d4fx-replay2.cjs http://127.0.0.1:16922
