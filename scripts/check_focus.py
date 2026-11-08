#!/usr/bin/env python3
import asyncio,json,websockets,urllib.request,subprocess,os
ADB="/home/kenneth/.local/share/platform-tools/adb"
D="127.0.0.1:16701"

# First: tap at CSS(206,218) with offset 257
subprocess.run([ADB,"-s",D,"shell","input","tap","540","828"],capture_output=True)
import time; time.sleep(1)

async def go():
    targets=json.loads(urllib.request.urlopen("http://127.0.0.1:19222/json/list").read())
    ws=await websockets.connect(targets[0]["webSocketDebuggerUrl"],max_size=15*1024*1024)
    cid=[0]
    async def ev(expr):
        cid[0]+=1
        await ws.send(json.dumps({"id":cid[0],"method":"Runtime.evaluate","params":{"expression":expr,"returnByValue":True,"timeout":5000}}))
        while True:
            raw=await asyncio.wait_for(ws.recv(),5)
            r=json.loads(raw)
            if r.get("id")==cid[0]: return r.get("result",{}).get("result",{}).get("value","?")
    await ev("1")
    
    print("Focus:", await ev("document.activeElement.tagName+':'+document.activeElement.name"))
    print("LastName:", await ev("(function(){var el=document.querySelector('input[name=lastName]');var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),h:Math.round(r.height)})})()"))
    print("CTA:", await ev("(function(){var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++){if(b[i].textContent.trim()==='繼續'){var r=b[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}}return '?'})()"))
    
    # Try tapping with different offset values
    SCALE=2.621
    for offset in [200, 220, 240, 260, 280, 300]:
        # Tap lastName center at CSS (206,244) 
        dy = int(244*SCALE + offset)
        subprocess.run([ADB,"-s",D,"shell","input","tap","540",str(dy)],capture_output=True)
        await asyncio.sleep(0.5)
        f = await ev("document.activeElement.name")
        if 'lastName' in str(f):
            print(f"  ✓ OFFSET={offset} WORKS (device y={dy})")
            break
        # Dismiss potential keyboard
        subprocess.run([ADB,"-s",D,"shell","input","keyevent","111"],capture_output=True)  # KEYCODE_ESCAPE equivalent
        await asyncio.sleep(0.3)
    
    await ws.close()
asyncio.run(go())
