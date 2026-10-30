(() => {
  window.__t2 = 0;
  setTimeout(() => { window.__t2++; }, 30);
  const b = [...document.querySelectorAll('button,[role=button]')].find(e => (e.innerText || '').trim() === 'Next' && e.offsetWidth > 0);
  window.__tr = [];
  if (b) {
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
    ['pointerover', 'pointerenter', 'pointerdown', 'pointerup', 'pointerout', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(t => b.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)));
    window.__tr.push('DISPATCHED');
  } else window.__tr.push('NOBTN');
  return JSON.stringify({ vis: document.visibilityState, hidden: document.hidden, tr: window.__tr, fn: (document.getElementById('firstName') || {}).value });
})()
