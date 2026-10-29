#!/usr/bin/env python3
"""D1-6 cross-device uniqueness matrix: android_id / MAC / 12 ro.* props (UA appended from browser phase)."""
import re

D1 = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1"
DEV = ["a1", "a2", "a3", "a4"]
PROPS = ["ro.product.brand", "ro.product.manufacturer", "ro.product.model", "ro.product.device",
         "ro.product.name", "ro.build.id", "ro.build.display.id", "ro.build.fingerprint",
         "ro.serialno", "persist.sys.timezone", "ro.hardware", "ro.boot.hardware"]

def getprops(dev):
    props = {}
    for line in open(f"{D1}/getprop-{dev}.txt"):
        m = re.match(r"^\[([^\]]+)\]:\s*\[(.*)\]\s*$", line)
        if m: props[m.group(1)] = m.group(2)
    return props

vals = {}  # key -> {dev: value}
for d in DEV:
    p = getprops(d)
    vals["android_id"] = dict(list(vals.get("android_id", {}).items()) + [(d, open(f"{D1}/androidid-{d}.txt").read().strip())])
    mac = re.search(r"link/ether ([0-9a-f:]+)", open(f"{D1}/iplink-{d}.txt").read())
    vals["MAC(eth0)"] = dict(list(vals.get("MAC(eth0)", {}).items()) + [(d, mac and mac.group(1))])
    for k in PROPS:
        vals.setdefault(k, {})[d] = p.get(k, "")

print(f"{'field':28s} " + " | ".join(DEV) + "  unique?")
all_unique = True
for k, per in vals.items():
    uniq = len(set(per.values())) == len(DEV)
    all_unique &= uniq
    print(f"{k:28s} " + " | ".join(str(per[d])[:24] for d in DEV) + f"  {'YES' if uniq else 'NO — SHARED!'}")
print(f"\n=> fields checked: {len(vals)}; pairwise-uniqueness all: {'PASS' if all_unique else 'FAIL'}")
