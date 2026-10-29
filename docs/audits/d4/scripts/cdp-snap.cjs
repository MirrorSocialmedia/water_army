// D4: CDP DOM snapshot -> MHTML file (works when compositor gives no frame).
const base = process.argv[2];
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
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 20000);
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    }
  };
  const shot = await send('Page.captureSnapshot', { format: 'mhtml' });
  const data = typeof shot === 'string' ? shot : (shot.data || shot.value || null);
  if (!data) throw new Error('NO_DATA ' + JSON.stringify(shot).slice(0,120));
  fs.writeFileSync(out, data);
  console.log('SAVED', out, fs.statSync(out).size, 'bytes');
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
