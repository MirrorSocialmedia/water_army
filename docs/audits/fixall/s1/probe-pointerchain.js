(async () => {
  const b = [...document.querySelectorAll('button,[role=button]')].find(e => (e.innerText || '').trim() === 'Next' && e.offsetWidth > 0);
  if (!b) return 'NOBTN';
  window.__trace = [];
  const r = b.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
  b.dispatchEvent(new PointerEvent('pointerdown', o));
  b.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  b.dispatchEvent(new MouseEvent('mousedown', o));
  b.dispatchEvent(new MouseEvent('mouseup', o));
  b.dispatchEvent(new MouseEvent('click', o));
  await new Promise(r2 => setTimeout(r2, 3000));
  return JSON.stringify({ trace: window.__trace, url: location.href.slice(25, 75), day: !!document.getElementById('day') });
})()
