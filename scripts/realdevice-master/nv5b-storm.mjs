/**
 * DERIVED 2026-10-26 (realdevice-master ticket) from scripts/mobileconsole-nv/nv5-cookie-slot.mjs —
 * identical logic; only DEVICES (rdev-n1..n5), VICTIM (rdev-n2), EVID path swapped.
 * Rerun purpose: ADR-024 idempotent ticket — storm auto-recovery expected 5/5 LIVE
 * (was 0/5 pre-ADR-024).
 */
/**
 * NV5 (gen9, 2026-10-24) — cookie-slot concurrency on the SCREENCAP path:
 * five-way concurrent consoles + reconnect storms.
 *
 * Boss decision 2026-10-24 14:09 (NV5): "先檢查佢同 H.264 嘅實際程式依賴；
 * 除非有證據證明必須依賴 H.264，否則先用 Screencap 跑五路並發測試，確認連線
 * 建立、資源租約、權限、釋放均正常。"
 *
 * CODE-ANALYSIS CONCLUSION (see docs — the script is the behavioral proof):
 *   The stream_ticket one-shot cookie is a SINGLE browser cookie slot
 *   (domain+path+name = 127.0.0.1//api/device-streams/stream_ticket).
 *   The ticket/auth layer is video-source INDEPENDENT: acquire/reconnect
 *   (routes/device-streams.js) set the cookie regardless of video source;
 *   the gateway (stream-gateway.js authenticateUpgrade) verifies the ticket
 *   HMAC-bound to (user, device, lease-mode) BEFORE the sidecar is touched;
 *   videoSource (screencap|scrcpy|auto) is chosen post-auth and only affects
 *   what the sidecar frame loop emits. screencap therefore rides the exact
 *   same cookie-slot mechanism — the P3 "cookie slot" known limitation is
 *   NOT scrcpy-path-specific (contrary to the P5 final-report NV5 row).
 *
 * Scenarios (real UI + real devices, screencap = pinned-image reality):
 *   NV5-1 five-way establish  — 5 tiles (paced open, P3-proven order), all
 *         LIVE with frames flowing, usage 5/5, lease inventory intact
 *         (owner/mode/device per lease)
 *   NV5-2 permissions @ 5/5   — foreign operator vs the 5 admin leases:
 *         heartbeat×5 + close + reconnect all 403 STREAM_LEASE_OWNER_MISMATCH;
 *         admin heartbeat control 200; no side effect
 *   NV5-3 reconnect storm #1  — FORCE-KILL one path (victim WS closed
 *         abruptly = network-drop semantics): the victim auto-runs
 *         POST /reconnect (fresh ticket, cookie overwritten) → LIVE again;
 *         the OTHER 4 tiles must stay LIVE with strictly increasing frames
 *         (their tunnels are already upgraded — the cookie is read at
 *         upgrade time only); usage stays 5/5 (reconnect ≠ release)
 *   NV5-4 reconnect storm #2  — (OBSERVATION, real force-kill) SIGKILL the
 *         sidecar → ALL 5 tunnels die simultaneously → 5 concurrent
 *         auto-reconnects through the single cookie slot. Records per-tile
 *         recovery, the /reconnect POST timeline (incl. 429s — the P5
 *         10/min create+reconnect budget is shared), and whether every tile
 *         self-heals or some need manual recovery. This measures the
 *         documented livelock risk on the screencap path.
 *   NV5-5 release             — close all → usage 0/5 + zero ACTIVE leases
 *
 * Evidence: logs/mobileconsole-nv/e2e/ (JSON + screenshots, zero secrets).
 * Run: MC_ADMIN_USER/MC_ADMIN_PASS (env.sh)  node nv5-cookie-slot.mjs
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';

const WEB = process.env.MC_WEB ?? 'http://127.0.0.1:16492';
const API = process.env.MC_API ?? 'http://127.0.0.1:16490';
const EVID = process.env.MC_EVID ?? '/home/kenneth/.openclaw/workspace/water_army/logs/realdevice-master/nv5b';
const DEVICES = ['redroid-rdev-n1', 'redroid-rdev-n2', 'redroid-rdev-n3', 'redroid-rdev-n4', 'redroid-rdev-n5'];
const VICTIM = 'redroid-rdev-n2';
const OP_USER = 'rdev-op1'; // rdev scratch seeded operator (seed-users.mjs)
const OP_PASS = 'rdev-e2e-op-pw';
const SIDECAR_HEALTH = 'http://127.0.0.1:16493/health';
const RUN = `nv5-${randomBytes(3).toString('hex')}`;
fs.mkdirSync(EVID, { recursive: true });

const startedAt = new Date().toISOString();
const results = [];
const mark = (t, ok, detail) => {
  results.push({ t, ok, detail });
  console.log(`MARK ${t} ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
};
const say = (m) => console.log(`[nv5-e2e ${new Date().toISOString()}] ${m}`);
const ev = (name, obj) => {
  const p = `${EVID}/${name}`;
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  say(`evidence → ${p}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

async function login(browser, user, pass, { withWsRegistry = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  if (withWsRegistry) {
    // Register every WebSocket constructed in this context (test seam only —
    // mirrors what the browser does; lets the harness force-kill ONE path).
    await ctx.addInitScript(() => {
      if (window.__wsRegistry) return;
      window.__wsRegistry = [];
      const OW = window.WebSocket;
      window.WebSocket = new Proxy(OW, {
        construct(target, args) {
          const ws = new target(...args);
          window.__wsRegistry.push({ url: String(args[0]), ref: ws, at: Date.now() });
          return ws;
        },
      });
    });
  }
  const page = await ctx.newPage();
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', pass);
  await page.click('button[type="submit"]');
  const ok = await page
    .waitForSelector('.login-card', { state: 'detached', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 500));
    await ctx.close().catch(() => {});
    throw new Error(`login failed for ${user} — page: ${body}`);
  }
  return { ctx, page };
}

async function gotoFleet(page) {
  await page.goto(`${WEB}/#/devices/fleet`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2_000);
}
async function slotCount(page) {
  return page.evaluate(() => {
    const pill = [...document.querySelectorAll('.fleet-usage')].map((e) => e.textContent).join(' ');
    const m = /(\d+)\s*\/\s*(\d+)/.exec(pill);
    return m ? Number(m[1]) : -1;
  });
}
async function waitSlot(page, want, budgetMs = 60_000) {
  const t0 = now();
  for (;;) {
    if ((await slotCount(page)) === want) return true;
    if (now() - t0 > budgetMs) return false;
    await sleep(1_000);
  }
}
async function openChip(page, name) {
  const chip = page.locator('.chip', { hasText: name }).first();
  await chip.waitFor({ state: 'visible', timeout: 15_000 });
  if (await chip.isEnabled()) await chip.click({ timeout: 10_000 });
}
async function tileRows(page, n) {
  // Per-tile: name, state, frames (from the 幀 dd), error box
  return page.evaluate((cnt) => {
    const tiles = [...document.querySelectorAll('.fleet-tile')];
    const out = [];
    for (let i = 0; i < Math.min(cnt, tiles.length); i += 1) {
      const t = tiles[i];
      let frames = -1;
      const dts = [...t.querySelectorAll('dt')];
      const i2 = dts.findIndex((d) => (d.textContent ?? '').trim() === '幀');
      if (i2 >= 0) {
        const m = (dts[i2].nextElementSibling?.textContent ?? '').match(/(\d+)/);
        frames = m ? Number(m[1]) : -1;
      }
      out.push({
        name: t.querySelector('h3')?.textContent ?? null,
        state: ((t.className.match(/stream-([a-z_]+)/) ?? [])[1] ?? '?').toUpperCase(),
        frames,
        error: t.querySelector('.error-box')?.textContent ?? null,
      });
    }
    return out;
  }, n);
}
async function waitAllLive(page, n, budgetMs = 120_000) {
  const t0 = now();
  let st = [];
  for (;;) {
    st = await tileRows(page, n);
    if (st.length === n && st.every((s) => s.state.startsWith('LIVE'))) return st;
    if (now() - t0 > budgetMs) return st;
    await sleep(2_000);
  }
}
function tileByName(rows, name) {
  return rows.find((r) => r.name === name) ?? null;
}

(async () => {
  say(`start run=${RUN}`);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // HTTP truth: every stream acquire/reconnect the admin page makes
  const httpSeen = [];
  const admin = await login(browser, 'rdev-admin', 'rdev-e2e-admin-pw', { withWsRegistry: true });
  admin.ctx.on('response', async (r) => {
    try {
      const u = r.url();
      if (r.request().method() !== 'POST') return;
      const mAcq = /\/api\/devices\/redroid\/[^/]+\/streams$/.exec(u);
      const mRec = /\/api\/device-streams\/[^/]+\/reconnect$/.exec(u);
      if (!mAcq && !mRec) return;
      const entry = {
        kind: mAcq ? 'acquire' : 'reconnect',
        url: u.replace(API, ''),
        status: r.status(),
        atMs: Date.now(),
        retryAfter: r.status() === 429 ? r.headers()['retry-after'] ?? null : null,
      };
      if (entry.status >= 400) {
        try {
          const b = await r.json();
          entry.code = b.error?.code ?? null;
        } catch { /* keep status only */ }
      }
      httpSeen.push(entry);
    } catch { /* listener must never throw */ }
  });
  await gotoFleet(admin.page);
  const op = await login(browser, OP_USER, OP_PASS);
  await gotoFleet(op.page);

  const devList = await admin.ctx.request.get(`${API}/api/devices/redroid`).then((r) => r.json());
  const dev = Object.fromEntries(devList.devices.map((d) => [d.name, d.id]));
  for (const n of DEVICES) if (!dev[n]) throw new Error(`device ${n} missing from API list`);
  const adminId = (await admin.ctx.request.get(`${API}/api/auth/me`).then((r) => r.json())).user.id;
  const opId = (await op.ctx.request.get(`${API}/api/auth/me`).then((r) => r.json())).user.id;

  const usageNow = async () => {
    const j = await admin.ctx.request.get(`${API}/api/device-streams`).then((r) => r.json()).catch(() => ({}));
    return { usage: j.usage ?? null, active: (j.leases ?? []).filter((l) => l.status === 'ACTIVE') };
  };

  // clean slate (stale leases from an interrupted run expire on their own)
  let u = await usageNow();
  if (u.usage?.active !== 0) {
    say(`usage ${u.usage.active}/5 at start — waiting for stale leases to expire`);
    const t0 = now();
    while (((await usageNow()).usage?.active ?? 1) !== 0 && now() - t0 < 120_000) await sleep(3_000);
  }

  // ================= NV5-1: five-way establish (screencap) =====================
  {
    const s0 = await slotCount(admin.page);
    for (const name of DEVICES) {
      await openChip(admin.page, name);
      say(`tile opened: ${name}`);
      // P3-proven pacing: the single cookie slot makes back-to-back acquires a
      // timing lottery; 400ms makes the deterministic path (this is the
      // product's normal human usage pattern, not a workaround).
      await admin.page.waitForTimeout(400);
    }
    const live = await waitAllLive(admin.page, 5, 120_000);
    const s5 = await waitSlot(admin.page, 5, 30_000);
    await sleep(3_000); // let frames accrue for the DOM counter
    const rows = await tileRows(admin.page, 5);
    const u5 = await usageNow();
    const leasesOk = u5.active.length === 5
      && u5.active.every((l) => l.userId === adminId && l.mode === 'controller' && DEVICES.some((d) => dev[d] === l.deviceId))
      && new Set(u5.active.map((l) => l.deviceId)).size === 5;
    const framesOk = rows.every((r) => (r.frames ?? -1) > 0);
    const nv51 = s0 === 0 && live.every((s) => s.state.startsWith('LIVE')) && s5 && u5.usage?.active === 5 && leasesOk && framesOk;
    mark('NV5-1', nv51,
      `five-way establish: start=${s0}/5 → all LIVE=${live.every((s) => s.state.startsWith('LIVE'))}, slot=${s5 ? '5/5' : slotCount}, usage=${u5.usage?.active}/5, lease inventory owner/mode/device correct=${leasesOk} (5 distinct devices), frames flowing per tile=${rows.map((r) => r.frames).join(',')} (screencap)`);
    await admin.page.screenshot({ path: `${EVID}/nv5-1-five-live.png` }).catch(() => {});
    ev('nv5-1-establish.json', {
      run: RUN, startSlot: s0, endSlot: s5 ? 5 : null,
      usage: u5.usage, activeLeases: u5.active.map((l) => ({ leaseId: l.id, deviceId: l.deviceId, deviceName: DEVICES.find((d) => dev[d] === l.deviceId), userId: l.userId, mode: l.mode, status: l.status })),
      tiles: rows,
    });
  }

  // ================= NV5-2: permissions at full capacity =======================
  {
    const { active } = await usageNow();
    const probes = [];
    for (const l of active) {
      const hb = await op.ctx.request.post(`${API}/api/device-streams/${l.id}/heartbeat`);
      probes.push({ leaseId: l.id.slice(0, 8), hb: hb.status(), code: (await hb.json().catch(() => ({}))).error?.code ?? null });
    }
    const closeProbe = await op.ctx.request.delete(`${API}/api/device-streams/${active[0].id}`);
    const closeJ = await closeProbe.json().catch(() => ({}));
    const recProbe = await op.ctx.request.post(`${API}/api/device-streams/${active[1].id}/reconnect`);
    const recJ = await recProbe.json().catch(() => ({}));
    const adminHb = await admin.ctx.request.post(`${API}/api/device-streams/${active[2].id}/heartbeat`);
    const uAfter = await usageNow();
    const rowsAfter = await tileRows(admin.page, 5);
    const all403 = probes.every((p) => p.hb === 403 && p.code === 'STREAM_LEASE_OWNER_MISMATCH')
      && closeProbe.status() === 403 && closeJ.error?.code === 'STREAM_LEASE_OWNER_MISMATCH'
      && recProbe.status() === 403 && recJ.error?.code === 'STREAM_LEASE_OWNER_MISMATCH';
    const noSideEffect = uAfter.usage?.active === 5 && rowsAfter.every((r) => r.state.startsWith('LIVE'));
    mark('NV5-2', all403 && adminHb.status() === 200 && noSideEffect,
      `permissions @5/5 (operator ${opId.slice(0, 8)}… vs 5 admin leases): heartbeat×5 all 403 ${probes[0]?.code}=${probes.every((p) => p.code === 'STREAM_LEASE_OWNER_MISMATCH')}, foreign close=403 ${closeJ.error?.code ?? '?'}, foreign reconnect=403 ${recJ.error?.code ?? '?'}; admin heartbeat control=200; usage 5/5 + tiles still LIVE (no side effect)=${noSideEffect}`);
    ev('nv5-2-permissions.json', { run: RUN, operator: opId, admin: adminId, probes, closeProbe: { status: closeProbe.status(), code: closeJ.error?.code ?? null }, reconnectProbe: { status: recProbe.status(), code: recJ.error?.code ?? null }, adminHeartbeat: adminHb.status(), usageAfter: uAfter.usage });
  }

  // ================= NV5-3: force-kill ONE path → auto /reconnect ==============
  {
    const victimLease = (await usageNow()).active.find((l) => l.deviceId === dev[VICTIM]);
    if (!victimLease) throw new Error(`no active lease for victim ${VICTIM}`);
    const F0 = await tileRows(admin.page, 5);
    const others = F0.filter((r) => r.name !== VICTIM);
    const seenBefore = httpSeen.length;
    const killRes = await admin.page.evaluate((lid) => {
      const e = window.__wsRegistry.find((x) => x.url.includes(lid) && x.ref.readyState === 1);
      if (!e) return 'no-open-ws';
      e.ref.close(); // abrupt path drop (network-drop semantics for the app)
      return 'killed';
    }, victimLease.id);
    const tKill = now();
    say(`NV5-3: killed ${VICTIM} ws (${killRes}) at t0 — sampling 60s`);

    const samples = [];
    let victimSawReconnecting = false;
    let victimBackLiveAt = null;
    let othersLeftLive = false;
    const t0 = now();
    while (now() - t0 < 60_000) {
      const rows = await tileRows(admin.page, 5);
      const uAct = (await usageNow()).usage?.active ?? -1;
      const recNow = httpSeen.slice(seenBefore).filter((h) => h.kind === 'reconnect' && h.url.includes(victimLease.id)).length;
      samples.push({ tMs: now() - t0, states: rows.map((r) => `${r.name?.slice(-4)}:${r.state}`), frames: rows.map((r) => r.frames), usage: uAct, victimReconnects: recNow });
      const v = tileByName(rows, VICTIM);
      if (v?.state === 'RECONNECTING' || v?.state === 'CONNECTING') victimSawReconnecting = true;
      if (!victimBackLiveAt && v?.state.startsWith('LIVE') && now() - tKill > 3_000) victimBackLiveAt = now() - tKill;
      if (others.some((o) => { const r = tileByName(rows, o.name); return !r || !r.state.startsWith('LIVE'); })) othersLeftLive = true;
      if (victimBackLiveAt && samples.length > 2) {
        // let the other tiles' frames accrue past the recovery point
        await sleep(1_500);
        break;
      }
      await sleep(500);
    }
    const F1 = await tileRows(admin.page, 5);
    const victimF1 = tileByName(F1, VICTIM);
    const uEnd = await usageNow();
    const recs = httpSeen.slice(seenBefore).filter((h) => h.kind === 'reconnect' && h.url.includes(victimLease.id));
    const othersRecoveredFrames = others.every((o) => {
      const f0 = o.frames ?? -1;
      const f1 = (tileByName(F1, o.name)?.frames ?? -1);
      return f1 > f0; // strictly increasing across the whole storm window
    });
    const victimReconnectAuto = recs.length >= 1 && recs[0].status === 200;
    const nv53 = killRes === 'killed' && victimSawReconnecting && Boolean(victimBackLiveAt)
      && !othersLeftLive && othersRecoveredFrames && (uEnd.usage?.active === 5)
      && victimReconnectAuto && (victimF1?.frames ?? 0) > (tileByName(F0, VICTIM)?.frames ?? -1);
    mark('NV5-3', nv53,
      `reconnect storm #1 (force-kill ${VICTIM}): ws killed=${killRes}, victim RECONNECTING seen=${victimSawReconnecting} → LIVE again at t+${victimBackLiveAt ? Math.round(victimBackLiveAt / 1000) : '?'}s, auto /reconnect POSTs=${recs.length} (first=${recs[0]?.status ?? '?'}) — no user action; OTHER 4 stayed LIVE the whole window=${!othersLeftLive} with frames strictly increasing=${othersRecoveredFrames} (F0→F1: ${others.map((o) => `${o.name?.slice(-4)}:${o.frames}→${tileByName(F1, o.name)?.frames}`).join(' ')}); usage stayed 5/5=${uEnd.usage?.active === 5} (reconnect ≠ release); victim frames resumed ${tileByName(F0, VICTIM)?.frames}→${victimF1?.frames}`);
    await admin.page.screenshot({ path: `${EVID}/nv5-3-recovered.png` }).catch(() => {});
    ev('nv5-3-storm1.json', {
      run: RUN, victim: VICTIM, victimLeaseId: victimLease.id, killMechanism: 'client WS close (abnormal path drop)',
      killResult: killRes, victimBackLiveMs: victimBackLiveAt, reconnects: recs,
      othersBefore: others.map((o) => ({ name: o.name, frames: o.frames })),
      othersAfter: F1.filter((r) => r.name !== VICTIM).map((r) => ({ name: r.name, state: r.state, frames: r.frames })),
      usageEnd: uEnd.usage, samples,
    });
  }

  // ================= NV5-4: (OBSERVATION) sidecar SIGKILL — 5-way simultaneous ====
  {
    await waitAllLive(admin.page, 5, 90_000); // precondition: 5 LIVE
    const sc0 = await fetch(SIDECAR_HEALTH).then((r) => r.json());
    const cgroupOk = await (async () => {
      try {
        const cg = fs.readFileSync(`/proc/${sc0.pid}/cgroup`, 'utf8');
        return !/docker-/.test(cg);
      } catch { return false; }
    })();
    if (!cgroupOk) throw new Error(`REFUSING to kill sidecar pid ${sc0.pid} (cgroup check failed / docker scope?)`);
    process.kill(sc0.pid, 'SIGKILL');
    say(`NV5-4: sidecar pid ${sc0.pid} SIGKILL'd (cgroup-verified non-docker) at t0 — sampling 150s`);
    const tKill = now();
    const seenBefore = httpSeen.length;
    const samples = [];
    const rowsAtKill = await tileRows(admin.page, 5);
    const perTile = Object.fromEntries(DEVICES.map((d) => [d, { firstLiveMs: null, framesAtKill: rowsAtKill.find((r) => r.name === d)?.frames ?? -1 }]));
    const scRestart = { pid: null, upMs: null };
    const t0 = now();
    while (now() - t0 < 150_000) {
      const rows = await tileRows(admin.page, 5);
      samples.push({ tMs: now() - t0, states: rows.map((r) => `${r.name?.slice(-4)}:${r.state}`) });
      for (const d of DEVICES) {
        const r = tileByName(rows, d);
        if (perTile[d].firstLiveMs === null && r?.state.startsWith('LIVE') && now() - tKill > 2_000) perTile[d].firstLiveMs = now() - tKill;
      }
      if (scRestart.upMs === null) {
        try {
          const h = await fetch(SIDECAR_HEALTH, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
          if (h.ok && h.pid !== sc0.pid) { scRestart.pid = h.pid; scRestart.upMs = now() - tKill; }
        } catch { /* sidecar still down */ }
      }
      const allSettled = rows.every((r) => r.state.startsWith('LIVE') || r.state === 'ERROR' || r.state === 'CLOSED');
      if (allSettled && now() - t0 > 15_000 && samples.length > 30) break;
      await sleep(500);
    }
    const stormReconnects = httpSeen.slice(seenBefore).filter((h) => h.kind === 'reconnect');
    const rec429s = stormReconnects.filter((h) => h.status === 429);
    const recOk = stormReconnects.filter((h) => h.status === 200);
    const autoRecovered = DEVICES.filter((d) => perTile[d].firstLiveMs !== null);
    const stuck = DEVICES.filter((d) => perTile[d].firstLiveMs === null);
    say(`NV5-4: auto-recovered ${autoRecovered.length}/5; stuck ${stuck.length}: ${stuck.join(',') || 'none'}; sidecar back in ${scRestart.upMs ? Math.round(scRestart.upMs / 1000) : '?'}s (pid ${scRestart.pid}); reconnects=${stormReconnects.length} (200×${recOk.length}, 429×${rec429s.length})`);

    // manual recovery for any stuck tiles (the product's real recovery path:
    // close the dead tile + re-open the chip). Recorded as an OBSERVATION, not
    // a product change. Waits out the shared 10/min rate-limit window via the
    // 429 Retry-After when present.
    let manualRecoveries = [];
    if (stuck.length > 0) {
      const last429 = rec429s[rec429s.length - 1];
      if (last429?.retryAfter) {
        const waitMs = Math.max(0, Number(last429.retryAfter) * 1000 + 1_500 - (now() - (last429.atMs ?? now())));
        say(`NV5-4: rate-limit window — waiting ${Math.round(waitMs / 1000)}s for the 10/min budget to reset`);
        await sleep(waitMs);
      }
      for (const d of stuck) {
        const t0m = now();
        const rows = await tileRows(admin.page, 5);
        const t = tileByName(rows, d);
        if (t) {
          const idx = rows.findIndex((r) => r.name === d);
          await admin.page.locator('.fleet-tile').nth(idx).locator('button.fleet-close').click({ timeout: 10_000 }).catch(() => {});
        }
        await sleep(2_000);
        await openChip(admin.page, d).catch(() => {});
        const ok = await (async () => {
          const t1 = now();
          while (now() - t1 < 90_000) {
            const r2 = tileByName(await tileRows(admin.page, 5), d);
            if (r2?.state.startsWith('LIVE')) return true;
            await sleep(1_000);
          }
          return false;
        })();
        manualRecoveries.push({ device: d, ok, ms: now() - t0m });
        say(`NV5-4: manual recovery ${d}: ${ok ? 'LIVE' : 'FAILED'} in ${Math.round((now() - t0m) / 1000)}s`);
      }
    }
    const finalRows = await tileRows(admin.page, 5);
    const uEnd = await usageNow();
    const allFiveLive = finalRows.length === 5 && finalRows.every((r) => r.state.startsWith('LIVE'));
    const nv54 = allFiveLive && uEnd.usage?.active === 5 && Boolean(scRestart.upMs);
    mark('NV5-4', nv54,
      `reconnect storm #2 (sidecar SIGKILL — real force-kill, 5 paths concurrent): sidecar back in ${scRestart.upMs ? Math.round(scRestart.upMs / 1000) : '?'}s (pid ${sc0.pid}→${scRestart.pid}); AUTO-recovered ${autoRecovered.length}/5 (per-tile ms: ${DEVICES.map((d) => `${d.slice(-4)}=${perTile[d].firstLiveMs ? Math.round(perTile[d].firstLiveMs / 1000) : '∞'}`).join(' ')}); /reconnect POSTs=${stormReconnects.length} (200×${recOk.length}, 429×${rec429s.length} — shared P5 10/min budget); manual recovery needed for ${stuck.length}: ${stuck.join(',') || 'none'}${manualRecoveries.length ? ` (recovered ${manualRecoveries.filter((m) => m.ok).length}/${manualRecoveries.length})` : ''}; final: 5/5 LIVE=${allFiveLive}, usage=${uEnd.usage?.active}/5. OBSERVATION — cookie-slot livelock risk measured on the screencap path`);
    await admin.page.screenshot({ path: `${EVID}/nv5-4-storm2.png` }).catch(() => {});
    ev('nv5-4-storm2.json', {
      run: RUN, killMechanism: 'sidecar SIGKILL (all 5 tunnels)', sidecarPidBefore: sc0.pid, ...scRestart,
      perTile: Object.fromEntries(Object.entries(perTile).map(([k, v]) => [k, { framesAtKill: v.framesAtKill, firstLiveMs: v.firstLiveMs }])),
      autoRecovered, stuck, manualRecoveries,
      reconnects: { total: stormReconnects.length, ok: recOk.length, rateLimited: rec429s.length, timeline: stormReconnects.map((h) => ({ tMs: h.atMs - tKill, url: h.url.slice(-18), status: h.status, retryAfter: h.retryAfter })) },
      finalTiles: finalRows, usageEnd: uEnd.usage, sampleCount: samples.length, samples: samples.filter((_, i) => i % 4 === 0),
    });
  }

  // ================= NV5-5: release — close all → 0/5 ============================
  {
    admin.page.once('dialog', (d) => d.accept());
    await admin.page.locator('button:has-text("全關閉")').click();
    const zero = await waitSlot(admin.page, 0, 60_000);
    const uEnd = await usageNow();
    const tilesLeft = await admin.page.evaluate(() => document.querySelectorAll('.fleet-tile').length);
    const nv55 = zero && (uEnd.usage?.active === 0) && uEnd.active.length === 0 && tilesLeft === 0;
    mark('NV5-5', nv55,
      `release: close-all (confirm) → usage ${uEnd.usage?.active}/5, ACTIVE leases=${uEnd.active.length} (want 0), tiles left=${tilesLeft} (want 0)`);
    await admin.page.screenshot({ path: `${EVID}/nv5-5-zero.png` }).catch(() => {});
    ev('nv5-5-release.json', { run: RUN, usage: uEnd.usage, activeLeases: uEnd.active.length, tilesLeft });
  }

  ev('nv5-summary.json', {
    startedAt,
    finishedAt: new Date().toISOString(),
    run: RUN,
    conclusion: {
      videoSource: 'screencap (pinned redroid image — the product default)',
      cookieSlotScope: 'video-source INDEPENDENT (auth layer precedes sidecar; see script header)',
      httpSeenCount: httpSeen.length,
    },
    results,
  });
  await admin.ctx.close().catch(() => {});
  await op.ctx.close().catch(() => {});
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  say(`done: ${results.length - fails}/${results.length} PASS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
