#!/usr/bin/env python3
"""CDP helper for webview_shell registration - WA-STEALTH7 gen40"""
import asyncio, json, base64, sys, os
import websockets

class CDP:
    def __init__(self, ws_url):
        self.ws_url = ws_url
        self.ws = None
        self.counter = 0
    
    async def connect(self):
        self.ws = await websockets.connect(self.ws_url, max_size=15*1024*1024)
        await self.send("Runtime.enable")
        await self.send("Page.enable")
        await self.send("DOM.enable")
    
    async def send(self, method, params=None):
        self.counter += 1
        cmd = {"id": self.counter, "method": method}
        if params:
            cmd["params"] = params
        await self.ws.send(json.dumps(cmd))
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=30)
            r = json.loads(raw)
            if r.get("id") == self.counter:
                if "error" in r:
                    print(f"  CDP ERROR {method}: {r['error']}", file=sys.stderr)
                return r.get("result", {})
            # events are silently consumed
    
    async def eval(self, expression, returnByValue=True, awaitPromise=False):
        r = await self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": returnByValue,
            "awaitPromise": awaitPromise
        })
        if "result" in r:
            res = r["result"]
            if isinstance(res, dict) and "value" in res:
                return res["value"]
            return res
        return None
    
    async def screenshot(self, path):
        r = await self.send("Page.captureScreenshot", {"format": "png"})
        data = r.get("data", "")
        if data:
            with open(path, "wb") as f:
                f.write(base64.b64decode(data))
            print(f"  Saved: {path} ({os.path.getsize(path)} bytes)")
        else:
            print(f"  Screenshot: NO DATA", file=sys.stderr)
        return data
    
    async def click(self, x, y):
        """Click at CDP page coordinates"""
        await self.send("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": x, "y": y,
            "button": "left", "clickCount": 1
        })
        await self.send("Input.dispatchMouseEvent", {
            "type": "mouseReleased", "x": x, "y": y,
            "button": "left", "clickCount": 1
        })
    
    async def close(self):
        if self.ws:
            await self.ws.close()

async def main():
    cdp = CDP("ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD")
    await cdp.connect()
    
    # Screenshot initial state
    await cdp.screenshot("/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence/s7-s40-01-initial.png")
    
    # Check what's on the page - form structure
    result = await cdp.eval("""
    (() => {
        const inputs = document.querySelectorAll('input[type=text], input[type=email], input[type=password], input:not([type])');
        const shadow = document.querySelectorAll('c-wiz');
        return `inputs: ${inputs.length}, c-wiz: ${shadow.length}, title: ${document.title}, url: ${location.href.split('?')[0]}`;
    })()
    """)
    print(f"Page state: {result}")
    
    await cdp.close()

if __name__ == "__main__":
    asyncio.run(main())
