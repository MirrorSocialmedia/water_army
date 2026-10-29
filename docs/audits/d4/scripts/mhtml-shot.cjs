// Render an MHTML (or URL) to PNG via host chromium (playwright-core).
const pwPath = '/usr/lib/node_modules/openclaw/node_modules/playwright-core';
const { chromium } = require(pwPath);
const src = process.argv[2];
const out = process.argv[3];
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || (require('os').homedir() + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'),
    args: ['--allow-file-access-from-files'],
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  const url = src.startsWith('http') ? src : 'file://' + require('path').resolve(src);
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out, fullPage: true });
  console.log('RENDERED', out);
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
