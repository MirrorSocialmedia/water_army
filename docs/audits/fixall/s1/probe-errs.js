(() => {
  const errNodes = [...document.querySelectorAll('span,div,p')].filter(e => /please|enter|choose|select|required|birthday/i.test((e.innerText || '').trim()) && (e.innerText || '').trim().length < 70 && e.offsetWidth > 0 && e.children.length === 0);
  const uniq = [...new Set(errNodes.map(e => (e.innerText || '').trim()))].slice(0, 8);
  const m = document.querySelector('#month');
  const monthState = m ? (m.getAttribute('aria-label') || (m.innerText || '').slice(0, 20)) : null;
  const dayv = (document.getElementById('day') || {}).value, yv = (document.getElementById('year') || {}).value;
  const radios2 = [...document.querySelectorAll('[role=radio],[role=option]')].filter(e => e.offsetWidth > 0).map(e => (e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 14) + ':' + e.getAttribute('aria-selected')).slice(0, 8);
  return JSON.stringify({ errs: uniq, monthState, dayv, yv, radios2, url: location.href.slice(25, 62) });
})()
