/**
 * BR-B5 S4 — web render smoke (component-level, no frontend toolchain).
 *
 * The repo has no jsdom/vitest (P0 ADR: minimal lockfile), so this test
 * reuses what the web workspace already ships: vite (ssrLoadModule) +
 * react-dom/server. Every B5 page (+ the full App, which covers the
 * router/layout wiring) is rendered to static markup with zero network
 * (effects don't run in SSR — pages show their real initial/loading
 * state, exactly what a fresh browser paints before the first response).
 *
 * Gates:
 *  - the component tree mounts without throwing (JSX + imports resolve,
 *    hook order valid, no undefined destructuring at render time)
 *  - each page renders its real header (page is actually wired, not a
 *    dead route)
 *  - no secret-shaped text in any rendered markup (MD §12, defense in
 *    depth on top of the API allow-listing)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('web render smoke — B5 pages + App SSR without throwing, headers present, zero secret text', async (t) => {
  // minimal browser shim for SSR (window.location.hash is read during
  // render by the hash router; no listener actually registers — effects
  // are skipped by renderToStaticMarkup)
  const realWindow = globalThis.window;
  globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {} };

  const { createServer } = await import('vite');
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true },
  });
  t.after(async () => {
    globalThis.window = realWindow;
    await server.close();
  });

  const { renders } = await server.ssrLoadModule('/tests/helpers/ssr-smoke-entry.jsx');

  // (1) mounted — every render produced real markup
  for (const [name, html] of Object.entries(renders)) {
    assert.equal(typeof html, 'string', `${name} render is a string`);
    // the App boot frame is legitimately tiny (login-screen > card > 'Loading…')
    assert.ok(html.length > (name === 'app' ? 40 : 100), `${name} rendered non-trivial markup (${html.length} chars)`);
  }

  // (2) each page renders its real header (route wiring is live)
  assert.match(renders.app, /Loading/); // boot frame (auth check is an effect — not run in SSR)
  // static page headers (rendered outside the data frame) …
  assert.match(renders.planner, /Batch Planner/);
  assert.match(renders.planner, /Preview is the default action/);
  assert.match(renders.monitor, /Live Monitor/);
  assert.match(renders.monitor, /auto-refresh 5s/);
  assert.match(renders.identities, /Identities/);
  assert.match(renders.identities, /stable IDs/);
  assert.match(renders.reports, /Batch Reports/);
  assert.match(renders.reports, /export contains no secrets/);
  // … and every page shows its real initial (pending) frame in SSR
  for (const name of ['planner', 'monitor', 'identities', 'identityDetail', 'reports']) {
    assert.match(renders[name], /Loading/, name + ' shows its initial loading frame');
  }

  // (3) zero credential-shaped values in any rendered markup (MD §12).
  //     Prose words are fine — we scan for LEAK SHAPES: labelled
  //     key=value secrets, private-key headers, JWTs.
  const CRED_RE = /((password|passwd|pwd|api[_-]?key|session[_-]?cookie|authorization|access[_-]?token|client[_-]?secret|token)\s*[:=]\s*\S)/i;
  const JWT_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;
  const KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  for (const [name, html] of Object.entries(renders)) {
    assert.doesNotMatch(html, CRED_RE, `${name} markup contains a labelled secret`);
    assert.doesNotMatch(html, JWT_RE, `${name} markup contains a JWT`);
    assert.doesNotMatch(html, KEY_RE, `${name} markup contains a private key`);
  }
});
