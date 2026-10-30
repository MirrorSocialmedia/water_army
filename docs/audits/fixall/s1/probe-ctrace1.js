(() => {
  window.__trace = [];
  if (!XMLHttpRequest.__patched) {
    XMLHttpRequest.__patched = true;
    const P = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { window.__trace.push('xhr:' + m + ':' + String(u).slice(30, 85)); return P.apply(this, arguments); };
    const S = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (b) { window.__trace.push('xhrSend:' + String(b).slice(0, 40)); return S.apply(this, arguments); };
  }
  const b = [...document.querySelectorAll('button,[role=button]')].find(e => (e.innerText || '').trim() === 'Next' && e.offsetWidth > 0);
  if (b) {
    b.addEventListener('click', () => window.__trace.push('cap:click'), true);
    b.addEventListener('pointerdown', () => window.__trace.push('cap:pd'), true);
    b.click();
    window.__trace.push('clicked:' + (document.getElementById('firstName') || {}).value);
  } else window.__trace.push('NOBTN');
  return JSON.stringify(window.__trace);
})()
