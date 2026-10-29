// WA-RESCAN S3: generic raw-CDP page evaluation (WebView devtools).
// Usage: node cdp-eval.cjs <cdpHttpBase> <exprFile>  → prints {"ok":true,"value":...}
const fs = require('node:fs');
const base = process.argv[2];
const expr = fs.readFileSync(process.argv[3], 'utf8');

async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 30000);
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    }
  };
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 25000 });
  if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  console.log(JSON.stringify({ page: page.url, value: r.result.value }));
  ws.close();
}
main().catch((e) => { console.error('EVAL_FAIL', e.message); process.exit(2); });
