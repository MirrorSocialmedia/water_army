#!/usr/bin/env python3
"""WA-FIXALL S2 — minimal Android binary XML (AXML) reader.
Usage: python3 s2_axml.py <AndroidManifest.xml>
Prints JSON: {package, versionCode, versionName, minSdk, targetSdk, permissions:[...], features:[...]}
Handles aapt1 resource table XML (string pool UTF-16/UTF-8, element chunks with typed attributes)."""
import sys, struct, json

def parse_pool(data, off):
    # RES_STRING_POOL_TYPE 0x0001
    hdr_type, hdr_size, chunk_size = struct.unpack_from('<HHI', data, off)
    str_count, style_count, flags, str_start, style_start = struct.unpack_from('<IIIII', data, off + 8)
    is_utf8 = bool(flags & (1 << 8))
    strings = []
    p = off + 28 + str_start  # str_start is relative to the stringsStart field (end of 28-byte header)
    for i in range(str_count):
        if is_utf8:
            n1 = data[p]; p += 1
            n2 = data[p]; p += 1
            if n1 & 0x80:
                n1 = ((n1 & 0x7F) << 8) | data[p]; p += 1
            if n2 & 0x80:
                n2 = ((n2 & 0x7F) << 8) | data[p]; p += 1
            s = data[p:p + n2].decode('utf-8', 'replace'); p += n2 + 1
        else:
            n = struct.unpack_from('<H', data, p)[0]; p += 2
            if n & 0x8000:
                n = ((n & 0x7FFF) << 16) | struct.unpack_from('<H', data, p)[0]; p += 2
            s = data[p:p + n * 2].decode('utf-16-le', 'replace'); p += n * 2 + 2
        strings.append(s)
    return strings

def walk(data, off, strings, out):
    hdr_type, hdr_size, chunk_size = struct.unpack_from('<HHI', data, off)
    if hdr_type == 0x0102:  # START_ELEMENT
        attr_count = struct.unpack_from('<H', data, off + 16)[0]
        name_idx = struct.unpack_from('<I', data, off + hdr_size - 4)[0] if False else None
        # element header: after RES_CHUNK_HEADER(8)+NODE_HEADER(ns,idx,name, 12B? layout):
        # NODE_HEADER: ns(4) name(4); then attrStart(2) attrSize(2) attrCount(2) attrIdx(2) inputAttr(4)
        base = off + 8
        ns, name = struct.unpack_from('<II', data, base)
        astart, asize, acount = struct.unpack_from('<HHH', data, base + 12)
        attrs = {}
        for i in range(acount):
            ap = base + 8 + (astart or 16) + i * (asize or 20)  # attrExtStart + attributeStart + i*size
            ans, aname, araw = struct.unpack_from('<III', data, ap)
            vsize, vres, vtype = struct.unpack_from('<HBB', data, ap + 12)
            dataoff = struct.unpack_from('<I', data, ap + 16)[0]
            val = None
            if vtype == 0x03 and dataoff and dataoff < len(strings):  # STRING
                val = strings[dataoff]
            elif vtype in (0x10, 0x11):  # INT_DEC / INT_HEX
                val = struct.unpack_from('<I', data, ap + 16)[0]
            key = strings[aname] if (aname and aname < len(strings)) else f'attr{ans:x}:{aname:x}'
            attrs[key] = val
        out.append((strings[name] if (name and name < len(strings)) else f'tag{name}', attrs))
    return chunk_size

def main(path):
    data = open(path, 'rb').read()
    # top: RES_XML_TYPE 0x0003 — chunk header is 8 bytes; string pool follows at 8
    off_pool = 8
    strings = parse_pool(data, off_pool)
    hdr_type, hdr_size, chunk_size = struct.unpack_from('<HHI', data, off_pool)
    off = off_pool + chunk_size
    elems = []
    while off + 8 <= len(data):
        ht, hs, cs = struct.unpack_from('<HHI', data, off)
        if ht == 0x0104:  # END_DOCUMENT
            break
        if cs == 0:
            break
        walk(data, off, strings, elems)
        off += cs
    res = {'package': None, 'versionCode': None, 'versionName': None,
           'minSdk': None, 'targetSdk': None, 'permissions': [], 'features': []}
    for tag, at in elems:
        if tag == 'manifest':
            for k, v in at.items():
                kk = k.split(':')[-1] if ':' in k else k
        for k, v in list(at.items()):
            pass
        if tag == 'uses-permission':
            n = at.get('name')
            if n:
                res['permissions'].append(n)
        if tag == 'uses-feature':
            n = at.get('name')
            if n:
                res['features'].append(n)
        if tag == 'uses-sdk':
            res['minSdk'] = at.get('minSdkVersion')
            res['targetSdk'] = at.get('targetSdkVersion')
        # manifest element carries package/version attrs (as plain names)
        for kk, v in at.items():
            base_k = kk.rsplit(':', 1)[-1]
            if base_k == 'package' and tag == 'manifest':
                res['package'] = v
            if base_k == 'versionCode' and tag == 'manifest':
                res['versionCode'] = v
            if base_k == 'versionName' and tag == 'manifest':
                res['versionName'] = v
    print(json.dumps(res, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main(sys.argv[1])
