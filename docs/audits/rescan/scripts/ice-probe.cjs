// WA-RESCAN S2: WebRTC ICE gathering probe via raw CDP over the WebView devtools socket.
// Usage: node ice-probe.cjs <cdpHttpBase> <label>
const base = process.argv[2];
const label = process.argv[3] || 'probe';

const ICE_EXPR = `(async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver('video', { direction: 'sendrecv' });
  const candidates = [];
  const done = new Promise((res) => {
    pc.onicecandidate = (e) => { if (e.candidate) candidates.push(e.candidate.candidate); else res(); };
    setTimeout(res, 8000);
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await done;
  const ips = candidates.map((c) => (c.match(/ (\\d{1,3}(?:\\.\\d{1,3}){3}) \\d+ typ/) || [null, null])[1]).filter(Boolean);
  pc.close();
  return JSON.stringify({ ua: navigator.userAgent, candidates, ips });
})()`;

async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target with ws url: ' + JSON.stringify(targets.map((t) => t.type)));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout ' + method)); } }, 60000);
    });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message || 'CDP error')); else res(msg.result);
    }
  };
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', {
    expression: ICE_EXPR, awaitPromise: true, returnByValue: true, timeout: 20000,
  });
  if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  console.log(JSON.stringify({ label, page: page.url, ...(JSON.parse(r.result.value)) }, null, 1));
  ws.close();
}
main().catch((e) => { console.error('PROBE_FAIL', e.message); process.exit(2); });
