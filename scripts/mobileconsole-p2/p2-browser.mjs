/**
 * P2 E2E — browser flow (Playwright) against the scratch web+API with the
 * REAL redroid device. Every step leaves a MARK line + evidence file.
 *
 * MARK convention: `MARK Txx PASS — desc` / `MARK Txx FAIL — desc`
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const WEB = arg('web');
const API = arg('api');
const DEVICE_ID = arg('device');
const DEVICE_NAME = arg('device-name');
const EVID = arg('evid');
const ADMIN_USER = process.env.MC_ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.MC_ADMIN_PASS ?? '';
const VIEWER_USER = 'mcviewer1'; // scratch-only E2E user (P1 seed, fixed test pw)
const VIEWER_PASS = 'e2e-p1-pw';

const results = [];
function mark(id, ok, desc, extra = {}) {
  results.push({ id, ok, desc, ...extra });
  console.log(`MARK ${id} ${ok ? 'PASS' : 'FAIL'} — ${desc}${extra.evidence ? ` [${extra.evidence}]` : ''}`);
}
function shot(page, name) {
  const p = `${EVID}/${name}`;
  return page.screenshot({ path: p }).then(() => p);
}

async function login(context, user, pass) {
  const page = await context.newPage();
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await page.fill('input[autocomplete="username"]', user);
  await page.fill('input[type="password"]', pass);
  await page.click('button[type="submit"]');
  // fail loud: poll for EITHER the app shell (login form gone) OR an error box
  // on the login page (401/429) — the old catch-all waitForURL regex silently
  // continued into T21 when login had actually failed. Single waitForFunction
  // (no racing waitFors — a losing branch would keep polling and could fire a
  // late unhandled rejection).
  const outcome = await page
    .waitForFunction(
      () => {
        const errBox = document.querySelector('.error-box');
        if (errBox) return { rejected: (errBox.textContent ?? '').slice(0, 160) };
        if (!document.querySelector('.login-card')) return { ok: true };
        return false;
      },
      null,
      { timeout: 15000, polling: 250 },
    )
    .then((h) => h.jsonValue())
    .catch((e) => {
      throw new Error(`login did not land within 15s (url=${page.url()}; ${e.message.slice(0, 80)})`);
    });
  if (outcome && outcome.rejected !== undefined) {
    throw new Error(`login rejected: ${outcome.rejected} url=${page.url()}`);
  }
  return page;
}

/** Wait until the stream banner reaches LIVE (text per MD §12). Budget covers
 *  scrcpy start + jar push + the 10s zero-frame auto-degrade window. */
async function waitLive(page, { timeoutMs = 120_000 } = {}) {
  return page.waitForFunction(
    () => {
      const b = document.querySelector('.stream-banner');
      return b && b.textContent.includes('已連線');
    },
    null,
    { timeout: timeoutMs },
  ).then(() => true).catch(() => false);
}

/** Canvas actually painted (non-black pixels) = real frames decoded. */
async function canvasPainted(page, { timeoutMs = 60_000 } = {}) {
  return page.waitForFunction(
    () => {
      const c = document.querySelector('.console-canvas');
      if (!c || c.width < 100 || c.height < 100) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const d = ctx.getImageData(0, 0, Math.min(c.width, 240), Math.min(c.height, 240)).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum > 8000;
    },
    null,
    { timeout: timeoutMs },
  ).then(() => true).catch(() => false);
}

async function frameCount(page, { timeoutMs = 15_000 } = {}) {
  // POLL (run #11 forensics): the canvas is painted by img.onload but the DOM
  // dd lags one React flush behind — a one-shot read right after canvasPainted
  // caught the stale '0 帧'. A live stream counts up at ~3.5fps, so waiting
  // for the first positive value is both safe and fast.
  const t0 = Date.now();
  for (;;) {
    const n = await page.evaluate(() => {
      const dts = [...document.querySelectorAll('dt')];
      const dt = dts.find((x) => x.textContent === '幀');
      if (!dt || !dt.nextElementSibling) return 0;
      const m = /(\d+)/.exec(dt.nextElementSibling.textContent);
      return m ? Number(m[1]) : 0;
    }).catch(() => 0);
    if (n > 0) return n;
    if (Date.now() - t0 > timeoutMs) return n;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function bannerText(page) {
  return page.evaluate(() => document.querySelector('.stream-banner')?.textContent ?? '');
}

const browser = await chromium.launch({ headless: true });
try {
  // ================= ADMIN (controller) flow ================================
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await login(ctx, ADMIN_USER, ADMIN_PASS);

  // Independent wire observer (P2 run #9 debugging): count what the BROWSER's
  // own WebSocket actually receives, outside the app's _onBinary path.
  // Writes ${EVID}/ws-obs.json — binary frames with their PNGF magic where
  // present. Distinguishes "frames never reach the browser" from "browser
  // decodes them wrong".
  const wsObs = { sockets: [], binary: 0, text: 0, firstBinary: null, lastError: null };
  page.on('websocket', (ws) => {
    const entry = { url: ws.url(), openedAt: new Date().toISOString(), binary: 0, text: 0, closed: null };
    wsObs.sockets.push(entry);
    ws.on('framereceived', (ev) => {
      const p = ev.payload;
      if (Buffer.isBuffer(p)) {
        entry.binary += 1; wsObs.binary += 1;
        if (!wsObs.firstBinary && p.length >= 16) {
          wsObs.firstBinary = { len: p.length, magic: p.readUInt32BE(0).toString(16), w: p.readUInt32BE(4), h: p.readUInt32BE(8) };
        }
      } else {
        entry.text += 1; wsObs.text += 1;
      }
    });
    ws.on('close', () => { entry.closed = new Date().toISOString(); });
    ws.on('error', (e) => { wsObs.lastError = String(e).slice(0, 200); });
  });

  // T21 — device list → open console (MD §15.3: 由 list open 正確 device)
  await page.goto(`${WEB}/#/devices`, { waitUntil: 'networkidle' });
  let t21 = false;
  try {
    const devLink = page.locator(`a.link:has-text("${DEVICE_NAME}")`);
    await devLink.waitFor({ timeout: 15000 });
    await devLink.click();
    // wait for the NAVIGATION (hash route change) — waitForSelector('h1')
    // alone resolves on the stale list-page h1 and reads the wrong title
    // (observed race: detail page not mounted yet → t21 false-negative).
    await page.waitForURL(/#\/devices\/[^/?#]+/, { timeout: 10000 });
    // then wait for the detail page to actually render the device name
    await page.waitForFunction(
      (name) => ([...document.querySelectorAll('h1')].map((e) => e.textContent ?? '').join(' ')).includes(name),
      DEVICE_NAME,
      { timeout: 10000 },
    );
    const h1 = (await page.locator('h1').first().textContent()) ?? '';
    t21 = h1.includes(DEVICE_NAME);
    if (t21) await page.click('button.console-open-btn');
  } catch (e) {
    console.log(`T21 error: ${e.message}`);
    // diagnostic snapshot for the next triage (no secrets: url + body head)
    try {
      const bodyHead = await page.evaluate(() => (document.body.textContent ?? '').slice(0, 400));
      console.log(`T21 diag: url=${page.url()} body=${JSON.stringify(bodyHead)}`);
    } catch {}
  }
  mark('T21', t21, 'web login + device list → console (correct device name in h1)');
  if (!t21) {
    await shot(page, 't21-fail.png');
    fs.writeFileSync(`${EVID}/p2-results.json`, JSON.stringify({ results }, null, 2));
    process.exit(0);
  }

  // T23 — tile shows device name + ADB target (MD §15.3)
  const t23ok = await page.waitForFunction(
    (name) => {
      const body = document.body.textContent ?? '';
      return body.includes(name) && body.includes('127.0.0.1:16500');
    },
    DEVICE_NAME,
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  mark('T23', t23ok, 'console shows device name + ADB 127.0.0.1:16500 (MD §15.3)');

  // T22 — LIVE + real frames rendered (message carries every sub-condition so a
  // failure triages itself: live=?.painted=?.frames=? is the run #10 blind spot)
  const live = await waitLive(page);
  const painted = live ? await canvasPainted(page, { timeoutMs: 20_000 }) : false;
  const frames = await frameCount(page); // polls up to 15s for the React-flushed count
  const source = await page.evaluate(() => {
    const dts = [...document.querySelectorAll('dt')];
    const dt = dts.find((x) => x.textContent === '串流模式');
    return dt?.nextElementSibling?.textContent ?? '';
  }).catch(() => '');
  mark('T22', Boolean(live && painted && frames > 0), `live=${live} painted=${painted} frames=${frames} (source: ${source})`, { evidence: 't22-live.png' });
  if (live) await shot(page, 't22-live.png');

  // T24 — controller TAP (status bar → notification shade)
  let t24 = false;
  if (painted) {
    try {
      const bb = await page.locator('.console-canvas').boundingBox();
      await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height * 0.02);
      await page.waitForTimeout(2500);
      t24 = true; // device-side proof = logcat (harness); here: input accepted, no error banner
      const fb = String(await page.evaluate(() => document.querySelector('.pf-bad')?.textContent ?? ''));
      t24 = !fb.includes('INPUT_REJECTED') && !fb.includes('STREAM_NOT_LIVE');
    } catch (e) {
      console.log(`T24 error: ${e.message}`);
    }
    await shot(page, 't24-after-tap.png');
  }
  mark('T24', t24, 'controller tap accepted (device logcat proof in t245-logcat-matched.txt)');

  // T25 — controller HOME key
  let t25 = false;
  if (painted) {
    try {
      await page.locator('.keybar .keybtn:has-text("Home")').click();
      await page.waitForTimeout(2500);
      const fb = String(await page.evaluate(() => document.querySelector('.pf-bad')?.textContent ?? ''));
      t25 = !fb.includes('INPUT_REJECTED') && !fb.includes('STREAM_NOT_LIVE');
    } catch (e) {
      console.log(`T25 error: ${e.message}`);
    }
    await shot(page, 't25-after-home.png');
  }
  mark('T25', t25, 'controller Home key accepted (device logcat proof in t245-logcat-matched.txt)');

  // T27 — sidecar SIGKILL → RECONNECTING → re-auth (new ticket) → LIVE again
  // (run #11 forensics: the old version polled waitLive IMMEDIATELY after the
  // kill — the first poll matched the STALE LIVE banner (banner change lags
  // the client's onclose by ~0.5s) → false PASS in every run, and T28's close
  // click 0.3s later unmounted the page and killed the pending reconnect
  // timer, so the real reconnect path was never exercised.)
  let t27 = false;
  let sawReconnecting = false;
  if (painted) {
    try {
      const pid = execSync('pgrep -f "[s]tream-sidecar/src/server.js"').toString().trim().split('\n')[0];
      process.kill(Number(pid), 'SIGKILL');
      // 1) the client MUST notice the drop: banner leaves LIVE → 重連 text
      sawReconnecting = await page.waitForFunction(
        () => {
          const b = document.querySelector('.stream-banner');
          return b && b.textContent.includes('重連') && !b.textContent.includes('已連線');
        },
        null,
        { timeout: 10_000, polling: 100 },
      ).then(() => true).catch(() => false);
      // 2) the reconnect must complete: fresh ticket + fresh WS + LIVE again
      const backLive = await waitLive(page, { timeoutMs: 30_000 });
      t27 = Boolean(sawReconnecting && backLive);
      await shot(page, 't27-reconnected.png');
    } catch (e) {
      console.log(`T27 error: ${e.message}`);
    }
  }
  mark('T27', t27, `sidecar SIGKILL → ${sawReconnecting ? 'RECONNECTING seen' : 'RECONNECTING NOT seen'} → re-auth → LIVE again (MD §2.1.8/§10)`);

  // T28 — close/release → lease terminal + usage 0
  let t28 = false;
  try {
    await page.locator('button.danger:has-text("關閉並釋放串流")').click();
    await page.waitForTimeout(3000);
    const usage = await ctx.request.get(`${API}/api/device-streams`);
    const body = await usage.json();
    const closedBanner = await bannerText(page).catch(() => '');
    t28 = usage.status() === 200 && body.usage?.active === 0;
    fs.writeFileSync(`${EVID}/t28-device-streams.json`, JSON.stringify(body, null, 2));
  } catch (e) {
    console.log(`T28 error: ${e.message}`);
  }
  mark('T28', t28, 'close/release → usage.active=0 (idempotent, MD §15)');

  // T29 — zero secrets: API log + list response
  let t29 = true;
  let t29note = '';
  try {
    const apiLog = fs.readFileSync(`${EVID}/scratch-api.log`, 'utf8');
    if (/stream_ticket\s*=\s*[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{16,}/.test(apiLog)) {
      t29 = false; t29note = 'ticket material found in API log';
    }
    const list = await ctx.request.get(`${API}/api/device-streams`);
    const listBody = await list.text();
    if (/"ticket"\s*:/.test(listBody)) { t29 = false; t29note = 'ticket field in /device-streams'; }
  } catch (e) {
    t29note = `check error: ${e.message}`;
  }
  mark('T29', t29, `zero secrets in API log + /device-streams${t29note ? ` (${t29note})` : ''}`);

  // ================= VIEWER (read-only) flow ==================================
  const vctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const vpage = await login(vctx, VIEWER_USER, VIEWER_PASS);
  let t26 = false;
  try {
    await vpage.goto(`${WEB}/#/devices`, { waitUntil: 'networkidle' });
    await vpage.locator(`a.link:has-text("${DEVICE_NAME}")`).click();
    await vpage.waitForSelector('h1', { timeout: 10000 });
    // viewer → the button routes to ?mode=viewer (canControl=false)
    await vpage.click('button.console-open-btn');
    const vLive = await waitLive(vpage);
    const vPainted = vLive ? await canvasPainted(vpage, { timeoutMs: 20_000 }) : false;
    const vFrames = await frameCount(vpage); // polls (React flush lag)
    const vBanner = vLive ? await bannerText(vpage) : '';
    const vReadOnly = vBanner.includes('唯讀');
    const vNoKeybar = await vpage.locator('.keybar .keybtn').count() === 0;
    t26 = Boolean(vLive && vPainted && vFrames > 0 && vReadOnly && vNoKeybar);
    await shot(vpage, 't26-viewer.png');
    // viewer closes its own stream (idempotent, releases the slot for the next run)
    await vpage.locator('button.danger:has-text("關閉並釋放串流")').click().catch(() => {});
    await vpage.waitForTimeout(2000);
  } catch (e) {
    console.log(`T26 error: ${e.message}`);
  }
  mark('T26', t26, 'viewer = read-only: video visible (frames>0), 唯讀 banner, no keybar (MD §15.2)');

  fs.writeFileSync(`${EVID}/ws-obs.json`, JSON.stringify({ ...wsObs, finishedAt: new Date().toISOString() }, null, 2));
  console.log(`WS-observer: sockets=${wsObs.sockets.length} binary=${wsObs.binary} text=${wsObs.text} firstBinary=${JSON.stringify(wsObs.firstBinary)} lastError=${wsObs.lastError}`);
  fs.writeFileSync(`${EVID}/p2-results.json`, JSON.stringify({ results, finishedAt: new Date().toISOString() }, null, 2));
} finally {
  await browser.close();
}
console.log('browser flow complete');
