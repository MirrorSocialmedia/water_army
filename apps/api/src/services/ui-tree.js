/**
 * W2 (ADR-026) — uiautomator UI-tree parsing + element targeting.
 *
 * Pure module: takes the XML string produced by `uiautomator dump` (read back
 * through the whitelisted device-read op) and answers two questions:
 *   1. parseUiDump  — the bounded, validated node list (hierarchy truth)
 *   2. pickTapTarget — exactly ONE element for a selector + its tap center
 *
 * Error contract (stable API codes, workorder 明確錯誤契約):
 *   UIA_DUMP_INVALID       422 — not a uiautomator hierarchy / truncated XML
 *   UIA_DUMP_TOO_LARGE     422 — input above maxBytes (size-bomb defense)
 *   UIA_DUMP_NODE_LIMIT    422 — more nodes than maxNodes (complexity bomb)
 *   UIA_SELECTOR_INVALID   400 — empty/unknown selector criteria
 *   UIA_ELEMENT_NOT_FOUND  404 — zero matches
 *   UIA_ELEMENT_AMBIGUOUS  409 — >1 match (never guess which one to tap)
 *   UIA_ELEMENT_OFFSCREEN  422 — element center outside the screen bounds
 *
 * Bounds semantics: malformed `bounds` on an individual node skips THAT node
 * (counted in stats.skippedMalformed — honest, never silent); the tap target
 * therefore always carries well-formed integer bounds.
 */

export class UiTreeError extends Error {
  constructor({ code, status, message, details }) {
    super(message ?? code);
    this.name = 'UiTreeError';
    this.apiCode = code;
    this.statusCode = status;
    this.statusCodeNum = status;
    this.details = details;
  }
}

const fail = (code, status, message, details) => {
  throw new UiTreeError({ code, status, message, details });
};

const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML entity decode for the small set uiautomator emits (defense in depth). */
function decodeEntities(v) {
  return v.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/**
 * Scan `<node ...>` tags with quote awareness: a `>` inside a quoted attribute
 * value is data, not the tag end. Returns the raw attribute strings.
 */
function scanNodeTags(xml) {
  const attrs = [];
  let i = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const start = xml.indexOf('<node', i);
    if (start === -1) break;
    // `<node` must be followed by whitespace (a real tag) — not `<nodex`.
    const after = xml[start + 5];
    if (after !== undefined && !/[\s/>]/.test(after)) {
      i = start + 5;
      continue;
    }
    let j = start + 5;
    let inQuotes = false;
    for (; j < xml.length; j++) {
      const c = xml[j];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === '>' && !inQuotes) break;
    }
    if (j >= xml.length) {
      // unterminated tag — truncated input
      fail('UIA_DUMP_INVALID', 422, 'uiautomator dump ends with an unterminated <node> tag (truncated read?)');
    }
    attrs.push(xml.slice(start + 5, j).replace(/\/$/, ''));
    i = j + 1;
  }
  return attrs;
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g;

function attrMap(raw) {
  const m = Object.create(null);
  for (const [, k, v] of raw.matchAll(ATTR_RE)) m[k] = decodeEntities(v);
  return m;
}

/**
 * Parse a uiautomator dump XML into bounded, validated nodes.
 *
 * @param {string} xml
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]   input size cap (default 4 MiB)
 * @param {number} [opts.maxNodes]   node cap (default 2000)
 * @param {number} [opts.maxTextLen] per-attribute clip (default 512)
 * @returns {{nodes: Array, stats: {parsed:number, skippedMalformed:number, truncatedInput?:boolean}}}
 */
export function parseUiDump(xml, { maxBytes = 4_194_304, maxNodes = 2000, maxTextLen = 512 } = {}) {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    fail('UIA_DUMP_INVALID', 422, 'uiautomator dump is empty or not a string');
  }
  if (Buffer.byteLength(xml, 'utf8') > maxBytes) {
    fail('UIA_DUMP_TOO_LARGE', 422, `uiautomator dump exceeds the ${maxBytes}-byte cap`);
  }
  const trimmed = xml.trim();
  // Real dumps carry an `<?xml …?>` prologue — strip it before the root check.
  const body = trimmed.replace(/^<\?xml[\s\S]*?\?>\s*/, '');
  if (!body.startsWith('<hierarchy') || !body.endsWith('</hierarchy>')) {
    fail('UIA_DUMP_INVALID', 422, 'input is not a complete uiautomator hierarchy (missing <hierarchy> root — truncated read?)');
  }

  const nodes = [];
  let skippedMalformed = 0;
  for (const raw of scanNodeTags(trimmed)) {
    if (nodes.length >= maxNodes) {
      fail('UIA_DUMP_NODE_LIMIT', 422, `uiautomator dump exceeds the ${maxNodes}-node cap`);
    }
    const a = attrMap(raw);
    const bm = BOUNDS_RE.exec(a.bounds ?? '');
    if (!bm) {
      skippedMalformed += 1; // honest stat — never a silent drop
      continue;
    }
    const [x1, y1, x2, y2] = [Number(bm[1]), Number(bm[2]), Number(bm[3]), Number(bm[4])];
    if (x2 < x1 || y2 < y1) {
      skippedMalformed += 1;
      continue;
    }
    nodes.push({
      resourceId: a['resource-id'] ?? '',
      text: (a.text ?? '').slice(0, maxTextLen),
      contentDesc: (a['content-desc'] ?? '').slice(0, maxTextLen),
      className: a.class ?? '',
      packageName: a.package ?? '',
      clickable: a.clickable === 'true',
      enabled: a.enabled !== 'false',
      bounds: { x1, y1, x2, y2 },
    });
  }
  return { nodes, stats: { parsed: nodes.length, skippedMalformed } };
}

const SELECTOR_KEYS = Object.freeze(['resourceId', 'text', 'textContains', 'contentDesc', 'contentDescContains', 'className', 'clickable']);

/**
 * AND-semantics element matching. At least one criterion is REQUIRED (an empty
 * selector matching every node is a bug, not a feature).
 */
export function findElements(nodes, selector = {}) {
  if (selector === null || typeof selector !== 'object' || Array.isArray(selector)) {
    fail('UIA_SELECTOR_INVALID', 400, 'selector must be an object');
  }
  const unknown = Object.keys(selector).filter((k) => !SELECTOR_KEYS.includes(k));
  if (unknown.length) fail('UIA_SELECTOR_INVALID', 400, `unknown selector criteria: ${unknown.join(', ')} (allowed: ${SELECTOR_KEYS.join(', ')})`);
  const active = Object.entries(selector).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!active.length) fail('UIA_SELECTOR_INVALID', 400, 'selector needs at least one criterion (empty selector would match everything)');

  return nodes.filter((n) =>
    active.every(([k, v]) => {
      switch (k) {
        case 'resourceId': return n.resourceId === v;
        case 'text': return n.text === v;
        case 'textContains': return n.text.includes(String(v));
        case 'contentDesc': return n.contentDesc === v;
        case 'contentDescContains': return n.contentDesc.includes(String(v));
        case 'className': return n.className === v;
        case 'clickable': return Boolean(v) === n.clickable;
        default: return false;
      }
    }),
  );
}

/** Candidate summaries surfaced by the AMBIGUOUS error (capped, honest). */
function candidateSummary(el) {
  return {
    resourceId: el.resourceId || null,
    text: el.text || null,
    contentDesc: el.contentDesc || null,
    bounds: el.bounds,
  };
}

/**
 * Resolve EXACTLY ONE tap target for a selector.
 *
 * @param {Array} nodes  from parseUiDump
 * @param {object} selector  findElements criteria
 * @param {object} [opts]
 * @param {number} [opts.screenWidth]  enables the off-screen contract
 * @param {number} [opts.screenHeight]
 * @returns {{x:number,y:number,element:object}} center coordinates
 */
export function pickTapTarget(nodes, selector, { screenWidth, screenHeight } = {}) {
  const matches = findElements(nodes, selector);
  if (matches.length === 0) {
    fail('UIA_ELEMENT_NOT_FOUND', 404, 'no UI element matches the selector (element absent, off-screen, or the screen changed)');
  }
  if (matches.length > 1) {
    fail('UIA_ELEMENT_AMBIGUOUS', 409, `${matches.length} UI elements match the selector — refine it (never guessing which one to tap)`, {
      count: matches.length,
      candidates: matches.slice(0, 8).map(candidateSummary),
    });
  }
  const el = matches[0];
  const x = Math.floor((el.bounds.x1 + el.bounds.x2) / 2);
  const y = Math.floor((el.bounds.y1 + el.bounds.y2) / 2);
  if (Number.isInteger(screenWidth) && Number.isInteger(screenHeight)) {
    if (x < 0 || y < 0 || x >= screenWidth || y >= screenHeight) {
      fail('UIA_ELEMENT_OFFSCREEN', 422, `element center (${x},${y}) is outside the ${screenWidth}x${screenHeight} screen — stale dump or rotated UI (rotation race)`, { x, y, bounds: el.bounds });
    }
  }
  return { x, y, element: el };
}
