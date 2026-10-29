#!/usr/bin/env python3
"""JA3/JA4 from pcap: parse TCP streams (Linux SLL), extract TLS ClientHello,
compute JA3 (MD5) and JA4 per spec (GREASE removed). Prints per-flow record.
Usage: python3 ja3-parse.py <pcap> [dport-filter e.g. 7897]"""
import sys, hashlib, struct
from collections import defaultdict

def is_grease(v):
    if v > 0xFFFF: return False
    n = v & 0xF
    return n >= 0xA and (v >> 4) & 0xF == n and (v >> 8) & 0xF == n and (v >> 12) & 0xF == n

def parse_pcap(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic = data[:4]
    endian = '<' if magic[:2] == b'\xd4\xc3' else '>'
    if magic not in (b'\xd4\xc3\xb2\xa1', b'\xa1\xb2\xc3\xd4'):
        sys.exit(f'not a classic pcap (magic={magic.hex()}) — pcapng? use -W classic')
    ver, _, _, _, snaplen, network = struct.unpack(endian + 'HHiIHH', data[4:24][0:2] + (0,) + struct.unpack(endian + 'i', data[8:12]) + (snaplen := 0, 0)[:0] + (0,)) if False else (0, 0, 0, 0, 0, struct.unpack(endian + 'I', data[20:24])[0])
    off = 24
    while off + 16 <= len(data):
        ts_s, ts_us, caplen, origlen = struct.unpack(endian + 'IIII', data[off:off + 16])
        off += 16
        pkt = data[off:off + caplen]
        off += caplen
        yield network, pkt, ts_s + ts_us / 1e6

def tcp_payloads(packets, dport_filter=None):
    """returns streams dict (client_ip,client_port,server_ip,server_port) -> ordered bytes (c2s only)"""
    streams = defaultdict(list)
    for dlt, pkt, ts in packets:
        l3off = 0
        if dlt == 113:  # SLL
            if len(pkt) < 14: continue
            eth_proto = pkt[14] << 8 | pkt[15] if False else int.from_bytes(pkt[14:16], 'big')
            l3off = 16
        elif dlt == 1:  # EN10MB
            if len(pkt) < 14: continue
            eth_proto = int.from_bytes(pkt[12:14], 'big')
            l3off = 14
        else:
            continue
        if eth_proto != 0x0800: continue
        ip = pkt[l3off:]
        if len(ip) < 20 or (ip[0] >> 4) != 4: continue
        ihl = (ip[0] & 0xF) * 4
        proto = ip[9]
        if proto != 6: continue
        src = '.'.join(str(b) for b in ip[12:16]); dst = '.'.join(str(b) for b in ip[16:20])
        ip_total = ip[2] << 8 | ip[3]
        frag_off = (ip[6] << 8 | ip[7]) & 0x1FFF
        if frag_off: continue
        tcp = ip[ihl:]
        if len(tcp) < 20: continue
        sp = tcp[0] << 8 | tcp[1]; dp = tcp[2] << 8 | tcp[3]
        doff = (tcp[12] >> 4) * 4
        seq = int.from_bytes(tcp[4:8], 'big')
        payload = tcp[doff:ip_total - ihl]
        if not payload: continue
        if dport_filter and dp not in dport_filter: continue
        streams[(src, sp, dst, dp)].append((seq, payload, ts))
    return {k: (merge([c[:2] for c in v]), min(x[2] for x in v)) for k, v in streams.items()}

def merge(chunks):
    if not chunks: return b''
    chunks.sort(key=lambda x: x[0])
    out = bytearray()
    base = chunks[0][0]
    for seq, p in chunks:
        pos = seq - base
        if pos < 0: continue
        if pos + len(p) > len(out):
            out.extend(b'\x00' * (pos + len(p) - len(out)))
        out[pos:pos + len(p)] = p
    return bytes(out)

def parse_clienthello(buf):
    """return dict or None; buf = c2s stream bytes"""
    idx = buf.find(b'\x16\x03')
    if idx < 0: idx = buf.find(b'\x17\x03')
    if idx < 0 or idx + 5 > len(buf): return None
    rec_len = int.from_bytes(buf[idx + 3:idx + 5], 'big')
    hs = buf[idx + 5:idx + 5 + rec_len]
    if len(hs) < 4 or hs[0] != 0x01: return None
    hs_len = int.from_bytes(hs[1:4], 'big')
    body = hs[4:4 + hs_len]
    if len(body) < 38: return None
    version = int.from_bytes(body[0:2], 'big')
    # skip random 32 + session id
    off = 2 + 32
    sid = body[off]; off += 1 + sid
    cs_len = int.from_bytes(body[off:off + 2], 'big'); off += 2
    ciphers = []
    for i in range(0, cs_len, 2):
        v = int.from_bytes(body[off + i:off + i + 2], 'big')
        if not is_grease(v): ciphers.append(v)
    off += cs_len
    comp_len = body[off]; off += 1 + comp_len
    if off + 2 > len(body): return None
    ext_len = int.from_bytes(body[off:off + 2], 'big'); off += 2
    exts = []
    alpn = None; sni = None
    end = off + ext_len
    while off + 4 <= min(end, len(body)):
        et = int.from_bytes(body[off:off + 2], 'big'); el = int.from_bytes(body[off + 2:off + 4], 'big')
        ed = body[off + 4:off + 4 + el]
        off += 4 + el
        if is_grease(et): continue
        exts.append(et)
        if et == 0 and len(ed) >= 5:  # SNI
            try: sni = ed[5:5 + int.from_bytes(ed[3:5], 'big')].decode('idna')
            except Exception: sni = '?'
        if et == 16 and len(ed) >= 2:  # ALPN
            try:
                al = int.from_bytes(ed[0:2], 'big'); p0 = ed[2 + 1:2 + 1 + ed[2]]
                alpn = p0.decode('latin1')
            except Exception: alpn = None
    if not exts: return None
    # point formats & curves inside exts data — re-scan for 11 (ec_point_formats) and 10 (supported_groups)
    return {'version': version, 'ciphers': ciphers, 'exts': exts, 'sni': sni, 'alpn': alpn, 'raw': buf}

def find_ext_data(p, et):
    body = p['raw']; i = body.find(b'\x16\x03')
    rec_len = int.from_bytes(body[i + 3:i + 5], 'big'); hs = body[i + 5:i + 5 + rec_len]
    b = hs[4:4 + int.from_bytes(hs[1:4], 'big')]
    off = 2 + 32; sid = b[off]; off += 1 + sid
    cs_len = int.from_bytes(b[off:off + 2], 'big'); off += 2 + cs_len
    comp_len = b[off]; off += 1 + comp_len
    ext_len = int.from_bytes(b[off:off + 2], 'big'); off += 2
    end = off + ext_len
    while off + 4 <= end:
        e = int.from_bytes(b[off:off + 2], 'big'); el = int.from_bytes(b[off + 2:off + 4], 'big')
        d = b[off + 4:off + 4 + el]; off += 4 + el
        if e == et: return d
    return None

def ja3(p):
    exts = '-'.join(map(str, sorted(p['exts'])))
    cs = '-'.join(map(str, p['ciphers']))
    pf = find_ext_data(p, 11)
    pfs = '-'.join(str(x) for x in pf[1:1 + pf[0]]) if pf else '0-1-2'
    cg = find_ext_data(p, 10)
    if cg:
        n = int.from_bytes(cg[0:2], 'big')
        curves = '-'.join(str(int.from_bytes(cg[2 + i:4 + i], 'big')) for i in range(0, n, 2))
    else:
        curves = '29-30-23'
    s = f"{p['version']},{exts},{cs},{pfs},{curves}"
    return s, hashlib.md5(s.encode()).hexdigest()

def ja4(p):
    vmap = {0x0304: '13', 0x0303: '12', 0x0302: '11', 0x0301: '10', 0x0300: 's0', 0x0303: '12'}
    ver = vmap.get(p['version'], '??')
    proto = 't'
    sni = 'i' if p['sni'] else 'n'
    snilen = min(len(p['sni'] or ''), 255)
    a = f"{proto}{ver}{sni}{snilen:03d}"
    cs_sorted = sorted(p['ciphers'])
    cs_hex = '_'.join(f'{c:04x}' for c in cs_sorted)
    b12 = hashlib.sha256(cs_hex.encode()).hexdigest()[:12]
    ext_sorted = sorted(p['exts'])
    ext_hex = '_'.join(f'{e:04x}' for e in ext_sorted)
    c12 = hashlib.sha256(ext_hex.encode()).hexdigest()[:12]
    alpn = '000'
    if p['alpn']:
        al = p['alpn']
        if len(al) >= 2: alpn = al[0] + al[-1] + (al[1] if len(al) > 2 else '0')
        else: alpn = al[0] + '00'
    return f"{a}_{b12}_{c12}", alpn

def main():
    path = sys.argv[1]
    dports = set(int(x) for x in sys.argv[2:]) or None
    streams = tcp_payloads(parse_pcap(path), dports)
    seen = {}
    for key, (buf, first_ts) in streams.items():
        p = parse_clienthello(buf)
        if not p: continue
        s, h = ja3(p)
        j4, alpn = ja4(p)
        ipver = 'quic-ish' if p['version'] == 0 else 'tls'
        k = (h, j4, p['sni'], alpn, p['version'], len(p['ciphers']), len(p['exts']))
        seen.setdefault(k, []).append((key, first_ts, s))
    for k, flows in sorted(seen.items(), key=lambda x: -len(x[1])):
        h, j4, sni, alpn, ver, nc, ne = k
        print(f"JA3={h} JA4={j4} ALPN={alpn} sni={sni} ver={hex(ver)} ciphers={nc} exts={ne} flows={len(flows)}")
        for f, t, sstr in flows[:8]:
            import datetime
            print('   flow', f, 'ts=', datetime.datetime.fromtimestamp(t).isoformat())
            print('   ja3str=', sstr[:160])
    print(f"total clienthello flows: {sum(len(v) for v in seen.values())} / streams {len(streams)}")

if __name__ == '__main__':
    main()
