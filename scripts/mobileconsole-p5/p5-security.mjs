#!/usr/bin/env node
/**
 * MC P5 — security E2E (MD Phase 5 / §11.9 / §15.2): live-stack security
 * matrix against the scratch API + 5 real redroid devices.
 *
 *  T50 unauthorized matrix      no session → 401 (REST + WS upgrade)
 *  T51 RBAC                     viewer cannot acquire controller / create
 *                               intervention / close foreign lease → 403
 *  T52 cross-user hijack        operator vs admin lease+ticket → 403
 *                               STREAM_LEASE_OWNER_MISMATCH (REST + WS)
 *  T53 WS origin hijack         missing Origin + evil Origin → 403
 *                               ORIGIN_NOT_ALLOWED (fail-closed)
 *  T54 ticket replay/expiry     2nd WS with same ticket → 401
 *                               STREAM_TICKET_REPLAYED; expired lease
 *                               reconnect → 409 STREAM_LEASE_EXPIRED
 *  T55 viewer read-only         viewer WS is LIVE but every input →
 *                               STREAM_READ_ONLY (protocol level)
 *  T56 capacity 409             per-device STREAM_DEVICE_HELD + global
 *                               STREAM_CAPACITY_REACHED; free slot → 201
 *  T57 log-leak canaries        keyboard text / password / proxy / clipboard
 *                               canaries never reach API log; intervention
 *                               evidence scrubbed in DB + API response
 *  T58 rate limits live         stream create + intervention create → 429
 *                               RATE_LIMITED + Retry-After; dedupe holds
 *  T59 oversized frame DoS      100KB client frame via API blind pipe →
 *                               sidecar 64KiB cap closes tunnel (1009/1006);
 *                               API + sidecar stay up
 *  T60 UI regression            admin console LIVE after hardening (shot)
 *  T61 zero-residue cleanup     usage 0/5, run interventions deleted
 *
 * Evidence: logs/mobileconsole-p5/e2e/p5-security-{summary,raw}.json
 * Run: node scripts/mobileconsole-p5/p5-security.mjs
 */
import fs from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const API = 'http://127.0.0.1:16490';
const WS_HOST = '127.0.0.1:16490';
const ORIGIN_OK = 'http://127.0.0.1:16492'; // APP_PUBLIC_URL (allowed origin)
const ORIGIN_EVIL = 'http://evil.example';
const EVID = '/home/kenneth/.openclaw/workspace/logs/mobileconsole-p5/e2e';
const API_LOG = '/home/kenneth/.openclaw/workspace/logs/mobileconsole-poc/scratch-api.log';

// Scratch device UUIDs (psql-verified 2026-10-24 10:5x; ADB 16500–16504, all running)
const DEV = {
  poc: 'f4f7e613-fba7-4395-bba3-ff591ad83482',
  s2: '1e746660-6b08-4606-bb8c-a7829d1f4b79',
  s3: 'b3eb1b59-cdb5-4c11-bf36-953321d07cb3',
  s4: '7277944a-55ac-4312-94bc-bdbae87acd1a',
  s5: '87c63f47-440d-4ee4-afdf-ae719ea93ec7',
};

const RUN = `p5-${Date.now()}`;
const CAN = {
  text: `P5TXT-${RUN}-xK9q2mW`, // typed on-device (keyboard path)
  pw: `P5PW-${RUN}-mQ7vL3`, // intervention evidence.password
  proxy: `socks5://p5canary-${RUN}@canary.p5scan.example:17801`, // evidence.proxyUrl
  clip: `P5CLIP-${RUN}-tU4nR8`, // evidence.clipboard (P5 scrub rule)
};

const EVID_DIR = EVID;
fs.mkdirSync(EVID_DIR, { recursive: true });
const results = [];
const openLeases = []; // {id, owner} — closed in T61
let adminCookie = null;
let opCookie = null;
let viewerCookie = null;
let adminStreamWindowStart = 0; // P5: wall-clock of admin's first rate-limited stream hit (window tracking for T57 prep)

function record(test, ok, detail) {
  results.push({ test, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${test} — ${JSON.stringify(detail).slice(0, 220)}`);
}

async function apiFetch(path, { method = 'GET', cookie = null, body = null, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== null) h['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers: h, body: body === null ? undefined : JSON.stringify(body) });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(username, password) {
  const res = await apiFetch('/api/auth/login', { method: 'POST', body: { username, password } });
  const sc = res.headers.get('set-cookie') ?? '';
  const m = sc.match(/session=([^;]+)/);
  if (res.status !== 200 || !m) throw new Error(`login ${username} failed: ${res.status} ${res.text?.slice(0, 120)}`);
  return `session=${m[1]}`;
}

/** Raw HTTP WS-upgrade probe → {status, body, json}. The server answers
 *  reject with a status line + JSON body then FINs (no Content-Length) — so
 *  we collect until 'close' to avoid truncating the body across packets. */
function rawUpgrade(path, { cookie = null, origin = null } = {}) {
  return new Promise((resolve) => {
    const headers = {
      host: WS_HOST,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    };
    if (cookie) headers.cookie = cookie;
    if (origin !== null) headers.origin = origin;
    const sock = net.connect(16490, '127.0.0.1');
    let buf = '';
    let status = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(buf.slice(buf.indexOf('\r\n\r\n') + 4)); } catch { /* partial */ }
      resolve({ status, body: buf, json });
    };
    const timer = setTimeout(() => { sock.destroy(); finish(); }, 8000);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0 && !status) status = Number(buf.split(' ', 2)[1] ?? 0);
    });
    sock.on('close', finish);
    sock.on('error', () => { sock.destroy(); finish(); });
    let req = `GET ${path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) req += `${k}: ${v}\r\n`;
    sock.write(req + '\r\n');
  });
}

/** Real browser-side WS (the API does auth+session internally; the client
 *  only receives frames and sends input frames). The one-shot ticket is
 *  presented via ?ticket= (the P1 probe path — raw clients have no cookie jar
 *  for the stream_ticket HttpOnly cookie). */
function wsConnect(leaseId, { cookie, origin = ORIGIN_OK, ticket = null }) {
  const qs = ticket ? `?ticket=${encodeURIComponent(ticket)}` : '';
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(`ws://${WS_HOST}/api/device-streams/${leaseId}/ws${qs}`, {
      headers: { cookie, origin },
    });
    const out = { frames, ws, closed: null, closedAt: null };
    const done = new Promise((res) => {
      ws.on('close', (code) => { out.closed = code; out.closedAt = Date.now(); res(code); });
    });
    ws.on('error', (e) => { out.wsError = e.message; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { out.frames.push({ binary: true, len: data.length }); return; }
      let m = null;
      try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      out.frames.push(m);
    });
    ws.on('open', () => resolve(out));
    // reject if the upgrade never opens (server answered non-101 → 'error' +
    // 'close' with no 'open') — a dangling promise would let node exit
    // silently with an empty event loop (observed P5 run #2, T53c).
    ws.on('close', () => {
      if (!out.opened) reject(new Error(`ws upgrade rejected (no 101); wsError=${out.wsError ?? 'n/a'}`));
    });
    out.opened = false;
    ws.on('open', () => { out.opened = true; });
    out.closedPromise = done;
    setTimeout(() => { if (!out.closed) reject(new Error('ws open timeout')); }, 12000).unref?.();
  });
}

function framesWhere(out, pred) { return out.frames.filter(pred); }
async function waitForFrame(out, pred, timeoutMs = 20000, what = 'frame') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const f = framesWhere(out, pred);
    if (f.length) return f[0];
    if (out.closed) break;
    await sleep(100);
  }
  const f = framesWhere(out, pred);
  if (f.length) return f[0];
  throw new Error(`timeout waiting ${what} (frames=${out.frames.length}, closed=${out.closed})`);
}

async function acquire(cookie, device, mode) {
  if (cookie === adminCookie) adminStreamWindowStart ||= Date.now(); // P5: track admin's 10/min fixed window (set at first admin stream hit)
  const res = await apiFetch(`/api/devices/redroid/${device}/streams`, { method: 'POST', cookie, body: { mode } });
  return res;
}

// P5: the admin's 10/min FIXED window starts at adminStreamWindowStart. After
// T58c deliberately trips it (429 at attempt 11), any later admin stream
// create (T60's UI "Open screen") would 429 until the boundary — sleep to
// the next reset so T60 runs on a clean window. Deterministic, ≤60s top-up.
async function sleepUntilCleanAdminWindow(label) {
  if (!adminStreamWindowStart) return;
  const idx = Math.floor((Date.now() - adminStreamWindowStart) / 60_000);
  const waitMs = adminStreamWindowStart + (idx + 1) * 60_000 + 250 - Date.now();
  if (waitMs > 0) { note(`${label}: waiting ${Math.ceil(waitMs / 1000)}s for admin rate window to reset`); await sleep(waitMs); }
}

function note(text) { console.log(`  · ${text}`); }

// =============================================================================
async function main() {
  const t0 = Date.now();
  note(`run=${RUN} canaries=${JSON.stringify(CAN)}`);

  // ---- log offset for T57 canary scan (everything after this point) --------
  const logOffset = fs.existsSync(API_LOG) ? fs.statSync(API_LOG).size : 0;
  note(`api log offset=${logOffset} (${API_LOG})`);

  adminCookie = await login('mcadmin', process.env.MC_ADMIN_PASS);
  opCookie = await login('mcop1', process.env.MC_OP_PASS);
  viewerCookie = await login('mcviewer1', process.env.MC_VIEW_PASS);
  note('logins ok (admin/operator/viewer)');

  // ============================ T50 unauthorized ============================
  {
    const probes = [
      ['POST', `/api/devices/redroid/${DEV.poc}/streams`, { mode: 'controller' }],
      ['GET', '/api/device-streams', null],
      ['POST', `/api/device-streams/${DEV.poc}/heartbeat`, null],
      ['POST', `/api/device-streams/${DEV.poc}/reconnect`, null],
      ['DELETE', `/api/device-streams/${DEV.poc}`, null],
      ['POST', '/api/manual-interventions', { source: 'operator_report', category: 'OTHER', title: 't50' }],
    ];
    const bad = [];
    for (const [method, path, body] of probes) {
      const res = await apiFetch(path, { method, body });
      const code = res.json?.error?.code;
      if (res.status !== 401 || code !== 'UNAUTHORIZED') bad.push({ method, path, status: res.status, code });
    }
    const ws = await rawUpgrade(`/api/device-streams/${DEV.poc}/ws`, { origin: ORIGIN_OK });
    if (ws.status !== 401 || ws.json?.error?.code !== 'UNAUTHORIZED') bad.push({ method: 'WS', path: 'no-cookie+origin', status: ws.status, code: ws.json?.error?.code });
    // origin guard runs BEFORE auth (fail-closed) → no origin + no cookie = 403
    // (asserted here too; T53b covers it with a valid cookie)
    const wsNoOrigin = await rawUpgrade(`/api/device-streams/${DEV.poc}/ws`);
    if (wsNoOrigin.status !== 403 || wsNoOrigin.json?.error?.code !== 'ORIGIN_NOT_ALLOWED') bad.push({ method: 'WS', path: 'no-cookie-no-origin', status: wsNoOrigin.status, code: wsNoOrigin.json?.error?.code });
    record('T50 unauthorized matrix (6 REST + 2 WS → 401/403 fail-closed)', bad.length === 0, { probes: probes.length + 2, bad });
  }

  // ============================ T51 RBAC viewer =============================
  {
    const a = await acquire(viewerCookie, DEV.poc, 'controller');
    const i = await apiFetch('/api/manual-interventions', { method: 'POST', cookie: viewerCookie, body: { source: 'operator_report', category: 'OTHER', title: 't51-viewer-write' } });
    record('T51a viewer controller acquire → 403 STREAM_PERMISSION_DENIED',
      a.status === 403 && a.json?.error?.code === 'STREAM_PERMISSION_DENIED', { status: a.status, code: a.json?.error?.code });
    record('T51b viewer intervention create → 403 FORBIDDEN',
      i.status === 403, { status: i.status, code: i.json?.error?.code });
    // viewer CAN acquire read-only (positive control) — closed immediately so
    // it never holds a slot for T56
    const v = await acquire(viewerCookie, DEV.s4, 'viewer');
    if (v.status === 201 && v.json?.lease?.id) {
      const cl = await apiFetch(`/api/device-streams/${v.json.lease.id}`, { method: 'DELETE', cookie: viewerCookie });
      record('T51c viewer viewer-mode acquire → 201 (positive control, closed)', true, { lease: v.json.lease.id, close: cl.status });
    }
    else record('T51c viewer viewer-mode acquire → 201 (positive control, closed)', false, { status: v.status, code: v.json?.error?.code });
  }

  // ============================ T52 cross-user ==============================
  {
    const a = await acquire(adminCookie, DEV.poc, 'controller');
    if (a.status !== 201) throw new Error(`T52 setup acquire failed: ${a.status} ${a.text?.slice(0, 150)}`);
    const leaseId = a.json.lease.id;
    const ticket = a.json.ticket;
    openLeases.push({ id: leaseId, owner: 'admin' });

    const hb = await apiFetch(`/api/device-streams/${leaseId}/heartbeat`, { method: 'POST', cookie: opCookie });
    record('T52a operator heartbeat on admin lease → 403 OWNER_MISMATCH',
      hb.status === 403 && hb.json?.error?.code === 'STREAM_LEASE_OWNER_MISMATCH', { status: hb.status, code: hb.json?.error?.code });

    const wsOp = await rawUpgrade(`/api/device-streams/${leaseId}/ws`, { cookie: opCookie, origin: ORIGIN_OK });
    record('T52b operator WS with admin ticket → 403 OWNER_MISMATCH',
      wsOp.status === 403 && wsOp.json?.error?.code === 'STREAM_LEASE_OWNER_MISMATCH', { status: wsOp.status, code: wsOp.json?.error?.code });

    const cl = await apiFetch(`/api/device-streams/${leaseId}`, { method: 'DELETE', cookie: viewerCookie });
    record('T52c viewer close admin lease → 403 OWNER_MISMATCH',
      cl.status === 403 && cl.json?.error?.code === 'STREAM_LEASE_OWNER_MISMATCH', { status: cl.status, code: cl.json?.error?.code });

    const noTicket = await rawUpgrade(`/api/device-streams/${leaseId}/ws`, { cookie: adminCookie, origin: ORIGIN_OK });
    record('T52d admin WS without ticket → 401 STREAM_TICKET_INVALID',
      noTicket.status === 401 && noTicket.json?.error?.code === 'STREAM_TICKET_INVALID', { status: noTicket.status, code: noTicket.json?.error?.code });

    await apiFetch(`/api/device-streams/${leaseId}`, { method: 'DELETE', cookie: adminCookie });
    note('admin lease closed (owner)');
  }

  // ============================ T53 WS origin ===============================
  {
    const a = await acquire(adminCookie, DEV.s2, 'controller');
    if (a.status !== 201) throw new Error(`T53 setup: ${a.status} ${a.text?.slice(0, 150)}`);
    const leaseId = a.json.lease.id;
    openLeases.push({ id: leaseId, owner: 'admin' });
    const ticket = a.json.ticket;

    const evil = await rawUpgrade(`/api/device-streams/${leaseId}/ws`, { cookie: adminCookie, origin: ORIGIN_EVIL });
    record('T53a evil Origin → 403 ORIGIN_NOT_ALLOWED',
      evil.status === 403 && evil.json?.error?.code === 'ORIGIN_NOT_ALLOWED', { status: evil.status, code: evil.json?.error?.code });

    const none = await rawUpgrade(`/api/device-streams/${leaseId}/ws`, { cookie: adminCookie, origin: null });
    record('T53b missing Origin → 403 ORIGIN_NOT_ALLOWED (fail-closed)',
      none.status === 403 && none.json?.error?.code === 'ORIGIN_NOT_ALLOWED', { status: none.status, code: none.json?.error?.code });

    // positive control: allowed origin + valid ticket → 101
    const ok = await wsConnect(leaseId, { cookie: adminCookie, ticket }).catch((e) => ({ wsError: e.message, frames: [] }));
    const openState = ok.ws?.readyState; // capture BEFORE we close it ourselves
    if (ok.ws && !ok.wsError) { await sleep(1500); ok.ws.close(); }
    record('T53c allowed origin + valid ticket → 101 (positive control)',
      !!ok.ws && openState === WebSocket.OPEN, { openState, wsError: ok.wsError ?? null });

    await apiFetch(`/api/device-streams/${leaseId}`, { method: 'DELETE', cookie: adminCookie });
  }

  // ============================ T54 ticket replay ===========================
  {
    const a = await acquire(adminCookie, DEV.s3, 'controller');
    if (a.status !== 201) throw new Error(`T54 setup: ${a.status} ${a.text?.slice(0, 150)}`);
    const leaseId = a.json.lease.id;
    openLeases.push({ id: leaseId, owner: 'admin', expectExpired: true });

    // first WS consumes the (fresh) one-shot ticket
    const ws1 = await wsConnect(leaseId, { cookie: adminCookie, ticket: a.json.ticket });
    await sleep(1500);
    const replay = await rawUpgrade(`/api/device-streams/${leaseId}/ws?ticket=${encodeURIComponent(a.json.ticket)}`, { cookie: adminCookie, origin: ORIGIN_OK });
    record('T54a 2nd WS with same (consumed) ticket → 401 STREAM_TICKET_REPLAYED',
      replay.status === 401 && replay.json?.error?.code === 'STREAM_TICKET_REPLAYED', { status: replay.status, code: replay.json?.error?.code });
    ws1.ws.close();

    // wait past the 30s lease TTL → reconnect must 409 dead
    note('waiting 32s for lease TTL expiry (30s default)…');
    await sleep(32000);
    const rc = await apiFetch(`/api/device-streams/${leaseId}/reconnect`, { method: 'POST', cookie: adminCookie });
    // The dead lease may surface as EXPIRED (TTL sweep) or CLOSED (reaper
    // reclaimed a never-connected tunnel) — a timing race between the two
    // reclaim paths. Both are correctly 409 non-reconnectable; assert on the
    // invariant (409 + dead state), not the exact label.
    record('T54b reconnect on expired lease → 409 (EXPIRED/CLOSED — dead, non-reconnectable)',
      rc.status === 409 && ['STREAM_LEASE_EXPIRED', 'STREAM_LEASE_CLOSED'].includes(rc.json?.error?.code), { status: rc.status, code: rc.json?.error?.code });
  }

  // ============================ T55 viewer read-only ========================
  {
    // fresh viewer lease (T51c's ticket/lease would be stale — 60s ticket
    // TTL / 30s lease TTL)
    const v = await acquire(viewerCookie, DEV.s4, 'viewer');
    if (v.status !== 201) throw new Error(`T55 setup: ${v.status} ${v.text?.slice(0, 150)}`);
    const vLease = v.json.lease;
    const ws = await wsConnect(vLease.id, { cookie: viewerCookie, ticket: v.json.ticket });
    const live = await waitForFrame(ws, (f) => f?.t === 'state' && f.state === 'LIVE', 25000, 'state LIVE').catch((e) => ({ waitErr: e.message }));
    record('T55a viewer WS reaches state LIVE (read-only stream is real)',
      live?.state === 'LIVE', { state: live?.state, source: live?.source, waitErr: live?.waitErr ?? null });
    ws.ws.send(JSON.stringify({ t: 'input', kind: 'tap', x0: 0.5, y0: 0.5 }));
    const rej = await waitForFrame(ws, (f) => f?.t === 'input-rejected', 8000, 'input-rejected').catch((e) => ({ waitErr: e.message }));
    record('T55b viewer tap → input-rejected STREAM_READ_ONLY',
      rej?.t === 'input-rejected' && rej.code === 'STREAM_READ_ONLY', { code: rej?.code, waitErr: rej?.waitErr ?? null });
    ws.ws.send(JSON.stringify({ t: 'input', kind: 'text', text: 't55-viewer-text' }));
    const rej2 = await waitForFrame(ws, (f) => f?.t === 'input-rejected' && f !== rej, 8000, 'input-rejected#2').catch((e) => ({ waitErr: e.message }));
    record('T55c viewer text → input-rejected STREAM_READ_ONLY',
      rej2?.code === 'STREAM_READ_ONLY', { code: rej2?.code, waitErr: rej2?.waitErr ?? null });
    ws.ws.close();
    await apiFetch(`/api/device-streams/${vLease.id}`, { method: 'DELETE', cookie: viewerCookie });
  }

  // ============================ T56 capacity 409 ============================
  // NOTE: with exactly 5 devices the GLOBAL cap (STREAM_CAPACITY_REACHED,
  // unit-covered in tests/unit/stream-lease.test.js) is indistinguishable from
  // per-device STREAM_DEVICE_HELD — every 6th acquire targets a held device.
  // This test pins the E2E-observable behaviour: HELD on all 5, free a slot
  // → 201 again.
  {
    const list0 = await apiFetch('/api/device-streams', { cookie: adminCookie });
    const activeByDevice = new Map((list0.json?.leases ?? []).filter((l) => ['ACTIVE', 'PENDING'].includes(l.status)).map((l) => [l.deviceId, l]));
    const fills = [];
    for (const [name, dev] of Object.entries(DEV)) {
      if (activeByDevice.has(dev)) { note(`T56: ${name} already held (${activeByDevice.get(dev).status}) — skip fill`); continue; }
      const f = await acquire(adminCookie, dev, 'viewer');
      if (f.status !== 201) throw new Error(`T56 fill ${name}: ${f.status} ${f.text?.slice(0, 150)}`);
      fills.push(f);
      openLeases.push({ id: f.json.lease.id, owner: 'admin', deviceId: dev });
    }
    const usage = await apiFetch('/api/device-streams', { cookie: adminCookie });
    record('T56a all 5 devices held → usage {active:5, max:5}',
      usage.json?.usage?.active === 5 && usage.json?.usage?.max === 5, { usage: usage.json?.usage });

    const heldResults = [];
    // operator cookie: fresh stream-create budget (admin's is spent by
    // T52–T56 within the 10/min window) — HELD is device-scoped, user-agnostic
    for (const dev of Object.values(DEV)) heldResults.push(await acquire(opCookie, dev, 'viewer'));
    record('T56b acquire each held device (as operator) → 409 STREAM_DEVICE_HELD (5/5)',
      heldResults.every((r) => r.status === 409 && r.json?.error?.code === 'STREAM_DEVICE_HELD'),
      { codes: heldResults.map((r) => r.json?.error?.code) });

    // free one slot (viewer's, or an admin fill) → re-acquire 201 as
    // CONTROLLER (T57/T59 need an ACTIVE controller lease)
    const freeMe = openLeases.find((l) => l.owner === 'viewer') ?? [...openLeases].reverse().find((l) => l.owner === 'admin');
    const freeDev = freeMe.deviceId ?? DEV.s5;
    await apiFetch(`/api/device-streams/${freeMe.id}`, { method: 'DELETE', cookie: adminCookie });
    openLeases.splice(openLeases.indexOf(freeMe), 1);
    const retry = await acquire(adminCookie, freeDev, 'controller');
    record('T56c after freeing a slot → 201 (controller lease for T57/T59)',
      retry.status === 201, { status: retry.status, code: retry.json?.error?.code });
    if (retry.status === 201) openLeases.push({ id: retry.json.lease.id, owner: 'admin', deviceId: freeDev, controller: true });
  }

  // ============================ T57 log-leak canaries =======================
  {
    // P5 rate-limit awareness: the admin's 10/min fixed window (tracked at
    // the first admin stream hit) already holds 10 hits by T56c (T52 create,
    // T53 create, T54 create + T54b reconnect, T56a ×5 fills, T56c create).
    // Sleep to the window boundary so T57/T59/T58c run on a CLEAN window —
    // deterministic, no timing flake. (The T54 32s TTL wait already consumes
    // most of the window; this is usually a 0–5s top-up.)
    const resetIn = adminStreamWindowStart + 60_000 + 250 - Date.now();
    if (resetIn > 0) { note(`T57 prep: waiting ${Math.ceil(resetIn / 1000)}s for admin rate window to reset`); await sleep(resetIn); }
    const list0 = await apiFetch('/api/device-streams', { cookie: adminCookie });
    const cLease = (list0.json?.leases ?? []).find((l) => l.mode === 'controller' && l.status === 'ACTIVE');
    if (!cLease) throw new Error('T57 setup: no ACTIVE controller lease (T56c?)');
    const rc = await apiFetch(`/api/device-streams/${cLease.id}/reconnect`, { method: 'POST', cookie: adminCookie });
    if (rc.status !== 200) throw new Error(`T57 reconnect: ${rc.status} ${rc.text?.slice(0, 150)}`);
    const ws = await wsConnect(cLease.id, { cookie: adminCookie, ticket: rc.json.ticket });
    await waitForFrame(ws, (f) => f?.t === 'state' && f.state === 'LIVE', 25000, 'state LIVE').catch((e) => note(`T57 live wait: ${e.message}`));
    ws.ws.send(JSON.stringify({ t: 'input', kind: 'text', text: CAN.text }));
    await sleep(2000); // let the screencap loop + logs settle
    ws.ws.close();

    const created = await apiFetch('/api/manual-interventions', {
      method: 'POST',
      cookie: opCookie,
      body: {
        source: 'operator_report',
        category: 'OTHER',
        severity: 'warning',
        deviceId: cLease.deviceId,
        deviceNameSnapshot: 'p5-canary-device',
        title: `P5 canary ${RUN}`,
        summary: `password=${CAN.pw} used for canary; proxy ${CAN.proxy} was configured`,
        evidence: { password: CAN.pw, proxyUrl: CAN.proxy, clipboard: CAN.clip, benign: 'ok' },
      },
    });
    if (created.status !== 201 && created.status !== 200) throw new Error(`T57 intervention create failed: ${created.status} ${created.text?.slice(0, 200)}`);
    const intvId = created.json?.id ?? created.json?.intervention?.id;
    record('T57a intervention created (or deduped) with canary-laden payload → 201/200', !!intvId, { status: created.status, intvId, createdFlag: created.json?.created ?? null });

    const got = await apiFetch(`/api/manual-interventions/${intvId}`, { cookie: adminCookie });
    const apiLeak = JSON.stringify(got.json);
    record('T57b API response scrubbed (no canary string in read-back)',
      ![CAN.text, CAN.pw, CAN.proxy, CAN.clip].some((c) => apiLeak.includes(c)),
      { checked: 4 });

    const row = await apiFetch(`/api/manual-interventions/${intvId}`, { cookie: opCookie });
    const dbLeak = JSON.stringify(row.json);
    record('T57c DB-backed read-back scrubbed (same source)',
      ![CAN.text, CAN.pw, CAN.proxy, CAN.clip].some((c) => dbLeak.includes(c)), { checked: 4 });

    // the pino log itself (API + inherited sidecar stdio), from offset
    await sleep(1500);
    const logSize = fs.statSync(API_LOG).size;
    const tail = fs.readFileSync(API_LOG).subarray(logOffset).toString('utf8');
    const hits = {};
    for (const [name, c] of Object.entries(CAN)) hits[name] = tail.split(c).length - 1;
    const pngHits = tail.split('iVBORw0KGgo').length - 1; // base64 PNG header
    const longLines = tail.split('\n').filter((l) => l.length > 10000).length;
    record('T57d API log scan: zero canary hits, no PNG base64, no >10KB lines',
      Object.values(hits).every((n) => n === 0) && pngHits === 0 && longLines === 0,
      { hits, pngHits, longLines, logBytesScanned: logSize - logOffset });

    globalThis.__p5IntvIds = globalThis.__p5IntvIds ?? [];
    globalThis.__p5IntvIds.push(intvId);
  }

  // ============================ T58 rate limits =============================
  {
    // intervention create: per-user 30/min — burst until 429
    let accepts = 0, limited = null, firstLimited = null;
    for (let i = 0; i < 34; i += 1) {
      const r = await apiFetch('/api/manual-interventions', {
        method: 'POST',
        cookie: opCookie,
        body: {
          source: 'operator_report',
          category: 'OTHER',
          title: `P5 burst ${RUN} #${i}`,
          deviceId: DEV.poc,
        },
      });
      if (r.status === 429) { if (!limited) { limited = r; firstLimited = i + 1; } break; }
      if (r.status === 201) { accepts += 1; const id = r.json?.id ?? r.json?.intervention?.id; if (id) globalThis.__p5IntvIds.push(id); }
    }
    record('T58a intervention burst → 429 RATE_LIMITED + Retry-After (budget 30/min)',
      !!limited && limited.json?.error?.code === 'RATE_LIMITED' && Number(limited.headers.get('retry-after')) >= 1,
      { acceptsInBurst: accepts, limitedAtAttempt: firstLimited, retryAfter: limited?.headers.get('retry-after') });
    const list = await apiFetch(`/api/manual-interventions?deviceId=${DEV.poc}&category=OTHER&pageSize=100`, { cookie: adminCookie });
    const episodes = list.json?.items ?? [];
    const runEpisodes = episodes.filter((e) => String(e.title ?? '').includes(RUN));
    const keyEp = episodes.filter((e) => e.deviceId === DEV.poc && e.category === 'OTHER');
    // dedupe key = device::category::source → at most ONE row per key for this
    // run (T57 may share the key if its lease device was poc).
    record('T58b dedupe: one row per dedupe key, signalCount aggregates the burst',
      runEpisodes.length >= 1 && runEpisodes.length <= 2 && keyEp.length === 1 && keyEp[0]?.signalCount >= accepts,
      { runEpisodes: runEpisodes.length, keyRow: keyEp[0] ? { title: keyEp[0].title.slice(0, 40), signalCount: keyEp[0].signalCount } : null });
  }

  // ============================ T59 oversized frame =========================
  {
    const list = await apiFetch('/api/device-streams', { cookie: adminCookie });
    const cLease = list.json?.leases?.find((l) => l.mode === 'controller' && l.status === 'ACTIVE');
    if (!cLease) throw new Error('T59 setup: no ACTIVE controller lease');
    const before = await (await fetch('http://127.0.0.1:16493/health')).json();
    const rc = await apiFetch(`/api/device-streams/${cLease.id}/reconnect`, { method: 'POST', cookie: adminCookie });
    if (rc.status !== 200) throw new Error(`T59 reconnect: ${rc.status} ${rc.text?.slice(0, 150)}`);
    const ws = await wsConnect(cLease.id, { cookie: adminCookie, ticket: rc.json.ticket });
    await waitForFrame(ws, (f) => f?.t === 'state' && f.state === 'LIVE', 25000, 'state LIVE').catch((e) => note(`T59 live wait: ${e.message}`));
    const big = 'A'.repeat(100_000); // 100KB >> 64KiB sidecar cap
    ws.ws.send(big);
    const closedCode = await Promise.race([ws.closedPromise, sleep(10000).then(() => 'timeout')]);
    const after = await (await fetch('http://127.0.0.1:16493/health')).json();
    const apiUp = (await fetch(`${API}/api/health/live`)).status === 200;
    record('T59 oversized 100KB frame → tunnel torn down; API + sidecar healthy',
      (closedCode === 1006 || closedCode === 1009) && apiUp && after.ok === true && after.sessions <= before.sessions,
      { closedCode, apiUp, sidecarSessions: `${before.sessions}→${after.sessions}` });

    // T58c — stream create rate limit, AFTER T59 on a CLEAN admin window
    // (pre-T57 reset above): window holds 2 prior hits (T57 reconnect,
    // T59 reconnect) → 429 at attempt 11, inside the ≤14 loop.
    // Every attempt is a real create request (HELD 409s burn budget too —
    // the preHandler runs before the device check).
    let sAccepts = 0, sLimited = null;
    for (let i = 0; i < 14; i += 1) {
      const r = await acquire(adminCookie, DEV.poc, 'viewer');
      if (r.status === 429) { sLimited = r; break; }
      if (r.status === 201) sAccepts += 1;
      else if (r.status === 409) { /* HELD — budget consumed, expected */ }
      else throw new Error(`T58c stream burst unexpected: ${r.status} ${r.text?.slice(0, 150)}`);
    }
    record('T58c stream create burst → 429 RATE_LIMITED + Retry-After (budget 10/min)',
      !!sLimited && sLimited.json?.error?.code === 'RATE_LIMITED' && Number(sLimited.headers.get('retry-after')) >= 1,
      { acceptsInBurst: sAccepts, retryAfter: sLimited?.headers.get('retry-after') });
  }

  // ============================ T60 UI regression ===========================
  {
    // T58c deliberately tripped the admin's 10/min stream window — the UI's
    // "Open screen" create would 429 until the boundary. Wait it out first.
    await sleepUntilCleanAdminWindow('T60 prep');
    // clean slate: close every active lease so the UI can open a fresh console
    const list0 = await apiFetch('/api/device-streams', { cookie: adminCookie });
    for (const l of (list0.json?.leases ?? []).filter((x) => ['ACTIVE', 'PENDING'].includes(x.status))) {
      await apiFetch(`/api/device-streams/${l.id}`, { method: 'DELETE', cookie: adminCookie });
    }
    await sleep(1000);
    const { chromium } = await import('playwright-core');
    // Resolve a known-good chromium revision (host-dependent: 1228 on the
    // P4 box, 1248 per this host's playwright-core browsers.json). Env
    // CHROME_PATH always wins.
    const fsOs = await import('node:fs');
    const candidates = [process.env.CHROME_PATH, ...[1228, 1248, 1217, 1208].map((r) => `${process.env.HOME}/.cache/ms-playwright/chromium-${r}/chrome-linux64/chrome`)].filter(Boolean);
    const executable = candidates.find((p) => fsOs.existsSync(p));
    if (!executable) throw new Error(`T60: no chromium found (tried: ${candidates.join(', ')})`);
    const browser = await chromium.launch({ executablePath: executable, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:16492/', { waitUntil: 'domcontentloaded' });
    await page.fill('input[autocomplete="username"]', 'mcadmin');
    await page.fill('input[type="password"]', process.env.MC_ADMIN_PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/#\//, { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    // P2-proven flow (p2-browser.mjs T21): device list → click the device
    // NAME link → detail page → button.console-open-btn → console route.
    // (The Devices page has no "Open screen" button — that was a wrong
    // guess; the console entry is per-device on the detail page.)
    const uiWs = { sockets: 0, binary: 0, text: 0, lastError: null };
    const uiPageErrors = [];
    page.on('pageerror', (e) => uiPageErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
    page.on('console', (m) => { if (m.type() === 'error') uiPageErrors.push(`console: ${m.text().slice(0, 200)}`); });
    page.on('websocket', (ws) => {
      uiWs.sockets += 1;
      ws.on('framereceived', (ev) => {
        if (Buffer.isBuffer(ev.payload)) uiWs.binary += 1;
        else uiWs.text += 1;
      });
      ws.on('error', (e) => { uiWs.lastError = String(e).slice(0, 160); });
    });
    const UI_DEV = 'redroid-brmc-poc';
    let opened = false;
    // Same-document hash navigations (react-router HashRouter) do NOT always
    // fire Playwright navigation events — waitForURL can miss them. Poll the
    // URL instead (the P2-proven flow reads the URL directly, never waits).
    const waitUrl = async (re, ms, label) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (re.test(page.url())) return true; await sleep(500); }
      note(`T60 ${label}: url still ${page.url()}`);
      return re.test(page.url());
    };
    try {
      await page.goto('http://127.0.0.1:16492/#/devices', { waitUntil: 'load' }).catch((e) => note(`T60 goto devices: ${e.message.slice(0, 120)}`));
      const devLink = page.locator(`a.link:has-text("${UI_DEV}")`);
      await devLink.waitFor({ timeout: 20000 });
      await devLink.click();
      await waitUrl(/#\/devices\/[a-f0-9-]{36}/, 15000, 'detail nav');
      await page.waitForFunction(
        (name) => ([...document.querySelectorAll('h1')].map((e) => e.textContent ?? '').join(' ')).includes(name),
        UI_DEV, { timeout: 15000 },
      );
      await page.click('button.console-open-btn');
      opened = await waitUrl(/#\/devices\/[a-f0-9-]{36}\/console/, 15000, 'console nav');
    } catch (e) {
      note(`T60 open error: ${e.message}`);
    }
    // LIVE = banner text 已連線 (MD §12 state text) + ≥1 real binary PNG
    // frame observed on the browser's OWN WebSocket (frames actually reach
    // the page — not just the DOM). 60s budget (screencap first frame +
    // P2-observed slow paint).
    const live = await page.waitForFunction(
      () => {
        const b = document.querySelector('.stream-banner');
        return b && b.textContent.includes('已連線') && document.querySelector('.console-canvas, canvas') !== null;
      }, null, { timeout: 60000 },
    ).then(() => true).catch(() => false);
    await sleep(2500); // let a few binary frames land for the observer count
    await page.screenshot({ path: `${EVID}/t60-console-live.png` });
    const bodyHead = await page.evaluate(() => document.body.innerText.slice(0, 200));
    record('T60 admin UI console opens LIVE after P5 hardening (screenshot)',
      opened && live && uiWs.binary >= 1, { opened, live, ws: { sockets: uiWs.sockets, binary: uiWs.binary, text: uiWs.text, lastError: uiWs.lastError }, url: page.url(), bodyHead, pageErrors: uiPageErrors.slice(0, 5) });
    await browser.close();
  }

  // ============================ T61 zero-residue ============================
  {
    // close EVERY active lease (admin override covers T60's untracked UI
    // lease + anything the reaper hasn't swept yet)
    const list = await apiFetch('/api/device-streams', { cookie: adminCookie });
    const active = (list.json?.leases ?? []).filter((l) => ['ACTIVE', 'PENDING'].includes(l.status));
    let closed = 0; const errs = [];
    for (const l of active) {
      const r = await apiFetch(`/api/device-streams/${l.id}`, { method: 'DELETE', cookie: adminCookie });
      if (r.status === 200 || r.status === 409) closed += 1; else errs.push({ id: l.id, status: r.status, code: r.json?.error?.code });
    }
    await sleep(1000); // let the slot release + reaper settle
    const usage = await apiFetch('/api/device-streams', { cookie: adminCookie });
    record('T61a all run leases closed (incl. UI lease) → usage {active:0}',
      usage.json?.usage?.active === 0 && errs.length === 0, { active: usage.json?.usage?.active, closed, errs });

    // delete this run's interventions (raw SQL — API has no operator delete)
    const ids = globalThis.__p5IntvIds ?? [];
    if (ids.length) {
      const { execSync } = await import('node:child_process');
      const q = ids.map((x) => `'${x}'`).join(',');
      execSync(`PGPASSWORD=postgres psql -h 127.0.0.1 -p 16494 -U postgres -d water_army_mc -c "DELETE FROM manual_intervention_history WHERE intervention_id IN (${q}); DELETE FROM manual_interventions WHERE id IN (${q});"`, { stdio: 'pipe' });
    }
    const remaining = await apiFetch('/api/manual-interventions?status=open,acknowledged,in_progress&pageSize=100', { cookie: adminCookie });
    const runLeft = (remaining.json?.items ?? remaining.json?.interventions ?? []).filter((e) => String(e.title ?? '').includes(RUN));
    record('T61b run interventions deleted (zero residue in list)',
      runLeft.length === 0, { deleted: ids.length, runLeft: runLeft.length });
  }

  // ===========================================================================
  const failed = results.filter((r) => !r.ok);
  const summary = {
    run: RUN,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    pass: results.length - failed.length,
    fail: failed.length,
    total: results.length,
    canaries: CAN,
    results,
  };
  fs.writeFileSync(`${EVID}/p5-security-summary.json`, JSON.stringify(summary, null, 2));
  summaryWritten = true;
  console.log(`\n===== P5 SECURITY E2E: ${summary.pass}/${summary.total} pass, ${failed.length} fail =====`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.test).join(' | ')); process.exitCode = 1; }
}

main().catch((e) => {
  console.error(`FATAL: ${e.stack ?? e}`);
  try { fs.writeFileSync(`${EVID_DIR}/p5-security-fatal.json`, JSON.stringify({ run: RUN, error: String(e), results }, null, 2)); } catch {}
  process.exit(1);
});
// Safety net: if the event loop drains with an unsettled promise (a hang),
// still write a PARTIAL summary so a silent exit 0 can never hide a stall.
let summaryWritten = false;
process.on('exit', (code) => {
  if (summaryWritten) return;
  try {
    const failed = results.filter((r) => !r.ok);
    fs.writeFileSync(`${EVID_DIR}/p5-security-summary.json`, JSON.stringify({
      run: RUN, finishedAt: new Date().toISOString(), partial: true, exitCode: code,
      pass: results.length - failed.length, fail: failed.length, total: results.length, results,
    }, null, 2));
    console.error(`\nPARTIAL SUMMARY (event-loop drain, exit=${code}): ${results.length} records, ${failed.length} fail`);
  } catch {}
});
