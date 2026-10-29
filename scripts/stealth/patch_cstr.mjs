#!/usr/bin/env node
/**
 * WA-VMSTEALTH (S1 §1.4 ruling (a)): fail-closed in-place C-string patcher.
 *
 * Replaces NUL-terminated literals in a binary with SHORTER-or-equal
 * replacements, NUL-padded in place — zero layout change (no offsets, no
 * table growth, no relocation), so the worst case of a wrong guess is
 * cosmetic, never a boot loop. The search literal (incl. its NUL terminator)
 * must appear EXACTLY `count` times or the script exits non-zero (fail
 * closed: base-image drift that renames/derenders the target must break the
 * build loudly, not silently no-op).
 *
 * Usage: patch_cstr.mjs <file> <old-literal> <new-literal> [count=1]
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';

const [path, oldStr, newStr, countArg = '1'] = process.argv.slice(2);
if (!path || oldStr === undefined || newStr === undefined) {
  console.error('usage: patch_cstr.mjs <file> <old-literal> <new-literal> [count=1]');
  process.exit(2);
}
const count = Number(countArg);
const oldBuf = Buffer.from(oldStr, 'utf8');
const newBuf = Buffer.from(newStr, 'utf8');
const fail = (msg) => { console.error(`PATCH REJECTED: ${msg}`); process.exit(1); };
if (!Number.isInteger(count) || count < 1) fail(`bad count ${countArg}`);
if (newBuf.length > oldBuf.length) fail(`replacement longer than original (${newBuf.length} > ${oldBuf.length})`);

const sizeBefore = statSync(path).size;
const data = readFileSync(path);
const needle = Buffer.concat([oldBuf, Buffer.from([0])]); // exact NUL-terminated — no prefix collisions
let pos = 0, hits = 0;
while ((pos = data.indexOf(needle, pos)) >= 0) { hits++; pos += 1; }
if (hits !== count) fail(`found ${hits} occurrences of ${JSON.stringify(oldStr)} (want exactly ${count})`);

// same-length replacement: new + NUL pad + NUL terminator
const patch = Buffer.concat([newBuf, Buffer.alloc(oldBuf.length - newBuf.length), Buffer.from([0])]);
pos = 0;
let patched = 0;
while ((pos = data.indexOf(needle, pos)) >= 0) {
  patch.copy(data, pos);
  patched++;
  pos += needle.length;
}
if (patched !== count) fail(`replace pass applied ${patched} != ${count}`);
writeFileSync(path, data);
if (statSync(path).size !== sizeBefore) fail(`file size changed (${sizeBefore} -> ${statSync(path).size})`);
console.log(`patched ${patched}x ${JSON.stringify(oldStr)} -> ${JSON.stringify(newStr)} in ${path} (file size unchanged: ${sizeBefore} bytes)`);
