/**
 * R6 (R5 handoff #1) — repo-level guard: PUT/PATCH body schemas must NEVER
 * carry AJV `default:` keys.
 *
 * Why: a partial PUT/PATCH body runs through the same AJV schema as the
 * request body. With `useDefaults` semantics, an ABSENT field is filled with
 * the schema default before the handler sees it — so a one-field update
 * silently resets every other field to its default. This is exactly the R5
 * live bug (redroid template partial PUT clobbered `gpuMode`/`privileged`).
 * The behavioral regression is locked in tests/integration/
 * redroid-resource-limits.test.js; THIS guard prevents the same class of bug
 * from reappearing in ANY other route.
 *
 * The guard statically scans every `app.put(`/`app.patch(` registration in
 * apps/api/src/routes/ and resolves the `body:` schema (named const, inline
 * object, and `...spread` sources) — any `default:` property key (outside
 * string literals) is a violation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'api', 'src', 'routes');

// ---- minimal source scanning (string- and comment-aware) ------------------

/** src[startIdx] must be '{' — returns the inclusive index of the matching '}'. */
function findBalanced(src, startIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) i = src.length; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); if (e === -1) throw new Error('unterminated comment'); i = e + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces');
}

/** True if `default` occurs as a property key (outside strings) followed by ':'. */
function hasDefaultKey(text) {
  let inStr = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i); if (i === -1) i = text.length; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i); if (e === -1) throw new Error('unterminated comment'); i = e + 1; continue; }
    if (text.startsWith('default', i)) {
      const before = i === 0 ? ' ' : text[i - 1];
      if (!/[A-Za-z0-9_$]/.test(before)) {
        let j = i + 'default'.length;
        while (text[j] === ' ' || text[j] === '\t') j++;
        if (text[j] === ':') return true;
      }
    }
  }
  return false;
}

/** Returns the object-literal text of `const <name> = {...}`, or null. */
function findConstBlock(src, name) {
  const re = new RegExp(`\\bconst\\s+${name}\\s*=\\s*`);
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (/\s/.test(src[i] ?? '')) i++;
  if (src[i] !== '{') return null; // not an object literal — nothing to scan
  return src.slice(i, findBalanced(src, i) + 1);
}

/** All schema texts reachable from the `body:` key(s) of one registration. */
function bodySchemaTexts(src, regStartIdx) {
  // The registration is `app.put('/p', { ...schema... }, async (req) => {...})`.
  const handlerAt = src.indexOf('async (', regStartIdx);
  const window = src.slice(regStartIdx, handlerAt === -1 ? regStartIdx + 4000 : handlerAt);
  const out = [];
  const withSpreads = (block) => {
    out.push(block);
    for (const sp of block.matchAll(/\.\.\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      const def = findConstBlock(src, sp[1]);
      if (def) out.push(def);
    }
  };
  for (const m of window.matchAll(/body\s*:\s*/g)) {
    const at = regStartIdx + m.index + m[0].length;
    if (src[at] === '{') {
      withSpreads(src.slice(at, findBalanced(src, at) + 1));
      continue;
    }
    const idm = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(at));
    if (!idm) continue;
    const def = findConstBlock(src, idm[0]);
    if (def) withSpreads(def);
  }
  return out;
}

/** Scans every PUT/PATCH registration in one source file. */
function scanPutPatchDefaults(src) {
  const violations = [];
  const routes = [];
  for (const m of src.matchAll(/app\.(put|patch)\(\s*(['"`])([^'"`]+)\2/g)) {
    const regStart = m.index;
    routes.push(m[3]);
    for (const block of bodySchemaTexts(src, regStart)) {
      if (hasDefaultKey(block)) violations.push(m[3]);
    }
  }
  return { routes, violations };
}

test('patch-default guard: scanner self-tests (it must actually detect `default:`)', () => {
  const good = `
    app.patch('/x', { schema: { body: { type: 'object', properties: { a: { type: 'boolean' }, note: { type: 'string', description: 'the word default: lives inside a string — not a key' } } } } }, async (req) => req.body);
  `;
  assert.deepEqual(scanPutPatchDefaults(good).violations, []);

  const bad = `
    app.put('/y', { schema: { body: { type: 'object', properties: { a: { type: 'boolean', default: false } } } } }, async (req) => req.body);
  `;
  const badScan = scanPutPatchDefaults(bad);
  assert.equal(badScan.routes.length, 1);
  assert.equal(badScan.violations.length, 1);

  // Spread resolution must reach the source const.
  const spreadSrc = `
    const SHARED = { type: 'object', properties: { a: { type: 'boolean', default: true } } };
    app.patch('/z', { schema: { body: { ...SHARED } } }, async (req) => req.body);
  `;
  assert.equal(scanPutPatchDefaults(spreadSrc).violations.length, 1, 'spread source with a default must be flagged');
});

test('patch-default guard: NO PUT/PATCH body schema in apps/api/src/routes/ carries `default:` (R5 clobber class, repo-wide)', () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length >= 5, `expected several route files, got: ${files}`);

  const allRoutes = [];
  const allViolations = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');
    const { routes, violations } = scanPutPatchDefaults(src);
    allRoutes.push(...routes);
    for (const v of violations) allViolations.push(`${f}: ${v}`);
  }

  // Coverage sanity: the guard must have found the known PUT/PATCH surface.
  // (Prevents a silent scanner regression that would make the guard a no-op.)
  for (const known of ['/api/redroid/templates/:id', '/api/providers/:name', '/api/schedules/:id']) {
    assert.ok(allRoutes.includes(known), `scanner must see the known PUT/PATCH route ${known}; saw: ${allRoutes}`);
  }

  assert.deepEqual(
    allViolations,
    [],
    `PUT/PATCH body schemas with AJV \`default:\` keys (partial-update clobber risk, MD §8.1 / R5 handoff #1):\n  ${allViolations.join('\n  ')}\n` +
    'Defaults belong in the CREATE (POST) schema only — partial updates must treat absent fields as "unchanged".',
  );
});
