(() => {
  const w = window.WIZ_global_data || window.wiz_global_data || null;
  const keys = w ? Object.keys(w).slice(0, 12) : [];
  const res = performance.getEntriesByType('resource');
  const pend = res.filter(r => r.responseEnd === 0).map(r => r.name.slice(-40)).slice(0, 8);
  const failed = res.filter(r => r.responseStatus === 0 && !/gstatic/.test(r.name)).map(r => ({ n: r.name.slice(-40), d: Math.round(r.duration) })).slice(0, 8);
  const scripts = [...document.scripts];
  return JSON.stringify({
    wizKeys: keys,
    nScripts: scripts.length,
    nInline: scripts.filter(s => !s.src).length,
    hasAFInit: typeof window.AF_initDataCallback,
    hasWiz: typeof window.wiz,
    hasBloks: typeof window.Bloks,
    hasModule: typeof window.module,
    closure: typeof window.CLOSURE_DEFINES,
    pendingRes: pend,
    failedNonGstatic: failed,
    btnHTML: (() => { const b = [...document.querySelectorAll('button,[role=button]')].find(e => (e.innerText || '').trim() === 'Next'); return b ? { tag: b.tagName, type: b.type, aria: b.getAttribute('aria-disabled'), cls: (b.className || '').slice(0, 40) } : null })()
  });
})()
