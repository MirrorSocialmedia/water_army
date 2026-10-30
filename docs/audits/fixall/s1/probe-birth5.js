(() => {
  const pchain = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
    ['pointerover', 'pointerdown', 'pointerup', 'pointerout', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o)));
    if (liHasInput(el)) el.querySelector('input').click();
  };
  const liHasInput = (el) => el.querySelector && el.querySelector('input');
  const lis = [...document.querySelectorAll('li')].filter(e => (e.innerText || '').trim() === 'March');
  const lisM = [...document.querySelectorAll('li')].filter(e => (e.innerText || '').trim() === 'Male');
  lis.forEach(pchain); lisM.forEach(pchain);
  const inpM = [...lisM].map(e => e.querySelector('input')).filter(Boolean);
  inpM.forEach(i => { if (i.type === 'radio') i.click(); });
  const m = document.querySelector('#month');
  const monthSel = m ? (m.innerText || '').trim().slice(0, 15) : null;
  const genderChk = inpM.map(i => i.checked);
  return JSON.stringify({ nMarch: lis.length, nMale: lisM.length, inpM: inpM.length, genderChk, monthSel });
})()
