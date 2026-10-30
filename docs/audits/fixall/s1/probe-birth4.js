(() => {
  const pchain = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
    ['pointerover', 'pointerdown', 'pointerup', 'pointerout', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)));
  };
  const month = document.querySelector('#month');
  if (month) pchain(month);
  const pick = (ulText, liText) => {
    const uls = [...document.querySelectorAll('ul')].filter(u => [...u.children].some(c => (c.innerText || '').trim() === ulText));
    if (!uls.length) return 'NO_UL:' + liText;
    const ul = uls[uls.length - 1];
    const li = [...ul.children].find(c => (c.innerText || '').trim() === liText);
    if (!li) return 'NO_LI:' + liText;
    pchain(li);
    if (li.querySelector('input')) { const inp = li.querySelector('input'); if (inp.type === 'radio' || inp.type === 'checkbox') inp.click(); }
    return 'CLICKED:' + liText;
  };
  const r1 = pick('January', 'March');
  const r2 = pick('Female', 'Male');
  const monthTxt = () => { const m = document.querySelector('#month'); return m ? (m.innerText || '').trim().slice(0, 12) : null };
  return JSON.stringify({ r1, r2, monthTxt: monthTxt(), monthTag: month && month.tagName });
})()
