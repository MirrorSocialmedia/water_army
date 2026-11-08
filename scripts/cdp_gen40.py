#!/usr/bin/env python3
"""CDP session for gen40 registration"""
import asyncio, json, base64, sys, os
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"

class CDP:
    def __init__(self, url):
        self.url = url
        self.ws = None
        self.cid = 0
    
    async def connect(self):
        self.ws = await websockets.connect(self.url, max_size=15*1024*1024)
        await self.send("Runtime.enable")
        await self.send("Page.enable")
    
    async def send(self, method, params=None):
        self.cid += 1
        cmd = {"id": self.cid, "method": method}
        if params:
            cmd["params"] = params
        await self.ws.send(json.dumps(cmd))
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=30)
            r = json.loads(raw)
            if r.get("id") == self.cid:
                return r.get("result", {})
    
    async def eval(self, expr, awaitPromise=False):
        r = await self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": awaitPromise
        })
        res = r.get("result", {})
        return res.get("value", None)
    
    async def screencap(self, name):
        """Use adb screencap (CDP captureScreenshot broken on A14 webview)"""
        import subprocess
        path = f"{EVIDENCE}/{name}"
        subprocess.run(["adb", "-s", "127.0.0.1:16701", "shell", "screencap", "-p", "/data/local/tmp/tmpcap.png"], check=True, capture_output=True)
        subprocess.run(["adb", "-s", "127.0.0.1:16701", "pull", "/data/local/tmp/tmpcap.png", path], check=True, capture_output=True)
        sz = os.path.getsize(path) if os.path.exists(path) else 0
        print(f"  screencap: {name} ({sz} bytes)")
        return path
    
    async def close(self):
        if self.ws:
            await self.ws.close()

async def main():
    cdp = CDP(WS_URL)
    await cdp.connect()
    
    # Check iframes
    result = await cdp.eval("""(() => {
        const iframes = document.querySelectorAll('iframe');
        let info = [];
        for(let i=0;i<iframes.length;i++){
            try{
                let doc=iframes[i].contentDocument;
                let inputs=doc?doc.querySelectorAll('input').length:'null';
                info.push(i+':inputs='+inputs+' src='+iframes[i].src.substring(0,80));
            }catch(e){info.push(i+':CROSS:'+iframes[i].src.substring(0,60));}
        }
        return info.join('\\n');
    })()""")
    print("Iframes:", result)
    
    # Also check the main document's inputs and c-wiz
    result = await cdp.eval("""(() => {
        let inputs = document.querySelectorAll('input');
        let types = [];
        for(const inp of inputs) types.push(inp.type+':'+(inp.id||inp.name||inp.getAttribute('aria-label')||'?'));
        let cwiz = document.querySelectorAll('c-wiz');
        return 'main inputs: '+types.join(', ')+' | c-wiz: '+cwiz.length;
    })()""")
    print("Main:", result)
    
    await cdp.close()

asyncio.run(main())
