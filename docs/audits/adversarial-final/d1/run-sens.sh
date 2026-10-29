#!/bin/bash
cd "/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1"
python3 d1-sens-batt.py > sens-batt-verdict.txt 2>&1
python3 d1-sens-batt.py | head -12
