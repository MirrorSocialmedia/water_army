(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  const zw = performance.getEntriesByType('resource').filter(r => /zwsi/.test(r.name)).slice(0, 3).map(r => ({ name: r.name.slice(0, 150), init: r.initiatorType, dbs: r.decodedBodySize, rs: r.responseStatus }));
  return JSON.stringify({ nSW: regs.length, scopes: regs.map(r => ({ scope: (r.scope || '').slice(0, 60), active: !!r.active, waiting: !!r.waiting })), zw, bloks: typeof window.Bloks });
})()
