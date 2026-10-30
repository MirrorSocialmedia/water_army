(() => {
  const errTxt = [...document.querySelectorAll('[role=alert],[aria-live],.VfPpkd-Strunf,.LZ8lqe,div[class*=error]')].map(e => (e.innerText || '').trim().slice(0, 50)).filter(Boolean).slice(0, 6);
  const m = document.querySelector('#month');
  return JSON.stringify({
    url: location.href.slice(25, 70),
    errTxt,
    monthTxt: m ? (m.innerText || '').trim().slice(0, 20) : null,
    monthAria: m && m.getAttribute('aria-expanded'),
    males: [...document.querySelectorAll('li')].filter(e => (e.innerText || '').trim() === 'Male').length,
    body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220)
  });
})()
