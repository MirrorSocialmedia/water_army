(async () => {
  const g = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : null;
  };
  const btn = [...document.querySelectorAll('button,[role=button]')].find(e => (e.innerText || '').trim() === 'Next');
  const state1 = { fn: g('firstName'), ln: g('lastName'), btnTag: btn && btn.tagName, url0: location.href.slice(0, 70) };
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 3500));
  const state2 = { url1: location.href.slice(0, 90), h1: (document.querySelector('h1') || {}).innerText, bloks: typeof window.Bloks, inputs: [...document.querySelectorAll('input')].map(e => e.id + '=' + (e.value || '').slice(0, 8)) };
  return JSON.stringify({ state1, state2 });
})()
