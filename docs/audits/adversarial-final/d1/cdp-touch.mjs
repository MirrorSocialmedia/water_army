// manual re-read of touch counter after external taps
const PORT = process.argv[2];
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t => t.type === 'page') || list[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params = {}) => new Promise((res) => { const i = Math.floor(Math.random() * 1e9); const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === i) { ws.removeEventListener('message', h); res(m); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id: i, method, params })); });
const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({t:window.__t,url:location.href.slice(0,40)})', returnByValue: true });
console.log('TOUCH_REREAD', r.result?.result?.value || JSON.stringify(r.result?.exceptionDetails || {}).slice(0, 200));
ws.close(); process.exit(0);
