(() => JSON.stringify({ t2: window.__t2, tr: window.__tr, url: location.href.slice(25, 75), day: !!document.getElementById('day'), year: (document.getElementById('year') || {}).value || null }))()
