(() => {
  const b = [...document.querySelectorAll('button')].find(e => (e.innerText || '').trim() === 'Next' && e.offsetWidth > 0);
  const evOpts = { bubbles: true, cancelable: true, composed: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  (b || document).dispatchEvent(new KeyboardEvent('keydown', evOpts));
  (b || document).dispatchEvent(new KeyboardEvent('keypress', evOpts));
  (b || document).dispatchEvent(new KeyboardEvent('keyup', evOpts));
  document.dispatchEvent(new KeyboardEvent('keydown', evOpts));
  const pend = performance.getEntriesByType('resource').filter(r => r.responseEnd === 0 && /m=/.test(r.name)).map(r => r.name.slice(-30)).slice(0, 4);
  return JSON.stringify({ sent: !!b, pendChunks: pend });
})()
