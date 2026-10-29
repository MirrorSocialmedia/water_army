#!/bin/bash
# D2-2 egress drift probe: every 120s through e1(18443)/e2(18444) socks5 (bridge gw 172.38.223.1)
cd "$(dirname "$0")"
while true; do
  ts=$(date -Is)
  i1=$(curl -s --max-time 15 --socks5-hostname 172.38.223.1:18443 https://ipinfo.io/ip 2>/dev/null)
  i2=$(curl -s --max-time 15 --socks5-hostname 172.38.223.1:18444 https://ipinfo.io/ip 2>/dev/null)
  echo "$ts,e1,$i1" >> drift-probe.csv
  echo "$ts,e2,$i2" >> drift-probe.csv
  sleep 120
done
