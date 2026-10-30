(() => {
  if (!window.__rafP) {
    window.__rafP = true;
    window.__rafOld = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => setTimeout(() => { try { cb(performance.now()); } catch (e) { void e; } }, 16);
    window.cancelAnimationFrame = (h) => clearTimeout(h);
  }
  const b = [...document.querySelectorAll('button')].find(e => (e.innerText || '').trim() === 'Next' && e.offsetWidth > 0);
  if (!b) return 'NOBTN';
  b.scrollIntoView({ block: 'nearest' });
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: 2, isPrimary: true, button: 0, buttons: 1 }));
  b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerId: 2, isPrimary: true, button: 0, buttons: 0 }));
  b.click();
  return 'CLICKED';
})()
