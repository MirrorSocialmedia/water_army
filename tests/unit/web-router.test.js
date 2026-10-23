/**
 * P2 T26 regression — hash router must STRIP the query before segment
 * matching. The viewer console URL is '#/devices/<id>/console?mode=viewer';
 * without the split, the last segment 'console?mode=viewer' never equals the
 * route segment 'console', matchRoute() returned null, and the page silently
 * fell back to the dashboard — so a viewer console click started NO stream
 * (T26 frames=0, no POST /api/device-streams in the API log).
 *
 * Hermetic: we stub globalThis.window.location.hash (no DOM, no browser).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchRoute, currentPath } from '../../apps/web/src/router.js';

function withHash(hash, fn) {
  const prev = globalThis.window;
  globalThis.window = { location: { hash } };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
  }
}

test('currentPath strips the query string before matching', () => {
  assert.equal(
    withHash('#/devices/abc123/console?mode=viewer', currentPath),
    '/devices/abc123/console',
  );
  assert.equal(withHash('#/devices/abc123/console', currentPath), '/devices/abc123/console');
  assert.equal(withHash('#/', currentPath), '/');
  assert.equal(withHash('', currentPath), '/');
  assert.equal(withHash('#/monitor?tab=cpu', currentPath), '/monitor');
});

test('viewer console route resolves to devices-console (was: dashboard fallback)', () => {
  const path = withHash('#/devices/abc123/console?mode=viewer', currentPath);
  const m = matchRoute(path);
  assert.ok(m, 'viewer console path must match a route');
  assert.equal(m.page, 'devices-console');
  assert.equal(m.params.id, 'abc123');
});

test('controller console route (no query) still resolves', () => {
  const path = withHash('#/devices/abc123/console', currentPath);
  const m = matchRoute(path);
  assert.ok(m);
  assert.equal(m.page, 'devices-console');
  assert.equal(m.params.id, 'abc123');
});

test('unrelated routes still match after the query-strip fix', () => {
  assert.equal(matchRoute('/devices').page, 'devices');
  assert.equal(matchRoute('/devices/xyz').page, 'devices-detail');
  assert.equal(matchRoute('/devices/xyz/console').page, 'devices-console');
  assert.equal(matchRoute('/monitor').page, 'monitor');
  assert.equal(matchRoute('/').page, 'dashboard');
});

test('unknown path still falls back to null (dashboard)', () => {
  assert.equal(matchRoute('/nope/noway'), null);
  assert.equal(matchRoute('/devices/abc123/definitely-not-a-route'), null);
});
