(() => {
  window.__rafN = 0;
  const cb = () => { window.__rafN++; if (window.__rafN < 1000) requestAnimationFrame(cb); };
  requestAnimationFrame(cb);
  window.__toFired = 0;
  setTimeout(() => { window.__toFired++; }, 50);
  return JSON.stringify({ vis: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(), installed: true });
})()
