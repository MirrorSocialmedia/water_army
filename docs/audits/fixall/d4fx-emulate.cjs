// S1 avoidance test: un-hide page via CDP, then verify timers/rAF alive, then replay Next click.
// Usage: node d4fx-emulate.cjs <cdpBase> [fillAndClick]
const base = process.argv[2];
const go = process.argv[3] === 'click';
(async () => {
  const ts = await (await fetch(base + '/json/list')).json();
  const p = ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)[0];
  if (!p) throw new Error('no page');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  const send = (m, pp, t = 12000) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: pp || {} }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('tmo ' + m)); } }, t);
  });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error((m.error.message || '').slice(0, 120))) : res(m.result); } };
  const ev = async (expr, t = 12000) => { const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }, t); return r.result.value !== undefined ? r.result.value : JSON.stringify(r.exceptionDetails && (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) || {}); };
  const log = s => console.log(s);

  await send('Page.enable');
  await send('Emulation.enable').catch(() => {});
  try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); log('focusEmul=ON'); } catch (e) { log('focusEmul FAIL ' + e.message); }
  try { await send('Page.setWebLifecycleState', { state: 'active' }); log('lifecycle=active'); } catch (e) { log('lifecycle FAIL ' + e.message); }

  // probe: timers + rAF alive?
  await ev(`(()=>{window.__rafN=0;const cb=()=>{window.__rafN++;if(window.__rafN<999)requestAnimationFrame(cb)};requestAnimationFrame(cb);window.__toFired=0;setTimeout(()=>{window.__toFired++},50);return JSON.stringify({vis:document.visibilityState})})()`);
  await new Promise(r => setTimeout(r, 2500));
  log('VIS ' + await ev(`JSON.stringify({vis:document.visibilityState,rafN:window.__rafN,toFired:window.__toFired})`));

  if (go) {
    // fill + click Next (CDP trusted mouse), then poll URL up to 10s
    log('FILL ' + await ev(`(()=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;const f=(el,v)=>{s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};const a=document.getElementById('firstName'),b=document.getElementById('lastName');if(!a||!b)return 'NOFIELDS';f(a,'Daniel');f(b,'Rowe');return 'FILLED';})()`));
    const pos = await ev(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(e=>(e.innerText||'').trim()==='Next'&&e.offsetWidth>0);if(!b)return 'NOBTN';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()`);
    log('BTN ' + pos);
    if (pos !== 'NOBTN') {
      const { x, y } = JSON.parse(pos);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const st = await ev(`JSON.stringify({url:location.href.slice(30,80),h1:(document.querySelector('h1')||{}).innerText||'',ins:[...document.querySelectorAll('input')].map(e=>e.id||e.type).slice(0,6),bloks:typeof window.Bloks})`);
        log('POLL' + i + ' ' + st);
        if (!/name\?/.test(await ev('location.href'))) break;
      }
    }
  }
  ws.close();
})().catch(e => console.log('ERR', e.message));
