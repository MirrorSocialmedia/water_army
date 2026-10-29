#!/usr/bin/env python3
"""D1-1 fingerprint 12/12 comparison + full-table leak scan (p1-09 calibre).
Usage: d1-fp-compare.py <dev>  (reads getprop-<dev>.txt + profile-<dev>.json)"""
import json, re, sys

dev = sys.argv[1]
D1 = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1"

props = {}
for line in open(f"{D1}/getprop-{dev}.txt"):
    m = re.match(r"^\[([^\]]+)\]:\s*\[(.*)\]\s*$", line)
    if m:
        props[m.group(1)] = m.group(2)

prof = json.load(open(f"{D1}/profile-{dev}.json"))
while isinstance(prof, dict) and "profile" in prof and isinstance(prof["profile"], dict):
    prof = prof["profile"]
if "profileJson" in prof: prof = prof["profileJson"]

TARGETS = [
    ("ro.product.brand", "brand"),
    ("ro.product.manufacturer", "manufacturer"),
    ("ro.product.model", "model"),
    ("ro.product.device", "device"),
    ("ro.product.name", "productName"),
    ("ro.build.id", "buildId"),
    ("ro.build.display.id", "displayId"),
    ("ro.build.fingerprint", "fingerprint"),
    ("ro.serialno", "serial"),
    ("persist.sys.timezone", "timezone"),
    ("ro.hardware", "hardware"),
    ("ro.boot.hardware", "hardware"),
]

ok = 0
for prop, field in TARGETS:
    got = props.get(prop, "<absent>")
    exp = prof.get(field, "<no-field>")
    mark = "OK " if got == exp else "FAIL"
    ok += got == exp
    print(f"{mark} {prop}: got={got!r} exp({field})={exp!r}")
print(f"=> {ok}/12 (profile fields present: {sorted(set(f for _, f in TARGETS) & set(prof.keys()))})")

print("\n=== leak scan: redroid|goldfish|ranchu|emulator (case-insensitive, full table) ===")
pat = re.compile(r"redroid|goldfish|ranchu|emulator", re.I)
hits = [(k, v) for k, v in props.items() if pat.search(k) or pat.search(v)]
for k, v in sorted(hits):
    print(f"LEAK {k} = {v!r}")
print(f"=> {len(hits)} leak line(s) of {len(props)} props")
print("\nro.hardware =", props.get("ro.hardware"), "| ro.boot.hardware =", props.get("ro.boot.hardware"))
