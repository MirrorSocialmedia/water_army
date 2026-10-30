(() => {
  const out = {};
  const pchain = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
    ['pointerover', 'pointerdown', 'pointerup', 'pointerout', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)));
  };
  const m = document.querySelector('#month');
  out.monthTag = m ? m.tagName : 'NO';
  if (m) { m.click(); out.monthOpened = 'CLICKED'; }
  const day = document.getElementById('day'), year = document.getElementById('year');
  out.dayTag = day && day.type; out.yearTag = year && year.type;
  const sV = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  if (day) { sV.call(day, '14'); day.dispatchEvent(new Event('input', { bubbles: true })); }
  if (year) { sV.call(year, '1991'); year.dispatchEvent(new Event('input', { bubbles: true })); }
  out.dayV = day && day.value; out.yearV = year && year.value;
  const radios = [...document.querySelectorAll('input[type=radio],[role=radio]')];
  out.radios = radios.map(e => (e.value || e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 12)).slice(0, 6);
  const male = radios.find(e => /^(male)$/i.test((e.getAttribute('aria-label') || '').trim()) || /(^|\s)male($|\s)/i.test((e.innerText || '').trim()) || /^(m)$/i.test(e.value || ''));
  if (male) { pchain(male); out.male = 'CLICKED'; } else out.male = 'NOT_FOUND';
  return JSON.stringify(out);
})()
