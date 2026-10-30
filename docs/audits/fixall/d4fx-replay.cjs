// S1 full-chain replay: signup -> name -> birthday -> username -> password (fill, NO submit).
// Usage: PW='<password>' node d4fx-replay.cjs <cdpBase>
// Evidence: JSON state lines printed per step (host log), final URL must contain /signup/password.
const base = process.argv[2];
const PW = process.env.PW || '';
(async () => {
  const ts = await (await fetch(base + '/json/list')).json();
  const pages = ts.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  const p = pages[0];
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
  const ev = async (expr, t = 12000) => { const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }, t); if (r.exceptionDetails) return 'EXC:' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 160); return r.result.value; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (k, v) => console.log(k + ' ' + v);
  await send('Page.enable');
  try { await send('Page.setWebLifecycleState', { state: 'active' }); } catch (e) { log('LIFECYCLE', 'FAIL ' + e.message); }

  // 0) timer liveness WITHOUT any lifecycle override (flag-layer test)
  await ev(`(()=>{window.__toFired=0;setTimeout(()=>{window.__toFired++},50);return 1})()`);
  await sleep(1200);
  log('TIMER', await ev(`JSON.stringify({vis:document.visibilityState,toFired:window.__toFired})`));

  // 1) nav signup
  try { await send('Page.navigate', { url: 'https://accounts.google.com/signup' }, 9000); } catch (e) { log('NAV', 'ack-timeout(ok)'); }
  const poll = async (name, expr, n = 30) => {
    for (let i = 0; i < n; i++) { const v = await ev(expr); if (v === true) { log(name, 'OK@' + (i * 0.5) + 's'); return true; } await sleep(500); }
    log(name, 'STUCK ' + await ev(`JSON.stringify({url:location.href.slice(25,75),h1:(document.querySelector('h1')||{}).innerText||'',ids:[...document.querySelectorAll('input,select,[role=radio]')].map(e=>e.id||e.name||e.role).slice(0,8)})`)); return false;
  };
  if (!await poll('NAMESTEP', `(()=>!!document.getElementById('firstName')&&document.getElementById('firstName').offsetWidth>0)()`)) { ws.close(); return; }
  // apply visibility un-hide AFTER nav (target = accounts page)
  await send('Emulation.enable').catch(() => {});
  try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) { log('FOCUSEMUL', 'FAIL ' + e.message); }
  try { await send('Page.setWebLifecycleState', { state: 'active' }); } catch (e) { log('LIFECYCLE', 'FAIL ' + e.message); }
  log('VIS', await ev(`JSON.stringify({vis:document.visibilityState,hidden:document.hidden,focus:document.hasFocus()})`));

  const setV = `(()=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;window.__setV=(el,v)=>{s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};return 1})()`;
  const clickNext = async () => {
    const pos = await ev(`(()=>{const b=[...document.querySelectorAll('button,[role=button]')].find(e=>(e.innerText||'').trim()==='Next'&&e.offsetWidth>0);if(!b)return 'NOBTN';const r=b.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()`);
    if (pos === 'NOBTN') { log('NEXT', 'NOBTN'); return false; }
    const { x, y } = JSON.parse(pos);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
    return true;
  };

  // 2) name step
  await ev(setV);
  log('FILL-NAME', await ev(`(()=>{const a=document.getElementById('firstName'),b=document.getElementById('lastName');if(!a||!b)return 'NOFIELDS';__setV(a,'Daniel');__setV(b,'Rowe');return 'FILLED'})()`));
  if (await clickNext()) { if (!await poll('BIRTHDAYSTEP', `(()=>!!document.getElementById('day')&&document.getElementById('day').offsetWidth>0)()`)) { ws.close(); return; } }

  // 3) birthday step
  log('MONTH-TAG', await ev(`(()=>{const m=document.querySelector('#month');return m?m.tagName:'NO#month'})()`));
  log('FILL-BIRTH', await ev(`(()=>{
    const m=document.querySelector('#month');
    if(m&&m.tagName==='SELECT'){const s=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;s.call(m,'3');m.dispatchEvent(new Event('change',{bubbles:true}));m.dispatchEvent(new Event('input',{bubbles:true}));}
    else if(m){m.click();return 'CUSTOM_MONTH_CLICKED'}
    const d=document.getElementById('day'),y=document.getElementById('year');
    __setV(d,'14');__setV(y,'1991');
    return 'MONTH_BRANCH_DONE';})()`));
  await ev(`(()=>{const d=document.getElementById('day'),y=document.getElementById('year');if(d)__setV(d,'14');if(y)__setV(y,'1991');return 1})()`);
  log('GENDER', await ev(`(()=>{const g=[...document.querySelectorAll('input[type=radio]')].filter(e=>/male/i.test(e.value||'')&&!/female/i.test(e.value||''));if(!g.length)return 'NO_GENDER';g[0].click();return 'GENDER_OK'})()`));
  // custom month second pass (after m.click opened listbox)
  log('MONTH-OPT', await ev(`(()=>{const m=document.querySelector('#month');if(m&&m.tagName!=='SELECT'){const opts=[...document.querySelectorAll('li,[role=option],[role=listbox] *')].filter(e=>(e.innerText||'').trim()==='March'&&e.offsetWidth>0);if(opts.length){opts[0].click();return 'MARCH_CLICKED'}return 'MARCH_NOT_FOUND'}return 'NATIVE_OK'})()`));
  if (await clickNext()) { if (!await poll('USERNAMESTEP', `(()=>{const u=document.getElementById('newUser')||document.querySelector('input[name=username]');return !!(u&&u.offsetWidth>0)})()`)) { ws.close(); return; } }

  // 4) username step (custom)
  log('FILL-USER', await ev(`(()=>{
    let u=document.getElementById('newUser');
    if(!u){const r=[...document.querySelectorAll('input[type=radio]')].find(e=>e.value==='custom');if(r)r.click();return 'CLICKED_CUSTOM_RADIO'}
    __setV(u,'danielrowe7144');return 'FILLED';})()`));
  await sleep(600);
  log('FILL-USER2', await ev(`(()=>{const u=document.getElementById('newUser');return u?('V='+u.value):'NO#newUser'})()`));
  if (await clickNext()) { if (!await poll('PWSTEP', `(()=>{const p=document.querySelector('input[name=Passwdwd],#Passwdwd');return !!(p&&p.offsetWidth>0)})()`)) { ws.close(); return; } }

  // 5) password step: fill, DO NOT submit
  log('FILL-PW', await ev(`(()=>{const ps=[...document.querySelectorAll('input[type=password]')].filter(e=>e.offsetWidth>0);if(ps.length<2)return 'N_PW='+ps.length;__setV(ps[0],${JSON.stringify(PW)});__setV(ps[1],${JSON.stringify(PW)});return 'FILLED'+ps.length})()`));
  log('FINAL', await ev(`JSON.stringify({url:location.href.slice(0,95),pwFields:[...document.querySelectorAll('input[type=password]')].length,bloks:typeof window.Bloks,h1:(document.querySelector('h1')||{}).innerText||''})`));
  ws.close();
})().catch(e => console.log('ERR', e.message));
