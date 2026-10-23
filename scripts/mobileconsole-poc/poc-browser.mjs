#!/usr/bin/env node
/**
 * Mobile Console PoC — browser-side verification (MD §14 Phase 0)
 *
 * Drives headless Chromium (WebCodecs) against the PoC sidecar page:
 *   1. wait for H.264 decode (frames flowing on canvas)
 *   2. capture baseline, perform a swipe-down gesture (open notification shade)
 *   3. measure canvas pixel diff (touch → screen change = control works)
 *   4. press Home (keycode path), screenshots for the record
 *
 * Evidence: $EVID/browser-evidence.json + PNG screenshots.
 * Exit 0 = PASS; 1 = NOT VERIFIED / FAIL (details in JSON).
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pw = require('/usr/lib/node_modules/openclaw/node_modules/playwright-core');

const EVID = process.env.EVID ?? '/tmp/mobileconsole-poc-evid';
const BASE = process.env.POCON_BASE ?? 'http://127.0.0.1:16545/';
const CHROME = process.env.PW_CHROME ?? [
  `${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`,
].find((p) => existsSync(p));

mkdirSync(EVID, { recursive: true });
const out = { startedAt: new Date().toISOString(), chrome: CHROME, base: BASE, screenshots: [] };

function shot(name) {
  const p = path.join(EVID, name);
  out.screenshots.push(name);
  return p;
}

let rc = 1;
const browser = await pw.chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const consoleErrs = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrs.push(String(e).slice(0, 300)));
  out.consoleErrors = consoleErrs;

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  out.chromeVersion = await page.evaluate(() => navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? null);
  out.webcodecs = await page.evaluate(() => typeof VideoDecoder !== 'undefined');

  // 1) wait for decoded video
  await page.waitForFunction(
    () => window.__poc && window.__poc.configured === true && window.__poc.decoded >= 8,
    null,
    { timeout: 90_000 },
  ).catch((e) => { out.waitConfiguredError = String(e).slice(0, 200); });
  out.configured = await page.evaluate(() => window.__poc?.configured ?? false);
  out.frames = await page.evaluate(() => window.__poc?.frames ?? 0);
  out.decoded = await page.evaluate(() => window.__poc?.decoded ?? 0);
  out.codecUsed = await page.evaluate(() => window.__poc?.codecUsed ?? null);
  out.codecAttempts = await page.evaluate(() => window.__poc?.codecAttempts ?? []);
  out.device = await page.evaluate(() => window.__poc?.device ?? null);
  out.wsClose = await page.evaluate(() => window.__poc?.wsClose ?? null);
  out.wsError = await page.evaluate(() => window.__poc?.wsError ?? null);
  out.wsReadyState = await page.evaluate(() => window.__poc?.ws?.readyState ?? null);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: shot('01-home.png') });

  if (out.configured && out.decoded >= 8) {
    // 2) baseline + swipe down (notification shade) — deterministic visible change
    await page.evaluate(() => window.__poc.captureBaseline());
    const box = await (await page.$('#cv')).boundingBox();
    const cx = box.x + box.width / 2;
    await page.mouse.move(cx, box.y + 10);
    await page.mouse.down();
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(cx, box.y + 10 + (box.height * 0.55 - 10) * (i / steps));
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(2500);
    out.swipeDiffPct = await page.evaluate(() => window.__poc.diffPct());
    await page.screenshot({ path: shot('02-shade.png') });

    // 3) Home keycode
    await page.click('[data-kc="3"]');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot('03-home2.png') });

    out.stats = await page.evaluate(() => window.__poc?.stats ?? {});
    out.touchVerdict = out.swipeDiffPct >= 3 ? 'PASS' : `NOT VERIFIED (diff ${out.swipeDiffPct}%)`;
    out.videoVerdict = out.decoded >= 8 ? 'PASS' : 'FAIL';
    rc = out.configured && out.decoded >= 8 && out.swipeDiffPct >= 3 ? 0 : 1;
  } else {
    out.touchVerdict = 'NOT VERIFIED (no decoded video)';
    out.videoVerdict = out.decoded >= 8 ? 'PASS' : 'FAIL';
  }
} finally {
  await browser.close();
}

out.finishedAt = new Date().toISOString();
out.result = rc === 0 ? 'PASS' : 'FAIL/NOT VERIFIED';
writeFileSync(path.join(EVID, 'browser-evidence.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ result: out.result, video: out.videoVerdict, touch: out.touchVerdict, diff: out.swipeDiffPct, codec: out.codecUsed, decoded: out.decoded }));
process.exit(rc);
