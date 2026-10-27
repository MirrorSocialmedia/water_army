// P4 web probe runner — headless chromium loads tools/exposure-probe page,
// triggers collection, dumps JSON. Three contexts: default / UA-spoof Pixel
// (Android UA on x86_64 host combo) = red-flag matrix input.
const { chromium } = require('/usr/lib/node_modules/openclaw/node_modules/playwright-core');
const fs = require('fs');
const EXE = process.env.CHROME_EXE || '/home/kenneth/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] });
  const out = {};
  for (const [label, ua] of [['host-chromium', null], ['android-ua', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36']]) {
    const ctx = await browser.newContext(ua ? { userAgent: ua } : {});
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:16498/index.html');
    await page.click('#run');
    await page.waitForFunction(() => document.getElementById('out').value.length > 100, null, { timeout: 60000 });
    out[label] = JSON.parse(await page.inputValue('#out'));
    await ctx.close();
  }
  fs.writeFileSync(process.argv[2] || '/tmp/wa-exposure-host.json', JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
