(() => {
  const pchain = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
    ['pointerover', 'pointerdown', 'pointerup', 'pointerout', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)));
  };
  const btns = [...document.querySelectorAll('button,[role=button],a[role=button]')].filter(e => (e.innerText || '').trim() === 'Next');
  const info = btns.map(e => ({ vis: e.offsetParent !== null, w: e.offsetWidth, inMain: !!e.closest('main,form,[role=main]') }));
  const vis = btns.filter(e => e.offsetParent !== null && e.offsetWidth > 0);
  (vis.length ? vis : btns).forEach(pchain);
  return JSON.stringify({ n: btns.length, info: info.slice(0, 6), clicked: vis.length || btns.length });
})()
