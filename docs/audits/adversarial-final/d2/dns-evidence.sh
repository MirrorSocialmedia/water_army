#!/bin/bash
cd /home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d2
ADB=/home/kenneth/.local/share/platform-tools/adb
: > dns-resolvers.txt
for spec in "a1 15000" "a2 15001" "a3 15002" "a4 15003"; do
  set -- $spec
  echo "-- $1" >> dns-resolvers.txt
  $ADB -s 127.0.0.1:$2 shell "dumpsys connectivity | grep -iE \"Dns:\\|dns_servers\" | head -4" | tr -d "\r" | sed "s/^/   /" >> dns-resolvers.txt
done
# UDP/53 path sample (host view)
docker run --rm --net=host --privileged alpine:3.20 sh -c "apk add --no-cache tcpdump >/dev/null 2>&1; timeout 25 tcpdump -i any -nn -c 40 udp port 53" > dns-udp53-sample.txt 2>&1
head -20 dns-udp53-sample.txt
