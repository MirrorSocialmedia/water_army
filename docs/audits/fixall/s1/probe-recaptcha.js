(async () => {
  const res = performance.getEntriesByType('resource');
  const rc = res.filter(r => /recaptcha/.test(r.name)).map(r => ({ n: r.name.slice(0, 120), rs: r.responseStatus, dbs: r.decodedBodySize, ts: r.transferSize, d: Math.round(r.duration) }));
  const bad = res.find(r => r.responseStatus === 0 && /render=/.test(r.name));
  let fetchProbe = null, netProbe = null;
  if (bad) {
    try { const r = await fetch(bad.name, { cache: 'reload' }); fetchProbe = { st: r.status, ok: r.ok, len: (await r.text()).length }; } catch (e) { fetchProbe = 'FETCH_ERR:' + e.message; }
    try { const r = await fetch(bad.name, { cache: 'no-store' }); netProbe = { st: r.status, len: (await r.text()).length }; } catch (e) { netProbe = 'FETCH_ERR:' + e.message; }
  }
  return JSON.stringify({ rc, badUrl: bad && bad.name.slice(0, 130), fetchProbe, netProbe });
})()
