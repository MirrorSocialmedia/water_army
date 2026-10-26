/**
 * W2 (ADR-026) — ui-tree unit tests: bounded parsing + the element-targeting
 * error contract (zero/multi/off-screen = explicit codes, never a guess).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseUiDump,
  findElements,
  pickTapTarget,
  UiTreeError,
} from '../../apps/api/src/services/ui-tree.js';

const xmlOf = (inner, rotation = '0') =>
  `<?xml version='1.0' encoding='UTF-8' standalone=yes ?>\n<hierarchy rotation="${rotation}">\n${inner}\n</hierarchy>`;

const NODE_LOGIN =
  '<node index="0" text="" resource-id="com.demo:id/login_btn" class="android.widget.Button" package="com.demo" content-desc="Login 按鈕" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" selected="false" bounds="[100,200][300,280]" />';

// NOTE: node's assert.throws validator must return exactly `true` (truthy non-booleans fail).
const isUiErr = (e) => e instanceof UiTreeError;
const errCode = (e) => (e instanceof UiTreeError ? e.apiCode : false);

test('parse: happy path — node list, attrs, clickable, integer bounds', () => {
  const { nodes, stats } = parseUiDump(xmlOf(NODE_LOGIN));
  assert.equal(stats.parsed, 1);
  assert.equal(stats.skippedMalformed, 0);
  const n = nodes[0];
  assert.equal(n.resourceId, 'com.demo:id/login_btn');
  assert.equal(n.className, 'android.widget.Button');
  assert.equal(n.packageName, 'com.demo');
  assert.equal(n.contentDesc, 'Login 按鈕');
  assert.equal(n.clickable, true);
  assert.deepEqual(n.bounds, { x1: 100, y1: 200, x2: 300, y2: 280 });
});

test('parse: quote-aware scanning — a ">" inside a quoted attr is data', () => {
  const xml = xmlOf('<node text="a>b" resource-id="id/x" bounds="[0,0][10,10]" clickable="false" enabled="true" class="c" package="p" />');
  const { nodes, stats } = parseUiDump(xml);
  assert.equal(stats.parsed, 1);
  assert.equal(nodes[0].text, 'a>b');
});

test('parse: XML entities decode (&lt; &amp; &#NN;)', () => {
  const xml = xmlOf('<node text="1 &lt; 2 &amp; 3 &#65;" resource-id="id/e" bounds="[0,0][4,4]" class="c" package="p" />');
  const { nodes } = parseUiDump(xml);
  assert.equal(nodes[0].text, '1 < 2 & 3 A');
});

test('parse: malformed / inverted bounds skip ONLY that node (counted, never silent)', () => {
  const xml = xmlOf([
    NODE_LOGIN,
    '<node resource-id="id/bad" bounds="[1,1]" />',
    '<node resource-id="id/inv" bounds="[300,280][100,200]" />',
    '<node resource-id="id/empty" bounds="" />',
  ].join('\n'));
  const { nodes, stats } = parseUiDump(xml);
  assert.equal(stats.parsed, 1);
  assert.equal(stats.skippedMalformed, 3);
  assert.equal(nodes[0].resourceId, 'com.demo:id/login_btn');
});

test('parse: truncated / non-hierarchy / empty inputs are UIA_DUMP_INVALID', () => {
  for (const bad of [
    '', '   ', null, 42,
    '<hierarchy rotation="0"><node bounds="[0,0][1,1]"/></hierarchy', // no closing tag
    '<html><node/></html>', // wrong root
    '<hierarchy rotation="0"><node text="unterminated bounds="[0,0', // unterminated tag
  ]) {
    assert.throws(() => parseUiDump(bad), isUiErr, `input ${JSON.stringify(String(bad).slice(0, 30))} must be UIA_DUMP_INVALID`);
  }
});

test('parse: size cap (UIA_DUMP_TOO_LARGE) and node cap (UIA_DUMP_NODE_LIMIT)', () => {
  const big = xmlOf(NODE_LOGIN.repeat(1));
  assert.throws(() => parseUiDump(big, { maxBytes: 100 }), (e) => errCode(e) === 'UIA_DUMP_TOO_LARGE');
  const many = xmlOf(Array.from({ length: 10 }, () => NODE_LOGIN).join('\n'));
  assert.throws(() => parseUiDump(many, { maxNodes: 5 }), (e) => errCode(e) === 'UIA_DUMP_NODE_LIMIT');
  assert.equal(parseUiDump(many, { maxNodes: 10 }).nodes.length, 10);
});

test('parse: `<nodex` prefix does not match the node tag', () => {
  const { nodes, stats } = parseUiDump(xmlOf('<nodex bounds="[0,0][9,9]" /><node resource-id="id/ok" bounds="[0,0][9,9]" class="c" package="p" />'));
  assert.equal(stats.parsed, 1);
  assert.equal(nodes[0].resourceId, 'id/ok');
});

// ---- selector semantics ------------------------------------------------------

const { nodes } = parseUiDump(xmlOf([
  NODE_LOGIN,
  '<node text="Login" resource-id="com.demo:id/alt_login" class="android.widget.TextView" package="com.demo" content-desc="" clickable="false" enabled="true" bounds="[0,0][50,20]" />',
  '<node text="footer" resource-id="" class="android.widget.TextView" package="com.demo" content-desc="" clickable="false" enabled="true" bounds="[0,1000][500,1040]" />',
].join('\n')));

test('findElements: AND semantics + exact vs contains', () => {
  assert.equal(findElements(nodes, { resourceId: 'com.demo:id/login_btn' }).length, 1);
  assert.equal(findElements(nodes, { text: 'Login' }).length, 1); // exact — Button has text ""
  assert.equal(findElements(nodes, { textContains: 'ogin' }).length, 1); // Button.text is '' (desc carries 'Login') — only alt_login matches
  assert.equal(findElements(nodes, { textContains: 'o' }).length, 2); // 'Login' + 'footer'
  assert.equal(findElements(nodes, { contentDescContains: '按鈕' }).length, 1);
  assert.equal(findElements(nodes, { className: 'android.widget.TextView' }).length, 2);
  assert.equal(findElements(nodes, { className: 'android.widget.TextView', clickable: true }).length, 0);
  assert.equal(findElements(nodes, { textContains: 'zzz' }).length, 0);
});

test('findElements: empty / unknown / non-object selectors are UIA_SELECTOR_INVALID', () => {
  for (const bad of [{}, { resourceId: '' }, { foo: 'x' }, null, 'text', []]) {
    assert.throws(() => findElements(nodes, bad), (e) => errCode(e) === 'UIA_SELECTOR_INVALID', `selector ${JSON.stringify(bad)} must be invalid`);
  }
});

// ---- tap target contract -------------------------------------------------------

test('pickTapTarget: single match → integer center of bounds', () => {
  const t = pickTapTarget(nodes, { resourceId: 'com.demo:id/login_btn' });
  assert.deepEqual({ x: t.x, y: t.y }, { x: 200, y: 240 });
  assert.equal(t.element.className, 'android.widget.Button');
});

test('pickTapTarget: zero match → 404 UIA_ELEMENT_NOT_FOUND', () => {
  assert.throws(
    () => pickTapTarget(nodes, { resourceId: 'com.demo:id/nope' }),
    (e) => errCode(e) === 'UIA_ELEMENT_NOT_FOUND' && e.statusCode === 404,
  );
});

test('pickTapTarget: multi match → 409 UIA_ELEMENT_AMBIGUOUS with candidate summary', () => {
  assert.throws(
    () => pickTapTarget(nodes, { textContains: 'o' }), // 'Login' + 'footer' both match
    (e) => {
      assert.equal(e.apiCode, 'UIA_ELEMENT_AMBIGUOUS');
      assert.equal(e.statusCode, 409);
      assert.ok(e.details.count >= 2);
      assert.ok(Array.isArray(e.details.candidates) && e.details.candidates.length >= 2);
      return true;
    },
  );
});

test('pickTapTarget: off-screen center → 422 UIA_ELEMENT_OFFSCREEN (rotation/stale-dump race)', () => {
  assert.throws(
    () => pickTapTarget(nodes, { resourceId: 'com.demo:id/login_btn' }, { screenWidth: 100, screenHeight: 100 }),
    (e) => errCode(e) === 'UIA_ELEMENT_OFFSCREEN' && e.statusCode === 422,
  );
  // same element, plausible screen → fine
  assert.ok(pickTapTarget(nodes, { resourceId: 'com.demo:id/login_btn' }, { screenWidth: 720, screenHeight: 1280 }));
});

test('parse: rotation attribute tolerated; malformed-but-paired hierarchy with 0 nodes parses empty', () => {
  const { nodes: n0, stats } = parseUiDump(xmlOf(''));
  assert.equal(n0.length, 0);
  assert.equal(stats.skippedMalformed, 0);
});
