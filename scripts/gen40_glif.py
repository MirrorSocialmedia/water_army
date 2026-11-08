#!/usr/bin/env python3
"""gen40: Find Glif framework submit function"""
import asyncio, json, os, subprocess, urllib.request
import websockets

ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"

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
    
    await send('Runtime.enable')
    await send('Page.enable')

    # Check current state
    print("Current:", await ev("location.pathname + '|' + document.title"))
    print("LastName:", await ev("(function(){var el=document.querySelector('input[name=lastName]');return el?el.value+':h='+el.getBoundingClientRect().height:'no input'})()"))
    
    # Search for Glif framework globals
    print("\nGLIF GLOBALS:")
    print(await ev("""(function(){
        var keys=Object.getOwnPropertyNames(window).filter(function(k){return k.indexOf('glif')>=0||k.indexOf('Glif')>=0||k.indexOf('signup')>=0||k.indexOf('step')>=0||k.indexOf('Step')>=0;});
        return keys.join(', ') || 'NONE';
    })()"""))
    
    # Check for jsaction API
    print("\nJSACTION:", await ev("""(function(){
        if(window.jsaction) return Object.keys(window.jsaction).join(',');
        if(window._jsaction) return Object.keys(window._jsaction).join(',');
        // Check for installed instances
        var scripts=document.querySelectorAll('script[src]');
        var srcs=[];for(var i=0;i<scripts.length;i++)srcs.push(scripts[i].src.substring(0,50));
        return 'no global jsaction; '+scripts.length+' scripts: '+srcs.slice(0,5).join(',');
    })()"""))
    
    # Check what happens when we simulate the framework's click delegation
    print("\nFRAMEWORK DETAIL:")
    print(await ev("""(function(){
        // jsaction stores handlers in a registry
        // The click handler is cOuCgd (from jsaction=click:cOuCgd)
        // Let's find where jsaction stores its handlers
        var root=document.querySelector('[jsaction-container],[jspriority]');
        var container=document.querySelector('.A77ntc');
        var bodyJsAction=document.body.getAttribute('jsaction')||'';
        return 'bodyJsAction='+bodyJsAction.substring(0,50)+'; container='+container;
    })()"""))
    
    # Let me try to figure out the correct adb tap position
    # By getting WebView bounds from the view hierarchy
    print("\nWEBVIEW BOUNDS:")
    import subprocess
    # Get view hierarchy
    r = subprocess.run([ADB,"-s",DEV,"shell","dumpsys","activity","top","--dump-view-hierarchy"], capture_output=True, text=True, timeout=5)
    lines = r.stdout.split('\n')
    for line in lines:
        if 'WebView' in line or 'webview' in line.lower():
            print(f"  {line.strip()[:120]}")
    
    await ws.close()

asyncio.run(main())
