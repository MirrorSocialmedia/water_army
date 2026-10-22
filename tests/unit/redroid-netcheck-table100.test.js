/**
 * T102 (BR-Acceptance C3-S2a follow-up) — netcheck table-100 EXACT-match
 * regression suite.
 *
 * Bug (live-verified 2026-10-22, C3-S2a): the generated netcheck script
 * classified the effective route with `grep -q "table 100"` — a SUBSTRING
 * match that also hit Docker's per-net routing tables (user-defined docker
 * networks get per-net tables numbered 1000+; the live capture showed
 * "table 1002" in `ip route get` output with the tunnel dead) → false
 * effective=tunnel whenever a per-net table resolved the fallback.
 *
 * Fix: `printf "%s\n" "$G" | grep -qE "table 100($|[[:space:]])"` — the
 * token "table 100" must be followed by end-of-line or whitespace (POSIX
 * ERE; $ + [[:space:]] are toybox/busybox/GNU safe). 1000/1002/1003/… can
 * never match; both the observed inline (toybox) token position and the
 * defensive EOL position are covered.
 *
 * These tests execute the REAL generated script under POSIX sh with stubbed
 * `ip`/`ps` emitting real-capture fixtures (tests/fixtures/
 * netcheck-route-get-fixtures.js — provenance documented there), so the
 * matcher is tested on the exact bytes a device would produce. The
 * verdict layer (classifyNetcheck) is pinned UNCHANGED: the fix corrects
 * the reporting field; the platform verdict (BLOCKED) was and remains
 * driven by iface/route first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  buildT2sNetcheckScript,
  parseNetcheckOutput,
  classifyNetcheck,
  NET_ERRORS,
} from '../../apps/api/src/services/redroid-health.js';
import { runNetcheckScript } from '../helpers/netcheck-script-runner.js';
import * as FX from '../fixtures/netcheck-route-get-fixtures.js';

// ---------------------------------------------------------------------------
// Fixture stub bundles (netns state per scenario)
// ---------------------------------------------------------------------------

const STUB_ALIVE = {
  psLine: FX.PS_TUN2SOCKS_ALIVE,
  linkTun0: FX.IP_LINK_TUN0_UP,
  routeTable100: FX.TABLE_100_ROUTES_ALIVE,
  ruleShow: FX.IP_RULES_REAL_DEVICE,
};

/** Tunnel dead on an OPEN net (the C3-S2a shape): tun0 freed, table-100
 * routes gone, rule 5000 persists, fallback resolves via per-net table 1002,
 * harness zombie keeps process=alive (documented harness artifact). */
function stubDeadPernet(routeGet) {
  return {
    psLine: FX.PS_TUN2SOCKS_ZOMBIE_HARNESS,
    linkTun0: FX.IP_LINK_TUN0_MISSING,
    routeTable100: FX.TABLE_100_ROUTES_DEAD,
    ruleShow: FX.IP_RULES_REAL_DEVICE,
    routeGet,
  };
}

/** Tunnel dead on a net WITHOUT a per-net table: main-table default on eth0
 * = the §10.9 fail-open shape. */
const STUB_DEAD_MAINTABLE = {
  ...stubDeadPernet(FX.DIRECT_MAINTABLE_ROUTE_GET),
  routeGet: FX.DIRECT_MAINTABLE_ROUTE_GET,
};

function netcheckLineFor(stubs) {
  const { stdout } = runNetcheckScript(buildT2sNetcheckScript(), stubs);
  const parsed = parseNetcheckOutput(stdout);
  assert.equal(parsed.ok, true, `NETCHECK line must parse, got: ${JSON.stringify(stdout)}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// 1. Builder pins — the generated script carries the EXACT-match matcher
// ---------------------------------------------------------------------------

test('t102 builder: script carries the exact table-100 token match (no bare substring)', () => {
  const s = buildT2sNetcheckScript();
  // the fixed matcher: token "table 100" + end-of-line/whitespace (POSIX ERE)
  assert.ok(s.includes('grep -qE "table 100($|[[:space:]])"'), 'exact-token ERE grep present');
  // the $(...) trailing-newline strip is normalized for the EOL case
  assert.ok(s.includes('printf "%s\\n" "$G" | grep -qE "table 100($|[[:space:]])"'), 'printf \\n normalization present');
  // the legacy bare-substring form is gone
  assert.ok(!s.includes('grep -q "table 100";'), 'legacy bare "table 100" grep must be gone');
  // read-only contract still holds (the line was changed — re-pin it)
  assert.ok(!/pkill|pgrep|ip link (add|del|set)|ip route (add|del|flush)|ip rule (add|del)|chmod|rm /.test(s));
});

// ---------------------------------------------------------------------------
// 2. Matcher matrix — REAL script execution, real-capture fixtures
// ---------------------------------------------------------------------------

test('t102 matcher: tunnel ALIVE (table-100 default, verbatim R2 device capture) → effective=tunnel', () => {
  const p = netcheckLineFor({ ...STUB_ALIVE, routeGet: FX.TUNNEL_ALIVE_ROUTE_GET });
  assert.equal(p.process, 'alive');
  assert.equal(p.iface, 'up');
  assert.equal(p.route, 'present');
  assert.equal(p.rule, 'present');
  assert.equal(p.effective, 'tunnel');
});

test('t102 matcher: tunnel DEAD + per-net table 1002 (the C3-S2a false positive) → effective=direct', () => {
  const p = netcheckLineFor(stubDeadPernet(FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET));
  assert.equal(p.process, 'alive', 'zombie artifact: harness ps still matches (documented)');
  assert.equal(p.iface, 'missing');
  assert.equal(p.route, 'missing');
  assert.equal(p.rule, 'present');
  assert.equal(
    p.effective,
    'direct',
    'REGRESSION: "table 1002" must NOT match the table-100 token; the route really IS via eth0 (direct)',
  );
});

test('t102 matcher: per-net table siblings 1000/1003 → effective=direct (never tunnel)', () => {
  for (const fx of [FX.TUNNEL_DEAD_PERNET_1000_ROUTE_GET, FX.TUNNEL_DEAD_PERNET_1003_ROUTE_GET]) {
    const p = netcheckLineFor(stubDeadPernet(fx));
    assert.equal(p.effective, 'direct', `fixture: ${JSON.stringify(fx)}`);
  }
});

test('t102 matcher: mixed output (table 100 AND table 1002) → deterministic: exact token wins → tunnel', () => {
  const p = netcheckLineFor({ ...STUB_ALIVE, routeGet: FX.MIXED_100_AND_1002_ROUTE_GET });
  assert.equal(p.effective, 'tunnel', 'an exact table-100 token present ⇒ tunnel (deterministic rule)');
});

test('t102 matcher: DEFENSIVE EOL shape — "table 100" as last token → effective=tunnel ($ branch)', () => {
  const p = netcheckLineFor({ ...STUB_ALIVE, routeGet: FX.TUNNEL_ALIVE_ROUTE_GET_IPROUTE2 });
  assert.equal(p.effective, 'tunnel', 'EOL-position annotation must still count as the tunnel table');
});

test('t102 matcher: DEFENSIVE EOL shape — "table 1002" as last token → effective=direct', () => {
  const p = netcheckLineFor(stubDeadPernet(FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET_IPROUTE2));
  assert.equal(p.effective, 'direct');
});

test('t102 matcher: tunnel dead on INTERNAL net (FIB unreachable → empty stdout, C4-S2) → effective=unknown', () => {
  const p = netcheckLineFor(stubDeadPernet(FX.TUNNEL_DEAD_INTERNAL_ROUTE_GET));
  assert.equal(p.effective, 'unknown', 'nothing resolved ⇒ unknown (matches the C4-S2 live observation)');
});

test('t102 matcher: tunnel dead, main-table default on eth0 (no per-net table; C4 control-B shape) → effective=direct', () => {
  const p = netcheckLineFor(STUB_DEAD_MAINTABLE);
  assert.equal(p.effective, 'direct', 'main-table eth0 default = §10.9 fail-open shape, reported direct');
});

test('t102 matcher: genuinely dead process → process=dead (orthogonal to the table match)', () => {
  const p = netcheckLineFor({
    ...STUB_ALIVE,
    routeGet: FX.TUNNEL_ALIVE_ROUTE_GET,
    psLine: FX.PS_TUN2SOCKS_DEAD,
  });
  assert.equal(p.process, 'dead');
  assert.equal(p.effective, 'tunnel', 'route state is independent of the process state');
});

// ---------------------------------------------------------------------------
// 3. Before/after — measured, on the same fixtures
// ---------------------------------------------------------------------------

test('t102 before/after: the LEGACY script misreports the C3-S2a shape; the fixed script does not', () => {
  // Rebuild the pre-fix script exactly (same generated script, legacy line)
  const fixed = buildT2sNetcheckScript();
  const legacy = fixed.replace(
    'printf "%s\\n" "$G" | grep -qE "table 100($|[[:space:]])"',
    'printf "%s" "$G" | grep -q "table 100"',
  );
  assert.notEqual(legacy, fixed, 'sanity: the legacy reconstruction actually differs');

  const stubs = stubDeadPernet(FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET);
  const before = parseNetcheckOutput(runNetcheckScript(legacy, stubs).stdout);
  const after = parseNetcheckOutput(runNetcheckScript(fixed, stubs).stdout);
  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  assert.equal(before.effective, 'tunnel', 'measured pre-fix behavior: the substring match lies (table 1002 → "tunnel") — matches the live C3-S2a NETCHECK line');
  assert.equal(after.effective, 'direct', 'measured post-fix behavior: per-net table 1002 is not the tunnel table');
});

test('t102 before/after (defensive EOL shape): legacy matches, fixed does not', () => {
  const fixed = buildT2sNetcheckScript();
  const legacy = fixed.replace(
    'printf "%s\\n" "$G" | grep -qE "table 100($|[[:space:]])"',
    'printf "%s" "$G" | grep -q "table 100"',
  );
  assert.notEqual(legacy, fixed, 'sanity: the legacy reconstruction actually differs');
  const stubs = stubDeadPernet(FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET_IPROUTE2);
  const before = parseNetcheckOutput(runNetcheckScript(legacy, stubs).stdout);
  const after = parseNetcheckOutput(runNetcheckScript(fixed, stubs).stdout);
  assert.equal(before.effective, 'tunnel', 'legacy substring also lies on the EOL shape');
  assert.equal(after.effective, 'direct', 'fixed matcher: EOL-position "table 1002" is still not the tunnel table');
});

test('t102 root cause: bare "table 100" substring matches every 100x; the ERE token does not', () => {
  const run = (pattern, input) => execFileSync('sh', ['-c', `grep -qE ${pattern} && echo yes || echo no`], {
    input,
    encoding: 'utf8',
  }).trim();
  const ERE = '"table 100($|[[:space:]])"';
  const BRE_WS_ONLY = '"table 100[[:space:]]"';
  const LEGACY = '"table 100"';
  const runBRE = (pattern, input) => execFileSync('sh', ['-c', `grep -q ${pattern} && echo yes || echo no`], {
    input,
    encoding: 'utf8',
  }).trim();
  // legacy bare-substring pattern (BRE, plain string): matches EVERY 100x sibling (the bug)
  assert.equal(runBRE(LEGACY, FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET), 'yes', 'legacy matches "table 1002" (live C3-S2a shape)');
  assert.equal(runBRE(LEGACY, FX.TUNNEL_DEAD_PERNET_1000_ROUTE_GET), 'yes', 'legacy matches "table 1000"');
  assert.equal(runBRE(LEGACY, FX.TUNNEL_DEAD_PERNET_1003_ROUTE_GET), 'yes', 'legacy matches "table 1003"');
  assert.equal(runBRE(LEGACY, FX.TUNNEL_ALIVE_ROUTE_GET), 'yes', 'legacy matches the real tunnel capture too (why the bug was invisible when alive)');
  // fixed ERE: 100x siblings never match
  assert.equal(run(ERE, FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET), 'no', 'ERE rejects "table 1002"');
  assert.equal(run(ERE, FX.TUNNEL_DEAD_PERNET_1000_ROUTE_GET), 'no', 'ERE rejects "table 1000"');
  assert.equal(run(ERE, FX.TUNNEL_DEAD_PERNET_1003_ROUTE_GET), 'no', 'ERE rejects "table 1003"');
  assert.equal(run(ERE, FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET_IPROUTE2), 'no', 'ERE rejects EOL-position "table 1002"');
  // fixed ERE: every table-100 shape matches
  assert.equal(run(ERE, FX.TUNNEL_ALIVE_ROUTE_GET), 'yes', 'ERE matches inline toybox "table 100" (live capture)');
  assert.equal(run(ERE, FX.TUNNEL_ALIVE_ROUTE_GET_IPROUTE2), 'yes', 'ERE matches EOL-position "table 100" ($ branch)');
  // why the $ branch exists: a whitespace-ONLY guard misses the EOL shape
  // (grep is line-based; the line terminator is never part of the line)
  assert.equal(runBRE(BRE_WS_ONLY, FX.TUNNEL_ALIVE_ROUTE_GET_IPROUTE2), 'no', 'whitespace-only guard MISSES EOL "table 100" → would regress effective to unknown/direct');
  assert.equal(runBRE(BRE_WS_ONLY, FX.TUNNEL_ALIVE_ROUTE_GET), 'yes', 'whitespace-only guard works for the inline shape (space follows the token)');
});

// ---------------------------------------------------------------------------
// 4. Verdict invariance — classifyNetcheck over every measured shape
// ---------------------------------------------------------------------------

test('t102 verdicts: intact tunnel → null (no issue), unchanged', () => {
  const p = netcheckLineFor({ ...STUB_ALIVE, routeGet: FX.TUNNEL_ALIVE_ROUTE_GET });
  assert.equal(classifyNetcheck(p), null);
});

test('t102 verdicts: C3-S2a shape (zombie alive + tun0 gone + per-net 1002) → definite TUNNEL_IFACE_MISSING — same verdict as pre-fix', () => {
  const p = netcheckLineFor(stubDeadPernet(FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET));
  assert.deepEqual(classifyNetcheck(p), { severity: 'definite', code: NET_ERRORS.TUNNEL_IFACE_MISSING });
});

test('t102 verdicts: pre-created tun0 blackhole shape (iface up, table 100 empty, per-net 1002) → definite TUNNEL_ROUTE_UNCERTAIN', () => {
  const p = netcheckLineFor({
    psLine: FX.PS_TUN2SOCKS_ZOMBIE_HARNESS,
    linkTun0: FX.IP_LINK_TUN0_UP,
    routeTable100: FX.TABLE_100_ROUTES_DEAD,
    ruleShow: FX.IP_RULES_REAL_DEVICE,
    routeGet: FX.TUNNEL_DEAD_PERNET_1002_ROUTE_GET,
  });
  assert.equal(p.effective, 'direct', 'with tun0 present but table 100 empty, the 1002 fallback is now HONESTLY reported');
  assert.deepEqual(classifyNetcheck(p), { severity: 'definite', code: NET_ERRORS.TUNNEL_ROUTE_UNCERTAIN });
});

test('t102 verdicts: internal-net dead shape (effective=unknown) → definite via iface first; with iface up → inconclusive', () => {
  const p = netcheckLineFor(stubDeadPernet(FX.TUNNEL_DEAD_INTERNAL_ROUTE_GET));
  assert.deepEqual(classifyNetcheck(p), { severity: 'definite', code: NET_ERRORS.TUNNEL_IFACE_MISSING });
  const p2 = { ...p, iface: 'up', route: 'missing' };
  assert.deepEqual(classifyNetcheck(p2), { severity: 'definite', code: NET_ERRORS.TUNNEL_ROUTE_UNCERTAIN });
  const p3 = { ...p, iface: 'up', route: 'present' };
  assert.deepEqual(classifyNetcheck(p3), { severity: 'inconclusive', code: NET_ERRORS.TUNNEL_CHECK_ERROR });
});
