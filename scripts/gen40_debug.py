#!/usr/bin/env python3
"""gen40: Debug name step CTA - check network + console"""
import asyncio, json, urllib.request, websockets, subprocess
import websockets

ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"

targets = json.loads(urllib.request.urlopen("http://127.0.0.1:19222/json/list").read())
WS = targets[0]["webSocketDebuggerUrl"]

async def main():
    ws = await websockets.connect(WS, max_size=15*1024*1024)
    cid=[0]
    async def send(method,params=None):
        cid[0]+=1
        cmd={'id':cid[0],'method':method}
        if params:cmd['params']=params
        await ws.send(json.dumps(cmd))
        while True:
            raw=await asyncio.wait_for(ws.recv(),15)
            r=json.loads(raw)
            if r.get('id')==cid[0]: return r.get('result',{})
    async def ev(expr):
        cid[0]+=1
        await ws.send(json.dumps({'id':cid[0],'method':'Runtime.evaluate','params':{'expression':expr,'returnByValue':True,'timeout':5000}}))
        while True:
            raw=await asyncio.wait_for(ws.recv(),10)
            r=json.loads(raw)
            if r.get('id')==cid[0]: return r.get('result',{}).get('result',{}).get('value', r.get('result',{}).get('result',{}))
    async def press(k,kc):
        await send('Input.dispatchKeyEvent',{'type':'keyDown','key':k,'code':'','windowsVirtualKeyCode':kc,'nativeVirtualKeyCode':kc})
        await send('Input.dispatchKeyEvent',{'type':'keyUp','key':k,'code':'','windowsVirtualKeyCode':kc,'nativeVirtualKeyCode':kc})

    # Enable Network + Console domains to monitor
    await send('Network.enable')
    await send('Runtime.enable')
    
    # Collect console events
    console_msgs = []
    async def collect_events(duration=10):
        try:
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=duration)
                msg = json.loads(raw)
                method = msg.get('method','')
                if 'Console.messageAdded' in method or 'Runtime.consoleAPICalled' in method:
                    console_msgs.append(msg)
                elif 'Network.requestWillBeSent' in method:
                    url = msg.get('params',{}).get('request',{}).get('url','')
                    print(f"  NET REQ: {url[:80]}")
                elif 'Network.responseReceived' in method:
                    st = msg.get('params',{}).get('response',{}).get('status',0)
                    url = msg.get('params',{}).get('response',{}).get('url','')[:60]
                    print(f"  NET RES: {st} {url}")
        except asyncio.TimeoutError:
            pass
    
    # First, try to fill + click and monitor network
    print("=== Fill name + click (monitoring) ===")
    r = await ev("""(function(){
        var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        var ln=document.querySelector('input[name=lastName]');
        var fn=document.querySelector('input[name=firstName]');
        if(!ln||!fn)return 'MISSING';
        setter.call(ln,'Wong');ln.dispatchEvent(new Event('input',{bubbles:true}));ln.dispatchEvent(new Event('change',{bubbles:true}));
        setter.call(fn,'Daniel');fn.dispatchEvent(new Event('input',{bubbles:true}));fn.dispatchEvent(new Event('change',{bubbles:true}));
        return ln.value+'/'+fn.value;
    })()""")
    print(f"  Names: {r}")
    
    # Focus button + Enter
    await ev("(function(){var btns=document.querySelectorAll('button');for(var i=0;i<btns.length;i++){if(btns[i].textContent.trim()==='繼續'){btns[i].focus();return 1}}return 0})()")
    await asyncio.sleep(0.3)
    
    # Press Enter
    await press('Enter', 13)
    print("  Enter pressed. Monitoring network...")
    
    # Collect events for 10 seconds
    await collect_events(10)
    
    # Check path
    path = await ev('location.pathname')
    print(f"  Path: {path}")
    print(f"  Console msgs: {len(console_msgs)}")
    
    # Also check: is the page in a "loading" state?
    print(f"  Title: {await ev('document.title')}")
    
    # Check logcat for errors
    result = subprocess.run([ADB, "-s", DEV, "shell", "logcat", "-d", "-t", "20", "-s", "chromium:E"], capture_output=True, text=True)
    if result.stdout.strip():
        print(f"\n  Chromium errors:\n{result.stdout[-500:]}")
    
    await ws.close()

asyncio.run(main())
