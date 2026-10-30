(() => {
  const els = [...document.querySelectorAll('select, [role=radio], [role=combobox], [role=listbox], [role=option], [role=button], label')]
    .filter(e => e.offsetWidth > 0)
    .map(e => ({ tag: e.tagName, role: e.getAttribute('role') || '', id: (e.id || '').slice(0, 10), aria: (e.getAttribute('aria-label') || e.getAttribute('aria-owns') || e.getAttribute('aria-expanded') || '').slice(0, 16), txt: (e.innerText || e.value || '').trim().slice(0, 18) }))
    .slice(0, 28);
  const month = document.querySelector('#month');
  const mstate = month ? { aria: month.getAttribute('aria-expanded'), owns: month.getAttribute('aria-owns'), txt: (month.innerText || '').slice(0, 10) } : null;
  const lists = [...document.querySelectorAll('[role=listbox],select')].map(e => ({ tag: e.tagName, n: e.children.length, id: e.id || '', opts: [...e.children].slice(0, 3).map(c => (c.innerText || c.value || '').trim().slice(0, 8)) }));
  return JSON.stringify({ els, mstate, lists });
})()
