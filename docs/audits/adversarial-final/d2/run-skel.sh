#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
./ja3-devices.sh > /dev/null
python3 ja3-skeleton.py > ja3-skeleton.txt 2>&1
cat ja3-skeleton.txt
