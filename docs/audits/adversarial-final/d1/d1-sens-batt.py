#!/usr/bin/env python3
"""D1-3 sensorservice two-sample diff + D1-4 battery two-sample diff."""
import re, sys

D1 = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1"
DEV = ["a1", "a2", "a3", "a4"]

def sensor_lines(path):
    """Return {sensor_name: [numeric values found in 'sensors event' / value lines]}"""
    vals = {}
    cur = None
    for ln in open(path):
        m = re.match(r"^\s*(\d+)\s+-+\s+(\S.*)$", ln)  # dumpsys sensorservice list line: idx --- name
        if m:
            cur = m.group(2).strip()
        m2 = re.search(r"\[(-?\d+\.\d+),\s*(-?\d+\.\d+)(?:,\s*(-?\d+\.\d+))?\]", ln)
        if m2 and cur:
            vals.setdefault(cur, []).append(tuple(float(g) for g in m2.groups() if g is not None))
    return vals

print("=== D1-3 sensorservice: accel/gyro presence + two-sample numeric diff ===")
for d in DEV:
    s1 = sensor_lines(f"{D1}/sensors-{d}-s1.txt")
    s2 = sensor_lines(f"{D1}/sensors-{d}-s2.txt")
    accel = [k for k in s1 if re.search(r"accelerometer|Accelerometer", k, re.I)]
    gyro = [k for k in s1 if re.search(r"gyro", k, re.I)]
    print(f"[{d}] accel sensors: {accel} | gyro sensors: {gyro}")
    for k in accel + gyro:
        v1, v2 = s1.get(k, []), s2.get(k, [])
        n = min(len(v1), len(v2))
        if n == 0:
            print(f"    {k}: values s1={v1[:2]} s2={v2[:2]} (event-rate capture; no paired diff)")
            continue
        diffs = [abs(a - b) for a, b in zip(v1[:n], v2[:n])]
        mx = max(diffs) if diffs else 0
        print(f"    {k}: paired samples={n} max|delta|={mx:.6f} nonzero={sum(1 for x in diffs if x > 0)}/{n}")

print()
print("=== D1-4 battery: level/status two-sample ===")
for d in DEV:
    for tag in ("s1", "s2"):
        txt = open(f"{D1}/battery-{d}-{tag}.txt").read()
        lvl = re.search(r"level:\s*(\d+)", txt)
        st = re.search(r"status:\s*(\d+)", txt)
        volt = re.search(r"voltage:\s*(\d+)", txt)
        tmp = re.search(r"temperature:\s*(\d+)", txt)
        print(f"[{d}-{tag}] level={lvl and lvl.group(1)} status={st and st.group(1)} voltage={volt and volt.group(1)} temp={tmp and tmp.group(1)}")
