#!/usr/bin/env python3
"""WA-VMSTEALTH (S1 §1.4 ruling (a)): fail-closed in-place C-string patcher.

Replaces ONE NUL-terminated literal in a binary with a SHORTER-or-equal
replacement, NUL-padded in place — zero layout change (no offsets, no table
growth, no relocation), so the worst case of a wrong guess is cosmetic,
never a boot loop. The search string must appear EXACTLY `count` times
(default 1) or the script exits non-zero (fail closed: a base-image drift
that silently renames/derenders the target must break the build loudly).

Usage: patch_llvmpipe_name.py <file> <old-literal> <new-literal> [count]
"""
import sys


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    path, old, new = sys.argv[1], sys.argv[2].encode(), sys.argv[3].encode()
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    if len(new) > len(old):
        print(f'PATCH REJECTED: replacement longer than original ({len(new)} > {len(old)})', file=sys.stderr)
        return 1
    with open(path, 'rb') as f:
        data = bytearray(f.read())
    needle = old + b'\x00'  # exact NUL-terminated literal — no prefix collisions
    pos, hits = 0, 0
    while True:
        i = data.find(needle, pos)
        if i < 0:
            break
        hits += 1
        pos = i + 1
    if hits != count:
        print(f'PATCH REJECTED: found {hits} occurrences of {old!r} (want exactly {count})', file=sys.stderr)
        return 1
    patch = new + b'\x00' * (len(needle) - len(new) - 1) + b'\x00'  # same length, NUL-padded
    pos = 0
    while True:
        i = data.find(needle, pos)
        if i < 0:
            break
        data[i:i + len(needle)] = patch
        pos = i + len(needle)
    with open(path, 'wb') as f:
        f.write(data)
    print(f'patched {hits}x {old!r} -> {new!r} in {path} (file size unchanged: {len(data)} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
