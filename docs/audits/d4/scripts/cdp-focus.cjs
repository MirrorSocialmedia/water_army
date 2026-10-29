// D4: enable focus emulation (stop Chrome treating page as background) then quick eval.
const base = process.argv[2] || 'http://127.0.0.1:9322';
async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  await fetch(base + '/json/activate/' + page.id);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 10000);
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
    }
  };
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { const t0=Date.now(); await new Promise(r=>setTimeout(r,50)); return JSON.stringify({timerWorks:true, dt:Date.now()-t0, vis:document.visibilityState, hidden:document.hidden}); })()`,
    returnByValue: true, awaitPromise: true
  });
  console.log('focus-check:', JSON.stringify(r.result.value));
  ws.close();
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
