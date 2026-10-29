#!/usr/bin/env node
/**
 * WA-FIX2B (R2b) — stealth3b cstr patch driver (regenerates the layer
 * in-place from the extracted base libgallium_dri.so; fail closed).
 *
 * Ops (proven on redroid-rdev-fx-2, bisect r1..r8, 2026-10-29):
 *  1. renderer suffix  '%s (radeonsi, %s%s, DRM %i.%i%s)' -> '%s'
 *  2. GL_VERSION fmt   '%s%u.%u%s Mesa 24.0.8 (git-441f064c1c)' -> '%s%u.%u%s V@0615'
 *  3. vendor 'AMD' -> 'IMG' on the 129 standalone NUL-terminated exact cstrs
 *     EXCLUDING the functional gate token at file offset GATE_OFF (stays AMD;
 *     renaming it kills every WebView ES2 context — see Dockerfile).
 *
 * Zero layout change (NUL-pad in place; file size fixed).
 * Usage: patch-ops.mjs <file>
 */
import fs from 'node:fs';

const GATE_OFF = 1917602; // proven 2026-10-29: the DRI-dispatch 'AMD' token
const REPL = 'IMG';
const FMT = [
  ['%s (radeonsi, %s%s, DRM %i.%i%s)', '%s'],
  ['%s%u.%u%s Mesa 24.0.8 (git-441f064c1c)', '%s%u.%u%s V@0615'],
];
const file = process.argv[2];
if (!file) { console.error('usage: patch-ops.mjs <file>'); process.exit(2); }
const d = fs.readFileSync(file);
const size = d.length;

function cstrAt(off) { let e = off; while (e < d.length && d[e] !== 0) e++; return d.subarray(off, e).toString('latin1'); }
function findFmt(s) { const i = d.indexOf(Buffer.from(s, 'latin1')); if (i < 0) throw new Error('fmt not found: ' + s); if (d[i + s.length] !== 0) throw new Error('fmt not NUL-terminated: ' + s); return i; }
function patchFmt(off, repl) {
  const orig = cstrAt(off);
  if (repl.length > orig.length + 1) throw new Error('repl longer than original at ' + off);
  d.fill(0, off, off + orig.length + 1);
  d.write(repl, off, 'latin1');
}
for (const [from, to] of FMT) patchFmt(findFmt(from), to);

// AMD gate + vendor pass
if (d.toString('latin1', GATE_OFF, GATE_OFF + 4) !== 'AMD\0') throw new Error(`gate token drift at ${GATE_OFF}: ${JSON.stringify(d.toString('latin1', GATE_OFF, GATE_OFF + 4))}`);
const offs = []; let i = 0;
while ((i = d.indexOf('AMD\0', i, 'latin1')) >= 0) { offs.push(i); i += 4; }
if (offs.length !== 130) throw new Error(`AMD cstr count ${offs.length} (want 130)`);
if (!offs.includes(GATE_OFF)) throw new Error('gate offset not in AMD cstr list');
let n = 0;
for (const o of offs) {
  if (o === GATE_OFF) continue;
  if (d[o + 3] !== 0) throw new Error(`NUL broken at ${o}`);
  d.write(REPL, o, 'latin1'); // 3 bytes, same length
  n++;
}
if (n !== 129) throw new Error(`renamed ${n} (want 129)`);
if (d.length !== size) throw new Error('size changed');
fs.writeFileSync(file, d);
console.log(`patched: 2 fmt ops + AMD->${REPL} x${n} (gate @${GATE_OFF} kept AMD); size ${size} unchanged`);
