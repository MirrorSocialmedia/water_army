// Test: does captureScreenshot force a frame & revive CDP mouse hit-test on birthday step?
const base = process.argv[2];
(async () => {
  const ts = await (await fetch(base + '/json/list')).json();
  const p = ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0];
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  const send = (m, pp, t = 12000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: pp || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('tmo ' + m)); } }, t);
  });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error((m.error.message || '').slice(0, 100))) : res(m.result); } };
  const ev = async (x, t = 8000) => { const r = await send('Runtime.evaluate', { returnByValue: true, expression: x }, t); return r.result.value; };
  await send('Page.enable');
  const t0 = Date.now();
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' }, 12000);
    require('fs').writeFileSync(require('path').join(__dirname, 's1', 'probe-frame-shot.png'), Buffer.from(shot.data, 'base64'));
    console.log('SHOT OK ' + (Date.now() - t0) + 'ms ' + Math.round(shot.data.length / 1024) + 'KB');
  } catch (e) { console.log('SHOT FAIL ' + e.message); }
  console.log('DUMP ' + await ev(`JSON.stringify({day:!!document.getElementById('day'),url:location.href.slice(25,60)})`));
  ws.close();
})().catch(e => console.log('ERR', e.message));
