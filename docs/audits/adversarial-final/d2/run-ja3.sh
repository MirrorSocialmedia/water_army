#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
python3 ja3-parse.py ja3-capture.pcap 443 > ja3-443.txt 2> ja3-443.err
head -2 ja3-443.err
cat ja3-443.txt | head -60
