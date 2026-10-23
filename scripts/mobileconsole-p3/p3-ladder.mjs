/**
 * P3 load ladder (MD §14 Phase 3 + §15.4) — 1→2→3→5 simultaneous real-device
 * streams through the Fleet Console UI.
 *
 * Per level (default hold 10 min, MC_HOLD_MS to override):
 *  - open L tiles (LIVE required before the hold starts)
 *  - every 10s: per-tile state / frames / FPS / last-frame age / input
 *    counters → CSV (stall = no frame progress for 60s on a LIVE tile)
 *  - every 60s: input round on every LIVE tile (canvas tap + HOME key) —
 *    input success rate = sent/(sent+rejected) from the client counters
 *  - per-socket WS observer → per-stream bandwidth (bytes over the hold)
 *  - L5 only (MC_ISOLATION=1): at +7min stop the 5th device via API,
 *    verify the other four keep streaming for 3 min, then start it again
 *  - close all tiles, verify slots back to 0
 *
 * Output (MC_EVID): p3-ladder-summary.json + p3-ladder-L{N}.csv per level.
 * The HOST/CONTAINER resource sampler is a SEPARATE detached exec
 * (mc-ladder-sample.sh) — this script is the browser side only.
 *
 * Run detached: nohup setsid node p3-ladder.mjs > log 2>&1 & (pidfile).
 * ZERO LLM work while it runs (CTO-idle discipline).
 */
import fs from 'node:fs';
import { chromium } from '/usr/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';

const WEB = process.env.MC_WEB ?? 'http://127.0.0.1:16492';
const API = process.env.MC_API ?? 'http://127.0.0.1:16490';
const ADMIN_USER = process.env.MC_ADMIN_USER;
const ADMIN_PASS = process.env.MC_ADMIN_PASS;
const EVID = process.env.MC_EVID ?? '/home/kenneth/.openclaw/workspace/logs/mobileconsole-p3';
const LEVELS = (process.env.MC_LEVELS ?? '1 2 3 5').trim().split(/\s+/).map(Number);
const HOLD_MS = Number(process.env.MC_HOLD_MS ?? 600_000);
const SAMPLE_MS = 10_000;
const INPUT_MS = 60_000;
const STALL_MS = 60_000;
const DEVICE_NAMES = ['redroid-brmc-poc', 'redroid-brmc-s2', 'redroid-brmc-s3', 'redroid-brmc-s4', 'redroid-brmc-s5'];

fs.mkdirSync(EVID, { recursive: true });
const summary = { startedAt: new Date().toISOString(), levels: [] };
const say = (m) => console.log(`[ladder ${new Date().toISOString()}] ${m}`);

async function login(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', ADMIN_USER);
  await page.fill('input[type="password"]', ADMIN_PASS);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.login-card', { state: 'detached', timeout: 20_000 });
  return { ctx, page };
}

/** Per-tile DOM read. The RAW state code lives in the tile root class
 *  (`stream-live_controlled_by_you` etc.) — the badge shows the localized
 *  STATE_TEXT (「已連線…」), which is useless for code-level checks. */
async function readTile(page, i) {
  return page.evaluate((idx) => {
    const tile = document.querySelectorAll('.fleet-tile')[idx];
    if (!tile) return null;
    const name = tile.querySelector('h3')?.textContent ?? `tile${idx}`;
    const state = ((tile.className.match(/stream-([a-z_]+)/) ?? [])[1] ?? '?').toUpperCase();
    const stateText = tile.querySelector('.state-badge')?.textContent ?? '?';
    const kvs = {};
    tile.querySelectorAll('.fleet-kv dt').forEach((dt) => {
      kvs[dt.textContent] = dt.nextElementSibling?.textContent ?? '';
    });
    const m = /(\d+)/.exec(kvs['幀'] ?? '');
    const age = kvs['幀']?.includes('<1s') ? 0 : kvs['幀']?.match(/(\d+)s ago/) ? Number(kvs['幀'].match(/(\d+)s ago/)[1]) * 1000 : null;
    const inps = (kvs['輸入'] ?? '').match(/(\d+) sent \/ (\d+) rejected/);
    return {
      name,
      state,
      stateText,
      frames: m ? Number(m[1]) : 0,
      lastFrameAgeMs: age,
      inputSent: inps ? Number(inps[1]) : 0,
      inputRejected: inps ? Number(inps[2]) : 0,
    };
  }, i);
}

function openWsObserver(page, obs) {
  page.on('websocket', (ws) => {
    const entry = { url: ws.url(), bytes: 0, frames: 0 };
    obs.sockets.push(entry);
    ws.on('framereceived', (ev) => {
      const p = ev.payload;
      if (Buffer.isBuffer(p)) { entry.frames += 1; entry.bytes += p.length; }
    });
  });
}

async function openTiles(page, ctx, names, log) {
  // fetch device ids for the target names (chips are keyed by name in the UI)
  const res = await ctx.request.get(`${API}/api/devices/redroid`);
  const body = await res.json();
  const byName = Object.fromEntries((body.devices ?? []).map((d) => [d.name, d.id]));
  for (const name of names) {
    // hash-only goto does NOT reload the document — the fleet page mounts
    // after goto, and the chips render only once the devices fetch lands
    // (run #dry 2026-10-23: count() at 0ms saw nothing). Wait for the chip.
    const chip = page.locator(`.chip`, { hasText: name }).first();
    await chip.waitFor({ state: 'visible', timeout: 15_000 });
    await chip.click({ timeout: 10_000 });
    log(`tile opened: ${name}`);
  }
  // wait for every tile to reach a LIVE state (90s budget)
  const t0 = Date.now();
  for (;;) {
    const tiles = [];
    for (let i = 0; i < names.length; i += 1) tiles.push(await readTile(page, i));
    const alive = tiles.every((t) => t && t.state.startsWith('LIVE'));
    if (alive) return tiles;
    if (Date.now() - t0 > 90_000) throw new Error(`tiles not LIVE within 90s: ${JSON.stringify(tiles)}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function inputRound(page, tiles, log) {
  let sent = 0;
  for (let i = 0; i < tiles.length; i += 1) {
    const t = tiles[i];
    if (!t || !t.state.startsWith('LIVE')) continue;
    const before = await readTile(page, i);
    // tap the canvas centre (real input path: browser → WS → sidecar → adb)
    const canvas = page.locator('.fleet-tile canvas').nth(i);
    await canvas.scrollIntoViewIfNeeded().catch(() => {});
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    // HOME key (controller tiles render the tiny keybar)
    const home = page.locator('.fleet-tile .keybtn', { hasText: 'Home' }).nth(i);
    if (await home.count() > 0) await home.click().catch(() => {});
    await page.waitForTimeout(1_500);
    const after = await readTile(page, i);
    sent += Math.max(0, (after?.inputSent ?? 0) - (before?.inputSent ?? 0));
  }
  log(`input round: ${sent} inputs dispatched`);
  return sent;
}

/**
 * Attribute observed WS sockets to devices via the lease table (the socket
 * URL carries the leaseId; a reconnected lease adds a second socket — sum
 * both). Returns { deviceId: bytes }.
 */
async function attributeSockets(ctx, obs) {
  const res = await ctx.request.get(`${API}/api/device-streams`);
  const body = await res.json();
  const leaseToDev = {};
  for (const l of body.leases ?? []) leaseToDev[l.leaseId ?? l.id] = l.deviceId;
  const out = {};
  for (const s of obs.sockets) {
    const m = /\/api\/device-streams\/([^/]+)\/ws/.exec(s.url);
    if (!m) continue;
    const dev = leaseToDev[m[1]];
    if (!dev) continue;
    out[dev] = (out[dev] ?? 0) + s.bytes;
  }
  return out;
}

async function runLevel(browser, L, idx) {
  const names = DEVICE_NAMES.slice(0, L);
  const csvPath = `${EVID}/p3-ladder-L${L}.csv`;
  const csv = fs.createWriteStream(csvPath, { flags: 'w' });
  csv.write('ts,level,device,state,frames,last_frame_age_ms,input_sent,input_rejected\n');
  const { ctx, page } = await login(browser);
  const level = { level: L, startedAt: new Date().toISOString(), tiles: {}, events: [] };
  const lastState = names.map(() => null);
  // name → deviceId (for socket→device byte attribution at level end)
  const listRes = await ctx.request.get(`${API}/api/devices/redroid`);
  const listBody = await listRes.json();
  const idByName = Object.fromEntries((listBody.devices ?? []).map((d) => [d.name, d.id]));
  try {
    await page.goto(`${WEB}/#/devices/fleet`, { waitUntil: 'networkidle' });
    const obs = { sockets: [] };
    openWsObserver(page, obs);
    const t0 = Date.now();
    await openTiles(page, ctx, names, (m) => { say(`L${L}: ${m}`); level.events.push(`${new Date().toISOString()} ${m}`); });
    const lastFrame = names.map(() => Date.now());
    const lastFrames = names.map(() => 0);
    let nextInput = Date.now() + INPUT_MS;
    let isolationDone = false;

    while (Date.now() - t0 < HOLD_MS) {
      const now = Date.now();
      for (let i = 0; i < L; i += 1) {
        const t = await readTile(page, i);
        if (!t) continue;
        if (t.state.startsWith('LIVE') && t.frames > 0) {
          lastState[i] = t.state;
          if (t.frames === lastFrames[i]) {
            if (now - lastFrame[i] > STALL_MS) {
              level.events.push(`${new Date().toISOString()} STALL ${t.name}: no frame progress ${Math.round((now - lastFrame[i]) / 1000)}s`);
              lastFrame[i] = now;
            }
          } else { lastFrame[i] = now; lastFrames[i] = t.frames; }
        } else {
          // dedupe: log a NOT-LIVE transition once, not every 10s sample
          if (lastState[i] !== t.state) {
            level.events.push(`${new Date().toISOString()} NOT-LIVE ${t.name}: ${t.state}`);
          }
          lastState[i] = t.state;
          lastFrame[i] = now;
        }
        csv.write(`${new Date().toISOString()},${L},${t.name},${t.state},${t.frames},${t.lastFrameAgeMs ?? ''},${t.inputSent},${t.inputRejected}\n`);
      }
      if (now >= nextInput) {
        // evidence for 「實際畫面是否更新」(MD §15.4): periodic full-grid shot
        try { await page.screenshot({ path: `${EVID}/p3-L${L}-t${Math.round((now - t0) / 1000)}s.png` }); } catch { /* non-fatal */ }
        await inputRound(page, await Promise.all(Array.from({ length: L }, (_, i) => readTile(page, i))), (m) => level.events.push(`${new Date().toISOString()} ${m}`));
        nextInput = now + INPUT_MS;
      }
      // isolation check (L5 only): stop the 5th device at +7min, watch the
      // other four for 3 min, then start it back (MD §15.4 單一設備停機).
      if (L === 5 && process.env.MC_ISOLATION === '1' && !isolationDone && now - t0 > 7 * 60_000) {
        isolationDone = true;
        const res = await ctx.request.get(`${API}/api/devices/redroid`);
        const body = await res.json();
        const dev = (body.devices ?? []).find((d) => d.name === names[4]);
        if (dev) {
          level.events.push(`${new Date().toISOString()} ISOLATION: stopping ${names[4]} (${dev.id})`);
          await ctx.request.post(`${API}/api/devices/redroid/${dev.id}/stop`).catch((e) => level.events.push(`${new Date().toISOString()} isolation stop error: ${e.message}`));
          const isoUntil = Date.now() + 3 * 60_000;
          const otherFramesBefore = [0, 1, 2, 3].map(async (i) => (await readTile(page, i))?.frames ?? 0);
          const before = await Promise.all(otherFramesBefore);
          while (Date.now() < isoUntil) {
            await new Promise((r) => setTimeout(r, 15_000));
            for (let i = 0; i < 4; i += 1) {
              const t = await readTile(page, i);
              const stillAdvancing = t?.state.startsWith('LIVE') && t.frames > before[i];
              if (!stillAdvancing) level.events.push(`${new Date().toISOString()} ISOLATION-BREACH tile${i} (${t?.name}) ${t?.state} frames=${t?.frames}`);
            }
          }
          level.events.push(`${new Date().toISOString()} ISOLATION: restarting ${names[4]}`);
          await ctx.request.post(`${API}/api/devices/redroid/${dev.id}/start`).catch((e) => level.events.push(`${new Date().toISOString()} isolation start error: ${e.message}`));
          const beforeRestart = Date.now();
          let restarted = false;
          while (Date.now() - beforeRestart < 25 * 60_000) {
            const r = await ctx.request.get(`${API}/api/devices/redroid/${dev.id}`);
            const d = (await r.json()).device;
            if (d?.containerState === 'running' && d?.adbState === 'online') { restarted = true; break; }
            await new Promise((rr) => setTimeout(rr, 30_000));
          }
          level.events.push(`${new Date().toISOString()} ISOLATION: ${names[4]} ${restarted ? 'running+adb-online' : 'NOT back after 25min'}`);
        }
      }
      await new Promise((r) => setTimeout(r, Math.max(1_000, SAMPLE_MS - (Date.now() - now))));
    }

    // FINAL per-tile read BEFORE closing (closing removes the tiles from
    // the DOM — reading after would wipe the counters)
    const finalReads = await Promise.all(Array.from({ length: L }, (_, i) => readTile(page, i)));
    // tear down the level: close every tile, verify slots back to 0
    for (let i = 0; i < L; i += 1) {
      const tile = page.locator('.fleet-tile').nth(i);
      const closeBtn = tile.locator('button.fleet-close');
      if (await closeBtn.count() > 0) await closeBtn.click().catch(() => {});
    }
    await page.waitForTimeout(4_000);
    const usageRes = await ctx.request.get(`${API}/api/device-streams`);
    const usage = (await usageRes.json()).usage;
    level.usageAfterClose = usage;

    const byteByDev = await attributeSockets(ctx, obs);
    for (let i = 0; i < L; i += 1) {
      const t = finalReads[i];
      level.tiles[names[i]] = {
        finalState: t?.state ?? 'gone',
        frames: t?.frames ?? 0,
        inputSent: t?.inputSent ?? 0,
        inputRejected: t?.inputRejected ?? 0,
        bytes: byteByDev[idByName[names[i]]] ?? 0,
      };
    }
    level.totalBytes = Object.values(byteByDev).reduce((a, b) => a + b, 0);
    level.durationMs = Date.now() - t0;
    level.finishedAt = new Date().toISOString();
  } catch (e) {
    level.error = String(e?.message ?? e);
    say(`L${L} ERROR: ${level.error}`);
  } finally {
    csv.end();
    await ctx.close().catch(() => {});
  }
  summary.levels.push(level);
  fs.writeFileSync(`${EVID}/p3-ladder-summary.json`, JSON.stringify(summary, null, 2));
  say(`L${L} done: ${level.durationMs ? Math.round(level.durationMs / 1000) + 's' : 'n/a'} tiles=${Object.values(level.tiles).map((t) => `${t.frames}f/${t.inputSent}in`).join(',')} stalls=${level.events.filter((e) => e.includes('STALL')).length}${level.error ? ' ERROR=' + level.error : ''}`);
}

(async () => {
  say(`start levels=[${LEVELS}] hold=${HOLD_MS / 1000}s web=${WEB}`);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const L of LEVELS) {
    await runLevel(browser, L, LEVELS.indexOf(L));
  }
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(`${EVID}/p3-ladder-summary.json`, JSON.stringify(summary, null, 2));
  await browser.close();
  say('ladder complete');
  process.exit(0);
})().catch((e) => {
  say(`FATAL: ${e?.stack ?? e}`);
  process.exit(1);
});
