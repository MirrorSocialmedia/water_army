// WA-D4: trusted CDP mouse click at CSS coords. Usage: node d4ua-click.cjs <base> <x> <y>
const base = process.argv[2], x = +process.argv[3], y = +process.argv[4];
async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let id = 0; const pend = new Map();
  const send = (m, p, tmo = 8000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP timeout ' + m)); } }, tmo);
  });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result); } };
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  console.log('CLICKED', x, y);
  ws.close();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
