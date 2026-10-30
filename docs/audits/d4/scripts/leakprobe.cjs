// WA-D4 leak-scan v2: two-phase CDP JS probe (timer-throttling-safe: no in-page setTimeout dependence).
// Usage: node leakprobe.cjs <cdpHttpBase> <outJsonFile> [--mode=full|lite]
// Phase 1 (sync eval): collect all sync fields, install sensor listeners, kick async APIs into window.__lpA, kick HEAD fetch for Network header capture.
// Host sleeps 3.5s. Phase 2 (sync eval): serialize everything.
// Red lines: read-only JS; no navigation, no clicks, no settings changes.
const fs = require('node:fs');
const base = process.argv[2];
const outFile = process.argv[3];
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=full').split('=')[1];

const SYNC_COLLECT = `(function () {
  var p = {};
  try {
    p._ts = new Date().toISOString();
    p.href = location.href;
    p.userAgent = navigator.userAgent;
    p.platform = navigator.platform;
    p.appVersion = navigator.appVersion;
    p.vendor = navigator.vendor;
    p.languages = navigator.languages;
    p.language = navigator.language;
    p.uaData = navigator.userAgentData ? { mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform, brands: navigator.userAgentData.brands } : null;
    p.webdriver = navigator.webdriver;
    p.chromeRuntime = !!(window.chrome && window.chrome.runtime);
    p.chromeRuntimeId = !!(window.chrome && window.chrome.runtime && window.chrome.runtime.id);
    p.hardwareConcurrency = navigator.hardwareConcurrency;
    p.deviceMemory = navigator.deviceMemory;
    p.maxTouchPoints = navigator.maxTouchPoints;
    p.pluginsLength = navigator.plugins.length;
    p.mimeTypesLength = navigator.mimeTypes.length;
    p.pdfViewerEnabled = navigator.pdfViewerEnabled;
    p.connection = navigator.connection ? { effectiveType: navigator.connection.effectiveType, type: navigator.connection.type, downlink: navigator.connection.downlink, rtt: navigator.connection.rtt, saveData: navigator.connection.saveData } : null;
    p.cookieEnabled = navigator.cookieEnabled;
    p.doNotTrack = navigator.doNotTrack;
    p.globalPrivacyControl = navigator.globalPrivacyControl;
    p.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, availLeft: screen.availLeft, availTop: screen.availTop, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, orientationType: (screen.orientation && screen.orientation.type) || null };
    p.dpr = window.devicePixelRatio;
    p.inner = { w: innerWidth, h: innerHeight };
    p.outer = { w: outerWidth, h: outerHeight };
    p.visual = window.visualViewport ? { w: visualViewport.width, h: visualViewport.height, scale: visualViewport.scale } : null;
    p.media = { fine: matchMedia('(pointer: fine)').matches, coarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches, anyHover: matchMedia('(any-hover: any-hover)').matches, anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches };
    p.intl = Intl.DateTimeFormat().resolvedOptions();
    p.intlNumberSample = new Intl.NumberFormat().format(1234.5);
    p.collatorLocale = new Intl.Collator().resolvedOptions().locale;
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      p.webgl = gl ? { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        version: gl.getParameter(gl.VERSION), shading: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) } : null;
      p.webgl2 = !!document.createElement('canvas').getContext('webgl2');
    } catch (e) { p.webglErr = String(e); }
    try {
      var fonts = ['Roboto','Noto Sans','Google Sans','Roboto Condensed','Droid Sans','Caveat','Source Sans Pro','Lato','Arial','Helvetica','Segoe UI','Times New Roman','Impact','monospace','serif','sans-serif'];
      p.fontsCheck = {};
      for (var i = 0; i < fonts.length; i++) { try { p.fontsCheck[fonts[i]] = document.fonts.check('12px "' + fonts[i] + '"'); } catch (e2) { p.fontsCheck[fonts[i]] = 'err'; } }
      p.fontsStatus = document.fonts.status;
      p.fontsLoadedCount = document.fonts.size;
    } catch (e) { p.fontsErr = String(e); }
    p.ontouchstart = ('ontouchstart' in window);
    p.historyLength = history.length;
    p.serviceWorker = ('serviceWorker' in navigator) ? 'supported' : 'absent';
    p.visibility = document.visibilityState;
    p.hidden = document.hidden;
    // sensor listeners (counts read in phase 2)
    window.__lpCounts = { devicemotion: 0, deviceorientation: 0, deviceorientationabsolute: 0, devicelight: 0 };
    window.__lpHandlers = {};
    Object.keys(window.__lpCounts).forEach(function (k) {
      window.__lpHandlers[k] = function () { window.__lpCounts[k]++; };
      window.addEventListener(k, window.__lpHandlers[k], true);
    });
    window.__lpSensorInstalledAt = Date.now();
    // kick async APIs into window.__lpA (no in-page timers needed for collection correctness)
    window.__lpA = { pending: true };
    function putA(key, val) { window.__lpA[key] = val; }
    try {
      if (navigator.getBattery) navigator.getBattery().then(function (b) { putA('battery', { level: b.level, charging: b.charging }); }, function (e) { putA('batteryErr', String(e)); });
      else putA('battery', { supported: false });
    } catch (e) { putA('batteryErr', String(e)); }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        window.__lpPerms = {};
        ['geolocation','notifications','camera','microphone','sensor'].forEach(function (n) {
          try { navigator.permissions.query({ name: n }).then(function (st) { window.__lpPerms[n] = st.state; }, function () { window.__lpPerms[n] = 'denied-err'; }); } catch (e) { window.__lpPerms[n] = 'unsupported'; }
        });
      }
    } catch (e) { putA('permissionsErr', String(e)); }
    try {
      if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (s) { putA('storage', { quota: s.quota, usage: s.usage }); }, function (e) { putA('storageErr', String(e)); });
    } catch (e) { putA('storageErr', String(e)); }
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) navigator.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','model','bitness','formFactors']).then(function (v) { putA('uaHighEntropy', v); }, function (e) { putA('uaHighEntropyErr', String(e)); });
    } catch (e) { putA('uaHighEntropyErr', String(e)); }
    try { putA('uaFullVersionSync', (navigator.userAgentData && navigator.userAgentData.getUAMetadata ? 'metadata-api' : 'brands-only')); } catch (e) {}
    window.__lpA.pending = false;
  } catch (e) { p._phase1Err = String(e); }
  return JSON.stringify(p);
})()`;

const PHASE2 = `(function () {
  var p = { sensorCounts: window.__lpCounts || null, sensorWindowMs: (window.__lpSensorInstalledAt ? Date.now() - window.__lpSensorInstalledAt : null) };
  p.async = window.__lpA || null;
  try { p.async.pending = false; } catch (e) {}
  p.perms = (typeof window.__lpPerms !== 'undefined') ? window.__lpPerms : null;
  // cleanup listeners
  try { Object.keys(window.__lpHandlers || {}).forEach(function (k) { window.removeEventListener(k, window.__lpHandlers[k], true); }); } catch (e) {}
  return JSON.stringify(p);
})()`;

async function main() {
  const targets = await (await fetch(base + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  let msgId = 0;
  const pending = new Map();
  const netHeaders = [];
  function send(method, params) {
    return new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('cmd timeout ' + method)); } }, 20000);
    });
  }
  function evaluate(expression) {
    return send('Runtime.evaluate', { expression, returnByValue: true }).then((r) => {
      if (r.exceptionDetails) throw new Error('EVAL_EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    });
  }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p2 = pending.get(m.id); pending.delete(m.id); m.error ? p2.rej(new Error(JSON.stringify(m.error))) : p2.res(m.result); return; }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      netHeaders.push({ url: String(r.url).slice(0, 140), method: r.method, initiator: (m.params.initiator && m.params.initiator.type) || '?', headers: r.headers });
    }
  };
  await send('Network.enable');
  const p1val = await evaluate(SYNC_COLLECT);
  // kick a HEAD fetch with page-side race against nothing (fetch promise; page throttling doesn't matter, we read via Network events)
  send('Runtime.evaluate', { expression: "try { fetch(location.href, {method:'HEAD', cache:'no-store'}).then(function(){}, function(){}); 'ok'; } catch(e) { String(e); }", returnByValue: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3500));
  const p2val = await evaluate(PHASE2);
  const p1 = netHeaders.find((h) => /generate_204|favicon|HEAD/i.test(h.method + h.url)) || netHeaders[netHeaders.length - 1];
  const payload = {
    cdpBase: base, targetUrl: page.url, mode,
    evaluatedAt: new Date().toISOString(),
    probe: { sync: JSON.parse(p1val), phase2: JSON.parse(p2val) },
    networkRequests: netHeaders.slice(-10),
    secChUaCaptured: netHeaders.map((h) => ({ url: h.url, secChUaPlatform: h.headers && (h.headers['sec-ch-ua-platform'] || h.headers['Sec-Ch-Ua-Platform'] || null), secChUa: h.headers && (h.headers['sec-ch-ua'] || h.headers['Sec-Ch-Ua'] || null), ua: h.headers && (h.headers['User-Agent'] || h.headers['user-agent'] || null) })).filter((x) => x.secChUa || x.ua)
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log('WROTE', outFile, 'sensorCounts=' + JSON.stringify(payload.probe.phase2.sensorCounts), 'netReqs=' + netHeaders.length);
  ws.close();
}
main().catch((e) => { console.error('PROBE_FAIL', e.message); process.exit(2); });
