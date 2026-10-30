(() => {
  window.__xt = [];
  if (!XMLHttpRequest.__p2) {
    XMLHttpRequest.__p2 = true;
    const O = XMLHttpRequest.prototype.open, S = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); window.__xt.push('open:' + m + ':' + this.__u.slice(30, 90)); return O.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) { const x = this; window.__xt.push('send:' + String(b).slice(0, 30)); x.addEventListener('load', () => window.__xt.push('load:' + x.status + ':' + String(x.responseText).slice(0, 40))); x.addEventListener('error', () => window.__xt.push('xhrERR')); x.addEventListener('timeout', () => window.__xt.push('xhrTIMEOUT')); return S.apply(this, arguments); };
  }
  const b = [...document.querySelectorAll('button')].find(e => (e.innerText || '').trim() === 'Next' && e.offsetWidth > 0);
  window.__xt.push('rafP:' + (window.__rafPatchedByCDP ? 'yes' : 'no') + '|vis:' + document.visibilityState);
  if (!b) { window.__xt.push('NOBTN'); return JSON.stringify(window.__xt); }
  const r = b.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, pointerId: 3, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
  ['pointerover', 'pointerdown', 'pointerup', 'pointerout', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(t => b.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)));
  window.__xt.push('clicked@' + Math.round(r.left) + ',' + Math.round(r.top));
  return JSON.stringify(window.__xt);
})()
