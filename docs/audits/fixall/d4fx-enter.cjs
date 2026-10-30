// CDP trusted Enter on focused day input (key routing needs no compositor frame)
const base = process.argv[2];
(async () => {
  const ts = await (await fetch(base + '/json/list')).json();
  const p = ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0];
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  const send = (m, pp, t = 9000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: pp || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('tmo ' + m)); } }, t);
  });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error((m.error.message || '').slice(0, 100))) : res(m.result); } };
  const ev = async (x, t = 9000) => { const r = await send('Runtime.evaluate', { returnByValue: true, expression: x }, t); return r.result.value; };
  const f = await ev(`(()=>{const d=document.getElementById('day');d.focus();return document.activeElement===d?'FOCDAY':'NOFOC'})()`);
  console.log('FOCUS ' + f);
  const K = (type) => ({ type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'char' ? '\r' : undefined, unmodifiedText: type === 'char' ? '\r' : undefined });
  await send('Input.dispatchKeyEvent', K('rawKeyDown'));
  await send('Input.dispatchKeyEvent', K('char'));
  await send('Input.dispatchKeyEvent', K('keyUp'));
  await new Promise(r => setTimeout(r, 2500));
  console.log('AFTER ' + await ev(`JSON.stringify({url:location.href.slice(25,70),user:!!document.getElementById('newUser'),xt:window.__xt&&window.__xt.slice(-4)})`));
  ws.close();
})().catch(e => console.log('ERR', e.message));
