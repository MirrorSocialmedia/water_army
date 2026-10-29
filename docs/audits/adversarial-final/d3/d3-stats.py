#!/usr/bin/env python3
# D3 stats: zero-overlap timeline (from psql timeline.csv) + stagger gaps + behavior distributions.
import csv, statistics as st
from datetime import datetime

def ts(x):
    return datetime.fromisoformat(x.replace('Z', '+00:00')) if x else None

rows = []
with open('timeline.csv') as f:
    for r in csv.DictReader(f):
        r['sT'] = ts(r['started_at']); r['fT'] = ts(r['finished_at'])
        rows.append(r)
print('runs in timeline:', len(rows))

def group_report(gname):
    rs = [r for r in rows if r['grp'] == gname and r['sT']]
    print(f'== group {gname}: {len(rs)} runs ==')
    maxov = 0.0; pairs = 0; overlaps = []
    for i in range(len(rs)):
        for j in range(i + 1, len(rs)):
            a, b = rs[i], rs[j]
            d = min(a['fT'], b['fT']) - max(a['sT'], b['sT'])
            d = d.total_seconds()
            pairs += 1
            if d > 0:
                overlaps.append((a['batch'], b['batch'], d)); maxov = max(maxov, d)
    print(f'  pairs={pairs} max_overlap={maxov:.3f}s -> ZERO_OVERLAP={"PASS" if maxov <= 0 else "FAIL"}')
    for o in overlaps[:6]: print('   OVERLAP', o[0], 'x', o[1], f'{o[2]:.1f}s')
    ordered = sorted(rs, key=lambda r: r['sT'])
    vals = []
    print('  adjacent gaps (prev finish -> next start), jitter window [60,300]s:')
    for i in range(1, len(ordered)):
        g = (ordered[i]['sT'] - ordered[i-1]['fT']).total_seconds()
        ok = 'ok' if 60 <= g <= 300 else 'OUT-OF-RANGE'
        print(f"    {ordered[i-1]['ident'][15:]}/{ordered[i-1]['batch'][-2:]} -> {ordered[i]['ident'][15:]}/{ordered[i]['batch'][-2:]}: {g:7.1f}s {ok}")
        vals.append(g)
    inr = [g for g in vals if 60 <= g <= 300]
    if vals:
        print(f'  gaps in [60,300]s: {len(inr)}/{len(vals)} mean={st.mean(vals):.1f}s min={min(vals):.1f} max={max(vals):.1f}')
        bins = {}
        for g in vals:
            k = int(g // 60) * 60
            bins[k] = bins.get(k, 0) + 1
        for k in sorted(bins):
            print(f'    {k:3d}-{k+59:3d}s: ' + '#' * bins[k])
    return rs

e1 = group_report('adv-e1')
e2 = group_report('adv-e2')
if e1 and e2:
    print('== cross-group parallelism (D3-2) ==')
    hits = 0
    for a in e2:
        for b in e1:
            ov = min(a['fT'], b['fT']) - max(a['sT'], b['sT'])
            d = ov.total_seconds()
            if d > 0:
                hits += 1
                print(f"  OVERLAP {a['ident'][15:]} x {b['ident'][15:]}: {d:.1f}s")
    print(f'  concurrent e1/e2 run-pairs: {hits} -> CROSS_GROUP_PARALLEL={"PASS" if hits > 0 else "NOT PROVEN"}')

def dist(fname, prefix):
    data = {}
    try: lines = open(fname).readlines()
    except FileNotFoundError: return
    for ln in lines:
        p = ln.split()
        if not p or p[0] != prefix: continue
        for tok in p[2:]:
            tok = tok.split('(')[0]
            kv = tok.split('=')
            if len(kv) == 2:
                try: data.setdefault(kv[0], []).append(float(kv[1]))
                except ValueError: pass
    print(f'== {fname} ({prefix}) ==')
    for k, v in sorted(data.items()):
        if len(v) < 2: continue
        m, sd = st.mean(v), st.pstdev(v)
        cv = sd / m if m else 0
        w1 = sum(1 for x in v if abs(x - m) <= sd) / len(v)
        print(f'  {k:12s} n={len(v):2d} mean={m:.3f}s sd={sd:.3f} min={min(v):.3f} max={max(v):.3f} CV={cv:.3f} within1sd={w1:.0%}')

dist('behavior.log', 'PROD')
dist('humanref.log', 'HUMANREF')
