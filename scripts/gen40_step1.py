#!/usr/bin/env python3
"""gen40: Fill name + shadow DOM birthday/gender using CDP rect"""
import asyncio, json, os, subprocess, sys
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"

async def send_recv(ws, cid_holder, method, params=None):
    cid_holder[0] += 1
    cid = cid_holder[0]
    cmd = {"id": cid, "method": method}
    if params:
        cmd["params"] = params
    await ws.send(json.dumps(cmd))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        r = json.loads(raw)
        if r.get("id") == cid:
            return r.get("result", {})

async def cdp_eval(ws, cid, expr, timeout=10):
    cid[0] += 1
    cmd = {"id": cid[0], "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True}}
    await ws.send(json.dumps(cmd))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        r = json.loads(raw)
        if r.get("id") == cid[0]:
            return r.get("result", {}).get("result", {}).get("value", None)

def screencap(name):
    path = f"{EVIDENCE}/{name}"
    subprocess.run(["adb","-s","127.0.0.1:16701","shell","screencap","-p","/data/local/tmp/tmpcap.png"], check=True, capture_output=True)
    subprocess.run(["adb","-s","127.0.0.1:16701","pull","/data/local/tmp/tmpcap.png",path], check=True, capture_output=True)
    sz = os.path.getsize(path) if os.path.exists(path) else 0
    print(f"  [{name}] {sz} bytes")
    return path

async def cdp_click(ws, cid, x, y):
    """Click at viewport coordinates"""
    await send_recv(ws, cid, "Input.dispatchMouseEvent", {"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1})
    await send_recv(ws, cid, "Input.dispatchMouseEvent", {"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1})

async def main():
    ws = await websockets.connect(WS_URL, max_size=15*1024*1024)
    cid = [0]
    await send_recv(ws, cid, "Runtime.enable")
    await send_recv(ws, cid, "Page.enable")
    
    # Step 1: Fill lastName and firstName (light DOM inputs)
    print("=== FILL NAMES ===")
    # Method: set value + dispatch input/change events (React-compatible)
    r = await cdp_eval(ws, cid, """
(() => {
    const ln = document.querySelector('input[name="lastName"]');
    const fn = document.querySelector('input[name="firstName"]');
    if(!ln || !fn) return 'MISSING';
    // React-compatible value setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(ln, 'Wong');
    ln.dispatchEvent(new Event('input', {bubbles:true}));
    ln.dispatchEvent(new Event('change', {bubbles:true}));
    nativeInputValueSetter.call(fn, 'Daniel');
    fn.dispatchEvent(new Event('input', {bubbles:true}));
    fn.dispatchEvent(new Event('change', {bubbles:true}));
    return 'OK: ' + ln.value + '/' + fn.value;
})()
""")
    print(f"  Names: {r}")
    
    # Step 2: Check c-wiz shadow DOM structure for birthday/gender
    print("\n=== SHADOW DOM INSPECTION ===")
    r = await cdp_eval(ws, cid, """
(() => {
    const wiz = document.querySelectorAll('c-wiz');
    let info = [];
    for(let i=0; i<wiz.length; i++){
        const sr = wiz[i].shadowRoot;
        if(!sr){ info.push(i+':NO_SHADOW'); continue; }
        const inputs = sr.querySelectorAll('input');
        const selects = sr.querySelectorAll('select');
        const radios = sr.querySelectorAll('input[type=radio]');
        const labels = sr.querySelectorAll('label');
        let details = [];
        for(const inp of inputs){
            details.push(inp.type+':'+(inp.name||inp.id||inp.getAttribute('aria-label')||'?'));
        }
        info.push(i+':inputs='+inputs.length+' selects='+selects.length+' radios='+radios.length+' details=['+details.join(',')+']');
    }
    return info.join('\\n');
})()
""")
    print(r)
    
    # Step 3: Get positions of form elements for coordinate clicking
    print("\n=== ELEMENT POSITIONS ===")
    r = await cdp_eval(ws, cid, """
(() => {
    const wiz = document.querySelectorAll('c-wiz');
    let positions = [];
    for(let w=0; w<wiz.length; w++){
        const sr = wiz[w].shadowRoot;
        if(!sr) continue;
        // Year input
        const yearInp = sr.querySelector('input[aria-label*="出生"], input[name*="year"], input[type=text]');
        // Month select
        const monthSel = sr.querySelector('select, [role=combobox], [role=listbox]');
        // Day input
        const dayInp = sr.querySelectorAll('input[type=text]');
        // Radio buttons for gender
        const radios = sr.querySelectorAll('input[type=radio]');
        // All inputs with positions
        const allInputs = sr.querySelectorAll('input, select, [role=combobox]');
        for(const el of allInputs){
            const rect = el.getBoundingClientRect();
            if(rect.width > 0 && rect.height > 0){
                positions.push({tag:el.tagName, type:el.type||el.getAttribute('role')||'', name:el.name||el.getAttribute('aria-label')||el.id||'', 
                    x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2), w:Math.round(rect.width), h:Math.round(rect.height)});
            }
        }
    }
    return JSON.stringify(positions);
})()
""")
    print("Positions:", r)
    
    await ws.close()

asyncio.run(main())
