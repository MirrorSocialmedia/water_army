// Minimal CDP eval: node d4fx-eval.cjs <cdpBase> <jsFile>  -> prints JSON value
const fs = require('fs');
const base = process.argv[2], jsFile = process.argv[3];
const expr = fs.readFileSync(jsFile, 'utf8');
(async () => {
  const ts = await (await fetch(base + '/json/list')).json();
  const pages = ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  const p = pages[0];
  if (!p) throw new Error('no page');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  const send = (m, pp, t = 15000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: pp || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('tmo ' + m)); } }, t);
  });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result); } };
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
  console.log(JSON.stringify(r.result.value !== undefined ? r.result.value : (r.exceptionDetails && (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)) || r));
  ws.close();
})().catch(e => console.log('ERR', e.message));
