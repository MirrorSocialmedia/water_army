#!/usr/bin/env python3
"""gen41 STEP1 diagnostics: main-thread responsiveness + grecaptcha state (no strike consumed)"""
import asyncio, json, sys
sys.path.insert(0, "/home/kenneth/.openclaw/workspace/water_army/scripts")
from cdp_helper import CDP

WS = "ws://127.0.0.1:19222/devtools/page/30AB72EDDD3A064B0814B7F76042A53F"

async def timed_eval(cdp, expr, timeout, label):
    try:
        v = await asyncio.wait_for(cdp.eval(expr), timeout=timeout)
        print(f"[OK {label}] {v}")
        return v
    except asyncio.TimeoutError:
        print(f"[TIMEOUT {label}] eval did not return in {timeout}s")
        return None

async def main():
    cdp = CDP(WS)
    await cdp.connect()
    # 0) real frame
    await cdp.screenshot("/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence/s7-s41-00-state.png")
    # 1) main-thread responsiveness (hard measured, 6s bound)
    await timed_eval(cdp, "1+1", 6, "responsiveness-6s")
    # 2) grecaptcha API state
    await timed_eval(cdp, """(() => {
      const g = window.grecaptcha || null;
      const ifr = [...document.querySelectorAll('iframe')].map(f => {
        const r = f.getBoundingClientRect();
        return {src:(f.src||'').slice(0,120), vis:getComputedStyle(f).visibility, x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height)};
      });
      return JSON.stringify({
        url: location.href.split('?')[0],
        readyState: document.readyState,
        grecaptcha_exists: !!g,
        has_ready: g ? typeof g.ready : 'n/a',
        has_enterprise: g ? typeof (g.enterprise||{}) : 'n/a',
        has_enterprise_ready: (g&&g.enterprise) ? typeof g.enterprise.ready : 'n/a',
        anchors: window.___grecaptcha_cfg ? Object.keys(window.___grecaptcha_cfg.anchors||{}).length : 'no_cfg',
        iframes: ifr
      });
    })()""", 8, "grecaptcha-state")
    # 3) resource load ledger for recaptcha/google scripts
    await timed_eval(cdp, """(() => {
      const es = performance.getEntriesByType('resource')
        .filter(e => /recaptcha|google|gstatic/i.test(e.name))
        .map(e => ({n:e.name.replace(/^https:\\/\\//,'').slice(0,90), dur:Math.round(e.duration), size:e.transferSize||0, code:(e.responseStatus===undefined?'?':e.responseStatus)}));
      return JSON.stringify(es);
    })()""", 8, "resource-ledger")
    await cdp.close()

asyncio.run(main())
