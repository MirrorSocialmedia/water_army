#!/usr/bin/env python3
"""aid-page-check.py — hard page-state evidence for register-aid.sh (EXP-1).

EXP-1 confirmed the size/stability heuristic passes on a WHITE screen, so
success/failure used to be decided by vibes. This checker reads the actual
rendered pixels (uiautomator is blind to this WebView — gotcha ②) and fails
loudly on two hard conditions:

  nonblank <png>          exit 0 iff the frame has real content:
                          non-white pixel ratio >= --min-nonwhite (default 0.003)
                          AND quantized-color count >= --min-colors (default 4).
                          A pure-white / single-solid-colour frame exits 1.

  changed <a.png> <b.png> exit 0 iff the pages actually TRANSITIONED:
                          fraction of sampled pixels differing > --delta
                          (default 16/channel) >= --min-changed (default 0.004)
                          AND neither frame is blank. Same-page (submit did
                          nothing) and white-screen both exit 1.

Every invocation prints machine-readable metrics lines first — they go into
the evidence dir via the shell wrapper, so operator review sees the numbers,
not just an exit code. Zero network, zero Google libs, deterministic.
"""
import argparse
import sys

from PIL import Image

STEP = 4  # sample 1 of every 4 px per axis (~6% of pixels; 720p → ~32k samples)


def _sample(path):
    im = Image.open(path)
    im.thumbnail((1024, 1024))  # deterministic downscale bound; content kept
    px = im.convert("RGB").load()
    w, h = im.size
    pts = [(x, y) for y in range(0, h, STEP) for x in range(0, w, STEP)]
    return px, pts


def metrics(path):
    px, pts = _sample(path)
    nonwhite = 0
    colors = set()
    for (x, y) in pts:
        r, g, b = px[x, y]
        if r + g + b < 720:  # darker than #D8D8D8-ish → not blank background
            nonwhite += 1
        colors.add((r >> 4, g >> 4, b >> 4))
    n = len(pts)
    return {"png": path, "samples": n, "nonwhite_ratio": nonwhite / n, "colors": len(colors)}


def is_blank(m, min_nonwhite, min_colors):
    return m["nonwhite_ratio"] < min_nonwhite or m["colors"] < min_colors


def cmd_nonblank(a):
    m = metrics(a.png)
    blank = is_blank(m, a.min_nonwhite, a.min_colors)
    print(f"nonblank png={a.png} samples={m['samples']} nonwhite_ratio={m['nonwhite_ratio']:.5f} "
          f"colors={m['colors']} min_nonwhite={a.min_nonwhite} min_colors={a.min_colors} blank={int(blank)}")
    return 1 if blank else 0


def _size(path):
    im = Image.open(path)
    im.thumbnail((1024, 1024))
    return im.size


def cmd_changed(a):
    ma, mb = metrics(a.a), metrics(a.b)
    pa, ptsa = _sample(a.a)
    pb, _ = _sample(a.b)
    # _sample thumbnails both identically → same grid; compare pairwise
    if _size(a.a) != _size(a.b):
        print(f"changed error: frame size mismatch {a.a}{pa.size} vs {a.b}{pb.size}")
        return 1
    diff = 0
    for (x, y) in ptsa:
        ra, ga, ba_ = pa[x, y]
        rb, gb, bb = pb[x, y]
        if abs(ra - rb) > a.delta or abs(ga - gb) > a.delta or abs(ba_ - bb) > a.delta:
            diff += 1
    ratio = diff / len(ptsa)
    blank_a = is_blank(ma, a.min_nonwhite, a.min_colors)
    blank_b = is_blank(mb, a.min_nonwhite, a.min_colors)
    ok = (not blank_a) and (not blank_b) and ratio >= a.min_changed
    print(f"changed a={a.a} b={a.b} changed_ratio={ratio:.5f} min_changed={a.min_changed} "
          f"nonwhite_a={ma['nonwhite_ratio']:.5f} nonwhite_b={mb['nonwhite_ratio']:.5f} "
          f"colors_b={mb['colors']} blank_a={int(blank_a)} blank_b={int(blank_b)} ok={int(ok)}")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("nonblank")
    n.add_argument("png")
    n.add_argument("--min-nonwhite", type=float, default=0.003)
    n.add_argument("--min-colors", type=int, default=4)
    n.set_defaults(fn=cmd_nonblank)
    c = sub.add_parser("changed")
    c.add_argument("a")
    c.add_argument("b")
    c.add_argument("--min-nonwhite", type=float, default=0.003)
    c.add_argument("--min-colors", type=int, default=4)
    c.add_argument("--delta", type=int, default=16)
    c.add_argument("--min-changed", type=float, default=0.004)
    c.set_defaults(fn=cmd_changed)
    a = ap.parse_args()
    try:
        sys.exit(a.fn(a))
    except SystemExit:
        raise
    except Exception as e:  # broken environment (bad png, missing file…): exit 2 ≠ check-fail 1
        print(f"checker-error: {type(e).__name__}: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
