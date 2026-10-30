// IME-fill attempt on current name step: focus -> Input.insertText (trusted IME), CDP click Next.
const base = process.argv[2];
(async () => {
  const ts = await (await fetch(base + '/json/list')).json();
  const p = ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0];
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  const send = (m, pp, t = 10000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: pp || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('tmo ' + m)); } }, t);
  });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error((m.error.message || '').slice(0, 100))) : res(m.result); } };
  const ev = async (x, t = 10000) => { const r = await send('Runtime.evaluate', { returnByValue: true, expression: x }, t); return r.result.value; };
  console.log('TR2 ' + await ev(`JSON.stringify(window.__trace||[])`));
  for (const [sel, txt] of [['#firstName', 'Daniel'], ['#lastName', 'Rowe']]) {
    const ok = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'NO';e.focus();return document.activeElement===e?'FOC':'NOFOC'})()`);
    console.log('FOCUS ' + sel + ' ' + ok);
    if (ok === 'FOC') await send('Input.insertText', { text: txt });
  }
  console.log('VALS ' + await ev(`JSON.stringify({f:(document.getElementById('firstName')||{}).value,l:(document.getElementById('lastName')||{}).value})`));
  const pos = await ev(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(e=>(e.innerText||'').trim()==='Next'&&e.offsetWidth>0);if(!b)return null;const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()`);
  console.log('BTN ' + pos);
  if (pos) {
    const { x, y } = JSON.parse(pos);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
    await new Promise(r => setTimeout(r, 2500));
    console.log('AFTER ' + await ev(`JSON.stringify({url:location.href.slice(25,72),trace:window.__trace,day:!!document.getElementById('day')})`));
  }
  ws.close();
})().catch(e => console.log('ERR', e.message));
