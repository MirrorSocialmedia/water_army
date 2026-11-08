#!/usr/bin/env python3
"""gen40 STEP2: Fill birthday+gender+username+password, submit"""
import asyncio, json, os, subprocess, sys
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"

# Load password from secrets
with open("/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json") as f:
    SECRET = json.load(f)
PW = SECRET.get("password", SECRET.get("pw", ""))
assert len(PW) >= 8, f"Password too short: {len(PW)}"

class CDP:
    def __init__(self, url):
        self.url = url; self.ws=None; self.cid=0
    
    async def connect(self):
        self.ws = await websockets.connect(self.url, max_size=15*1024*1024)
        await self.send("Runtime.enable")
        await self.send("Page.enable")
    
    async def send(self, method, params=None):
        self.cid += 1
        cmd = {"id":self.cid, "method":method}
        if params: cmd["params"]=params
        await self.ws.send(json.dumps(cmd))
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=20)
            r = json.loads(raw)
            if r.get("id")==self.cid: return r.get("result",{})
    
    async def eval(self, expr, timeout=10):
        self.cid += 1
        cmd = {"id":self.cid, "method":"Runtime.evaluate", "params":{"expression":expr,"returnByValue":True}}
        await self.ws.send(json.dumps(cmd))
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
            r = json.loads(raw)
            if r.get("id")==self.cid:
                return r.get("result",{}).get("result",{}).get("value", r.get("result",{}).get("result",{}))
    
    async def click(self, x, y):
        await self.send("Input.dispatchMouseEvent",{"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1})
        await self.send("Input.dispatchMouseEvent",{"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1})
    
    async def close(self):
        if self.ws: await self.ws.close()

def screencap(name):
    path = f"{EVIDENCE}/{name}"
    subprocess.run([ADB,"-s",DEV,"shell","screencap","-p","/data/local/tmp/tmpcap.png"], check=True, capture_output=True)
    subprocess.run([ADB,"-s",DEV,"pull","/data/local/tmp/tmpcap.png",path], check=True, capture_output=True)
    sz = os.path.getsize(path) if os.path.exists(path) else 0
    print(f"  [cap:{name}] {sz}B")

async def main():
    cdp = CDP(WS_URL)
    await cdp.connect()
    
    # Ensure birthday c-wiz is visible
    await cdp.eval("""(() => {
        const day = document.querySelector('input[name=day]');
        if(!day) return 'no day';
        const wiz = day.closest('c-wiz');
        if(wiz) wiz.style.display = 'block';
        const ln = document.querySelector('input[name=lastName]');
        if(ln) { const nw = ln.closest('c-wiz'); if(nw) nw.style.display='none'; }
    })()""")
    
    # 1. Fill year and day
    print("=== FILL YEAR/DAY ===")
    r = await cdp.eval("""(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        const day = document.querySelector('input[name=day]');
        const year = document.querySelector('input[name=year]');
        if(!day||!year) return 'MISSING';
        setter.call(day, '14');
        day.dispatchEvent(new Event('input',{bubbles:true}));
        day.dispatchEvent(new Event('change',{bubbles:true}));
        setter.call(year, '1991');
        year.dispatchEvent(new Event('input',{bubbles:true}));
        year.dispatchEvent(new Event('change',{bubbles:true}));
        return 'day='+day.value+' year='+year.value;
    })()""")
    print(f"  {r}")
    
    # 2. Month - find it and check what it is
    print("\n=== MONTH ===")
    r = await cdp.eval("""(() => {
        // Check for month select/combobox inside the birthday c-wiz
        const day = document.querySelector('input[name=day]');
        const wiz = day.closest('c-wiz');
        const selects = wiz.querySelectorAll('select');
        const combos = wiz.querySelectorAll('[role=combobox]');
        // Also check for any element with month text
        let allEls = wiz.querySelectorAll('*');
        let monthEl = null;
        for(const el of allEls){
            if(el.getAttribute('aria-label')&&el.getAttribute('aria-label').includes('月')){monthEl=el;break;}
            if(el.tagName==='SELECT'){monthEl=el;break;}
        }
        // Try sibling structure
        const parent = day.parentElement;
        const sibs = parent.parentElement.children;
        let sibInfo = [];
        for(const s of sibs) sibInfo.push(s.tagName+'.'+((s.className||'')+'').substring(0,15)+' h='+s.offsetHeight);
        return JSON.stringify({selects:selects.length, combos:combos.length, month:monthEl?(monthEl.tagName+':'+monthEl.getAttribute('aria-label')):'?', parent_sibs:sibInfo.join('|')});
    })()""")
    print(f"  {r}")
    
    # Check if there's a <select> with months inside
    r = await cdp.eval("""(() => {
        const wiz = document.querySelector('input[name=day]').closest('c-wiz');
        const selects = wiz.querySelectorAll('select');
        let info = [];
        for(const s of selects){
            const opts = s.options;
            let optsText = [];
            for(let i=0;i<Math.min(opts.length,5);i++) optsText.push(opts[i].value+':'+opts[i].text);
            info.push('select id='+s.id+' name='+s.name+' val='+s.value+' options='+opts.length+' first=['+optsText.join(',')+']');
        }
        return info.join('\\n') || 'NO SELECTS';
    })()""")
    print(f"  SELECTS: {r}")
    
    # Check for hidden/role-based month
    r = await cdp.eval("""(() => {
        const wiz = document.querySelector('input[name=day]').closest('c-wiz');
        // Look for anything containing "月" text
        const walker = document.createTreeWalker(wiz, NodeFilter.SHOW_ELEMENT);
        let hits = [];
        while(walker.nextNode()){
            const el = walker.currentNode;
            if(el.getAttribute('aria-label') && el.getAttribute('aria-label').includes('月')){
                const rect = el.getBoundingClientRect();
                hits.push({tag:el.tagName, label:el.getAttribute('aria-label'), role:el.getAttribute('role'), x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2), visible:rect.height>0});
            }
        }
        return JSON.stringify(hits);
    })()""")
    print(f"  MONTH elements: {r}")
    
    # 3. Gender - look inside the c-wiz
    print("\n=== GENDER ===")
    r = await cdp.eval("""(() => {
        const wiz = document.querySelector('input[name=day]').closest('c-wiz');
        // Check for radio group / gender
        const radios = wiz.querySelectorAll('input[type=radio], [role=radio]');
        let out = [];
        for(const r of radios){
            const rect = r.getBoundingClientRect();
            out.push({tag:r.tagName, value:r.value||r.textContent, label:r.getAttribute('aria-label'), checked:r.checked, x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2)});
        }
        // Also check for div[role=radio] with gender labels
        const genderInput = document.querySelector('input[aria-label*="性别"]');
        if(genderInput){
            const rect = genderInput.getBoundingClientRect();
            out.push({tag:genderInput.tagName, label:genderInput.getAttribute('aria-label'), x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2), type:genderInput.type});
        }
        return JSON.stringify(out);
    })()""")
    print(f"  {r}")
    
    # 4. Check 繼續 button on birthday step
    print("\n=== CONTINUE BTN ===")
    r = await cdp.eval("""(() => {
        const btns = document.querySelectorAll('button, [role=button]');
        let out = [];
        for(const b of btns){
            const rect = b.getBoundingClientRect();
            if(rect.height > 0 && b.textContent.trim()){
                out.push({text:b.textContent.trim().substring(0,20), x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2)});
            }
        }
        return JSON.stringify(out);
    })()""")
    print(f"  {r}")
    
    await cdp.close()

asyncio.run(main())
