// D4: CDP page screenshot -> PNG file.  Usage: node cdp-shot.cjs <base> <out.png>
const base = process.argv[2] || 'http://127.0.0.1:9322';
const out = process.argv[3];
const fs = require('fs');
async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 15000);
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    }
  };
  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('SAVED', out, fs.statSync(out).size, 'bytes');
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
