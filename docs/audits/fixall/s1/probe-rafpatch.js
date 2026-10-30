(async () => {
  const before = document.querySelector('#firstName') ? document.querySelector('#firstName').value : null;
  if (!window.__rafPatched) {
    window.__rafPatched = true;
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = (h) => clearTimeout(h);
  }
  const btn = [...document.querySelectorAll('button,[role=button]')].find(e => (e.innerText || '').trim() === 'Next' && e.offsetWidth > 0);
  if (!btn) return 'NOBTN';
  btn.click();
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 700));
    if (/birthdaygender/.test(location.href)) break;
  }
  return JSON.stringify({ url: location.href.slice(25, 80), day: !!document.getElementById('day'), year: (document.getElementById('year') || {}).value || null, before });
})()
