(() => {
  const pchain = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
    ['pointerover', 'pointerdown', 'pointerup', 'pointerout', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)));
  };
  const m = document.querySelector('#month');
  const mSel = m ? (m.innerText || '').trim().slice(0, 15) : null;
  const males = [...document.querySelectorAll('li')].filter(e => (e.innerText || '').trim() === 'Male');
  const st = males.map(e => ({ sel: e.getAttribute('aria-selected'), cls: (e.className || '').slice(0, 20), vis: e.offsetParent !== null }));
  males.forEach(pchain);
  const b = [...document.querySelectorAll('button,[role=button]')].find(e => (e.innerText || '').trim() === 'Next' && e.offsetWidth > 0);
  if (b) pchain(b);
  return JSON.stringify({ mSel, maleSt: st, next: !!b });
})()
