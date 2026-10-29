#!/bin/bash
cd "/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1"
for d in a1 a2 a3 a4; do echo "=== $d ==="; python3 d1-fp-compare.py "$d"; done
