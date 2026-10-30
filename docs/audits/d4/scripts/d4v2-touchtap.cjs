// D4v2: CDP trusted touch tap at CSS coords on FB Bloks Log in. Usage: node d4v2-touchtap.cjs <base> <cssX> <cssY>
const base = process.argv[2], cx = Number(process.argv[3]), cy = Number(process.argv[4]);
async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 12000);
  });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
  const t = { x: cx, y: cy };
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...t, id: 1 }] });
  await new Promise(r => setTimeout(r, 80));
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  console.log('TOUCH_SENT', cx, cy);
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
