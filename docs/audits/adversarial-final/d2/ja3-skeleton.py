#!/usr/bin/env python3
"""Skeleton comparison of Chromium-family flows (16-cipher) in device windows:
cipher list identical? ext skeleton identical modulo GREASE/ECH noise?"""
import re
lines = open('ja3-443.txt').read().splitlines()
flows = []
cur = None
for ln in lines:
    m = re.match(r'JA3=(\w{32}) JA4=(\S+) ALPN=(\w+) sni=(\S+) ver=(\S+) ciphers=(\d+) exts=(\d+)', ln)
    if m:
        cur = m.groups(); flows.append({'ja3': m.group(1), 'n': int(m.group(6)), 'ja3str': None}); continue
    m2 = re.match(r'\s+flow \((.*)\) ts= (\S+)', ln)
    if m2 and flows and flows[-1]['ja3str'] is None:
        flows[-1]['flow'] = m2.group(1); flows[-1]['ts'] = m2.group(2); continue
    m3 = re.match(r'\s+ja3str= (.*)', ln)
    if m3 and flows: flows[-1]['ja3str'] = m3.group(1)

DEV_WIN = [('a1', '19:11:4', 60), ('a1', '19:11:5', 2), ('a2', '19:12:0', 4), ('a3', '19:12:1', 8), ('a3', '19:12:2', 99), ('a4', '19:12:3', 99)]
def dev_of(ts):
    t = ts.split('T')[1][:8]
    from datetime import datetime
    tt = datetime.strptime(t, '%H:%M:%S')
    wins = [('a1', '19:11:44', '19:11:58'), ('a2', '19:11:59', '19:12:14'), ('a3', '19:12:15', '19:12:30'), ('a4', '19:12:31', '19:12:44')]
    for d, a, b in wins:
        if datetime.strptime(a, '%H:%M:%S') <= tt <= datetime.strptime(b, '%H:%M:%S'):
            return d
    return '?'

chrom = [f for f in flows if f['n'] == 16 and f.get('ts')]
for f in chrom:
    parts = f['ja3str'].split(',')
    exts = parts[1].split('-'); ciphers = parts[2].split('-'); pfs = parts[3]; curves = parts[4]
    def strip_grease(xs):
        out = []
        for x in xs:
            v = int(x)
            n = v & 0xF
            if v <= 0xFFFF and n >= 0xA and (v >> 4) & 0xF == n and (v >> 8) & 0xF == n and (v >> 12) & 0xF == n: continue  # nibble-grease 0x?a?a
            out.append(x)
        return sorted(out, key=lambda x: (len(x), x)), out
    e_sorted, e_clean = strip_grease(exts)
    c_sorted, c_clean = strip_grease(ciphers)
    f['dev'] = dev_of(f['ts'])
    f['ext_clean'] = ','.join(e_clean); f['ciph_clean'] = ','.join(c_clean)
    f['ext_noise'] = len(exts) - len(e_clean)
print(f"Chromium-family flows: {len(chrom)}")
for f in chrom:
    print(f"dev={f['dev']} ts={f['ts'][11:19]} ja3={f['ja3']} grease_exts={f['ext_noise']}")
    print(f"   ext_clean={f['ext_clean']}")
    print(f"   ciph_clean={f['ciph_clean']}")
sigs = {}
for f in chrom:
    sigs.setdefault((f['ext_clean'], f['ciph_clean']), []).append(f['dev'])
print('skeleton signatures:', {str(k)[:60] + '...': v for k, v in sigs.items()} if len(sigs) > 1 else {list(sigs.keys())[0]: list(sigs.values())[0]})
