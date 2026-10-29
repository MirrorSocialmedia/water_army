// D4: minimal CDP eval without Runtime.enable (busy pages). Usage: node cdp-mini.cjs <cdpHttpBase> <exprFile>
const fs = require('node:fs');
const base = process.argv[2];
const expr = fs.readFileSync(process.argv[3], 'utf8');

async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  const r = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('eval timeout')), 30000);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) { clearTimeout(timer); res(msg); }
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  console.log(JSON.stringify(r.result !== undefined ? r.result : r));
  ws.close();
}
main().catch((e) => { console.error('MINI_FAIL', e.message); process.exit(2); });
