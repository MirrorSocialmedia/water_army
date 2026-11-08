#!/usr/bin/env python3
"""gen40: Open month/gender dropdowns, select values, then continue"""
import asyncio, json, os, subprocess
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"

class CDP:
    def __init__(self, url):
        self.url=url; self.ws=None; self.cid=0
    async def connect(self):
        self.ws = await websockets.connect(self.url, max_size=15*1024*1024)
        await self.send("Runtime.enable"); await self.send("Page.enable")
    async def send(self, method, params=None):
        self.cid+=1
        cmd={"id":self.cid,"method":method}
        if params:cmd["params"]=params
        await self.ws.send(json.dumps(cmd))
        while True:
            raw=await asyncio.wait_for(self.ws.recv(),timeout=20)
            r=json.loads(raw)
            if r.get("id")==self.cid: return r.get("result",{})
    async def eval(self, expr):
        self.cid+=1
        await self.ws.send(json.dumps({"id":self.cid,"method":"Runtime.evaluate","params":{"expression":expr,"returnByValue":True}}))
        while True:
            raw=await asyncio.wait_for(self.ws.recv(),timeout=15)
            r=json.loads(raw)
            if r.get("id")==self.cid: return r.get("result",{}).get("result",{}).get("value","ERR")
    async def click(self, x, y):
        await self.send("Input.dispatchMouseEvent",{"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1})
        await self.send("Input.dispatchMouseEvent",{"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1})
    async def close(self):
        if self.ws: await self.ws.close()

def screencap(name):
    path=f"{EVIDENCE}/{name}"
    subprocess.run([ADB,"-s",DEV,"shell","screencap","-p","/data/local/tmp/tmpcap.png"],check=True,capture_output=True)
    subprocess.run([ADB,"-s",DEV,"pull","/data/local/tmp/tmpcap.png",path],check=True,capture_output=True)
    print(f"  [cap:{name}] {os.path.getsize(path) if os.path.exists(path) else 0}B")

async def main():
    cdp = CDP(WS_URL)
    await cdp.connect()
    
    # === MONTH: click combobox at (206,244) to expand ===
    print("=== OPEN MONTH ===")
    await cdp.click(206, 244)
    await asyncio.sleep(1)
    
    # Check expanded state
    r = await cdp.eval("""(() => {
        const wiz = document.querySelector('input[name=day]').closest('c-wiz');
        const combos = wiz.querySelectorAll('[role=combobox]');
        for(const c of combos){
            if(c.textContent.includes('月')){
                return 'month expanded=' + c.getAttribute('aria-expanded');
            }
        }
        return 'not found';
    })()""")
    print(f"  {r}")
    
    # Find the "3 月" option
    r = await cdp.eval("""(() => {
        const opts = document.querySelectorAll('[role=option]');
        let found = null;
        for(const o of opts){
            const t = o.textContent.trim();
            if(t === '3 月' || t === '3月' || t === '3'){
                const rect = o.getBoundingClientRect();
                if(rect.height > 0) found = {text:t, x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2)};
                break;
            }
        }
        return JSON.stringify(found);
    })()""")
    print(f"  3月 option: {r}")
    
    if r and 'ERR' not in str(r):
        opt = json.loads(r) if isinstance(r, str) else r
        if opt and isinstance(opt, dict):
            print(f"  Clicking 3月 at ({opt['x']},{opt['y']})")
            await cdp.click(opt['x'], opt['y'])
            await asyncio.sleep(0.5)
    
    # Verify month selected
    r = await cdp.eval("""(() => {
        const wiz = document.querySelector('input[name=day]').closest('c-wiz');
        const combos = wiz.querySelectorAll('[role=combobox]');
        for(const c of combos){
            const label = c.getAttribute('aria-label')||'';
            if(label.includes('月')||c.textContent.includes('月')) return 'month now: '+c.textContent.trim().substring(0,10);
        }
        return '?';
    })()""")
    print(f"  {r}")
    
    # === GENDER: click combobox at (206,316) to expand ===
    print("\n=== OPEN GENDER ===")
    await cdp.click(206, 316)
    await asyncio.sleep(1)
    
    # Check expanded
    r = await cdp.eval("""(() => {
        const wiz = document.querySelector('input[name=day]').closest('c-wiz');
        const combos = wiz.querySelectorAll('[role=combobox]');
        for(const c of combos){
            const label = c.getAttribute('aria-label')||c.textContent;
            if(label.includes('性別')) return 'gender expanded='+c.getAttribute('aria-expanded')+' text='+c.textContent.substring(0,15);
        }
        return 'not found';
    })()""")
    print(f"  {r}")
    
    # Find "男" option
    r = await cdp.eval("""(() => {
        const opts = document.querySelectorAll('[role=option]');
        let found = null;
        for(const o of opts){
            const t = o.textContent.trim();
            if(t === '男'){
                const rect = o.getBoundingClientRect();
                if(rect.height > 0) found = {text:t, x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2)};
                break;
            }
        }
        if(!found){
            for(const o of opts){
                const rect = o.getBoundingClientRect();
                if(rect.height > 0) {
                    if(!found) found = {text:o.textContent.trim(), x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2)};
                }
            }
        }
        return JSON.stringify(found);
    })()""")
    print(f"  男 option: {r}")
    
    if r and 'ERR' not in str(r):
        opt = json.loads(r) if isinstance(r, str) else r
        if opt and isinstance(opt, dict):
            print(f"  Clicking 男 at ({opt['x']},{opt['y']})")
            await cdp.click(opt['x'], opt['y'])
            await asyncio.sleep(0.5)
    
    # Verify
    r = await cdp.eval("""(() => {
        const wiz = document.querySelector('input[name=day]').closest('c-wiz');
        const combos = wiz.querySelectorAll('[role=combobox]');
        for(const c of combos){
            if(c.getAttribute('aria-label')||'' === '性別' || c.textContent.includes('男')) return 'gender='+c.textContent.trim().substring(0,10);
        }
        return '?';
    })()""")
    print(f"  {r}")
    
    # === FINAL STATE ===
    print("\n=== FINAL BIRTHDAY STATE ===")
    r = await cdp.eval("""(() => {
        return JSON.stringify({
            day: document.querySelector('input[name=day]')?.value,
            year: document.querySelector('input[name=year]')?.value,
            url: location.pathname,
            text: document.body.innerText.substring(0,200)
        });
    })()""")
    print(f"  {r}")
    
    screencap("s7-s40-03-birthday-filled.png")
    await cdp.close()

asyncio.run(main())
