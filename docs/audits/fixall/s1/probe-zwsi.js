(() => {
  const zw = performance.getEntriesByType('resource').filter(r => /zwsi/.test(r.name));
  return JSON.stringify({
    n: zw.length,
    full: zw[0] ? zw[0].name : null,
    uniqNames: [...new Set(zw.map(r => r.name))].length,
    starts: zw.map(r => Math.round(r.startTime)).slice(0, 12),
    durs: zw.map(r => Math.round(r.duration)).slice(0, 12),
    navType: performance.getEntriesByType('navigation')[0] ? performance.getEntriesByType('navigation')[0].type : null,
    navTs: performance.getEntriesByType('navigation')[0] ? performance.getEntriesByType('navigation')[0].transferSize : null
  });
})()
