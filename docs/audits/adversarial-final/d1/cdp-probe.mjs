// D1-7/D2-0 browser probe via raw CDP against WebView (Chromium engine) in container.
// Usage: node cdp-probe.mjs <hostPort> <dev> ; writes d1/browser-<dev>.json + d1/shot-<dev>.png
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const D1 = '/home/kenneth/.openclaw/workspace/water_army/docs/audits/adversarial-final/d1';
const PORT = process.argv[2], DEV = process.argv[3];

const PAGE = '<html><body><h3 id=h>t</h3><canvas id=c width=200 height=40></canvas><script>window.__t=0;document.addEventListener("touchstart",function(){window.__t++},true);window.__g=0;setTimeout(function(){window.__g=1},0);</script></body></html>';

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error('EX: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(PAGE) });
  await new Promise(r => setTimeout(r, 1500));
  const stage = (t) => writeFileSync(`${D1}/probe-${DEV}.stage`, `${t} @${Date.now()}\n`);

  const env = await evalJs(`JSON.stringify({ua:navigator.userAgent,lang:navigator.language,langs:navigator.languages,mtp:navigator.maxTouchPoints,screen:{w:screen.width,h:screen.height,aw:screen.availWidth,ah:screen.availHeight},dpr:window.devicePixelRatio,dprScreen:window.screen&&screen.devicePixelRatio,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,offset: new Date().getTimezoneOffset()})`);

  const gl = await evalJs(`(function(){var c=document.createElement('canvas');var g=c.getContext('webgl');if(!g)return JSON.stringify({err:'no webgl'});var di=g.getExtension('WEBGL_debug_renderer_info');var out={vendor:g.getParameter(g.VENDOR),renderer:g.getParameter(g.RENDERER)};if(di){out.unmaskedVendor=g.getParameter(di.UNMASKED_VENDOR_WEBGL);out.unmaskedRenderer=g.getParameter(di.UNMASKED_RENDERER_WEBGL);}out.version=g.getParameter(g.VERSION);return JSON.stringify(out);})()`);

  const dataUrl = await evalJs(`(function(){var c=document.getElementById('c');var g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,200,40);g.fillStyle='rgb(255,0,0)';g.fillRect(5,5,30,10);g.font='14px sans-serif';g.fillText('fp-canvas',5,35);return c.toDataURL('image/png');})()`);
  const canvas = { len: String(dataUrl).length, sha256: createHash('sha256').update(String(dataUrl)).digest('hex') };

  stage('pre-webrtc');
  stage('pre-webrtc');
  writeFileSync(`${D1}/browser-${DEV}.partial.json`, JSON.stringify({ env: JSON.parse(env), gl: JSON.parse(gl), canvas }, null, 1));
  // screenshot via device framebuffer (adb screencap in driver) — CDP captureScreenshot hangs on this WebView

  // touch: check listener registered then report current count (driver injects tap before re-read)
  const touch = await evalJs(`JSON.stringify({registered:true,count:window.__t,g:window.__g})`);
  stage('touch-read');

  const webrtc = await evalJs(`(function(){return new Promise(function(res){var out={candidates:[],sdpHasPrivate:false,err:null};try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});pc.onicecandidate=function(e){if(!e.candidate){res(JSON.stringify(out));return;}var c=e.candidate.candidate;out.candidates.push(c);};pc.onicegatheringstatechange=function(){if(pc.iceGatheringState==='complete')res(JSON.stringify(out));};pc.createDataChannel('x');var p=navigator.mediaDevices&&navigator.mediaDevices.getUserMedia;pc.createOffer().then(function(o){pc.setLocalDescription(o);}).catch(function(er){out.err=String(er);res(JSON.stringify(out));});setTimeout(function(){res(JSON.stringify(out));},12000);}catch(er){out.err=String(er);res(JSON.stringify(out));}});})()`);
  stage('post-webrtc');

  writeFileSync(`${D1}/browser-${DEV}.json`, JSON.stringify({ env: JSON.parse(env), gl: JSON.parse(gl), canvas, webrtc: JSON.parse(webrtc), touch: JSON.parse(touch), ts: new Date().toISOString() }, null, 1));
  ws.close();
  process.exit(0);
}
setTimeout(() => { console.error('WATCHDOG_TIMEOUT ' + DEV); process.exit(2); }, 90000).unref();
main().catch((e) => { console.error('PROBE_FAIL ' + DEV + ' ' + e.message); process.exit(1); });
