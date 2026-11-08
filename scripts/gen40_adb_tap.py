#!/usr/bin/env python3
"""gen40: Use adb input tap (trusted Android events) for all clicks"""
import asyncio, json, os, subprocess, urllib.request
import websockets

ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
SECRETS = "/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json"

with open(SECRETS) as f:
    SECRET = json.load(f)
PW = SECRET.get("password", SECRET.get("pw", ""))

targets = json.loads(urllib.request.urlopen("http://127.0.0.1:19222/json/list").read())
WS = targets[0]["webSocketDebuggerUrl"]

def adb_cmd(args):
    return subprocess.run([ADB,"-s",DEV,"shell"] + args, capture_output=True, text=True).stdout.strip()

def screencap(name):
    path=f"{EVIDENCE}/{name}"
    subprocess.run([ADB,"-s",DEV,"shell","screencap","-p","/data/local/tmp/tmpcap.png"],check=True,capture_output=True)
    subprocess.run([ADB,"-s",DEV,"pull","/data/local/tmp/tmpcap.png",path],check=True,capture_output=True)
    print(f"  [cap:{name}] {os.path.getsize(path)}B")

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

    await send('Runtime.enable')
    await send('Page.enable')

    async def get_path():
        return await ev('location.pathname')
    
    async def wait_path(kw, max_wait=15):
        for _ in range(max_wait):
            await asyncio.sleep(1)
            p = await get_path()
            if kw in str(p): return p
        return await get_path()
    
    async def wait_leave(not_kw, max_wait=15):
        for _ in range(max_wait):
            await asyncio.sleep(1)
            p = await get_path()
            if not_kw not in str(p): return p
        return await get_path()
    
    async def get_element_rect(selector, text_contains=None):
        """Get viewport CSS coordinates of an element"""
        r = await ev(f"""(function(){{
            var els=document.querySelectorAll('{selector}');
            for(var i=0;i<els.length;i++){{
                {'if(!els[i].textContent.includes("'+text_contains+'"))continue;' if text_contains else ''}
                var rect=els[i].getBoundingClientRect();
                if(rect.height>0) return JSON.stringify({{x:rect.x+rect.width/2, y:rect.y+rect.height/2, w:rect.width, h:rect.height}});
            }}
            return null;
        }})()""")
        return r
    
    async def adb_tap(css_x, css_y):
        """Tap using adb input tap (converts CSS px to screen px)"""
        # Get device screen info and webview offset
        # webview_shell: status bar ~0, address bar ~50px on device
        # CSS viewport: 412x770; device: 1080x2400
        # Scale factor: 1080/412 = 2.621
        # webview content starts below address bar
        # Need to determine offset - check webview position
        scale = 1080.0 / 412.0
        # The webview content area starts below the address bar (~48dp) and status bar (~24dp)
        # In device px: address bar bottom ≈ (24+48)*1080/412 = ~188px from top
        # Actually, need to measure: the webview content area starts at a fixed offset
        # From screenshots, content starts at approximately y=100 in CSS coords = y=262 device px
        # Let me calibrate: status bar (24dp) + address bar (48dp) = 72dp ≈ 188 device px
        offset_y = 188  # device px offset from top to webview content
        device_x = int(css_x * scale)
        device_y = int(css_y * scale) + offset_y
        adb_cmd(["input", "tap", str(device_x), str(device_y)])
        return device_x, device_y
    
    # Calibrate: check webview position
    print("=== CALIBRATION ===")
    # Get window frame from dumpsys (webview content area start)
    win = adb_cmd(["dumpsys", "window", "|", "grep", "-A5", "Window #1"])
    # Alternative: check webview content top via CDP
    # Use getBoundingClientRect of the webview container
    content_top = await ev("""(function(){
        var ln=document.querySelector('input[name=lastName]');
        if(ln) return ln.getBoundingClientRect().y + ':' + ln.getBoundingClientRect().height;
        return 'no input';
    })()""")
    print(f"  lastName rect: {content_top}")
    
    # Get device screen size
    wm = adb_cmd(["wm", "size"])
    print(f"  Screen: {wm}")
    
    # The webview starts below address bar. For webview_shell:
    # Address bar height is fixed. Let's determine from a known element position.
    # CDP viewport: 412x770 (CSS px)
    # Screen: 1080x2400 (device px)
    # Scale: 2.621x
    # CDP (0,0) maps to device (0, webview_top)
    # webview_top = screen_height - status_bar - address_bar - navigation_bar - viewport_height * scale
    # Let's calculate: 2400 - (status bar ~60) - (address bar ~130) - nav bar? - 770*2.621 ≈ ?
    # 770*2.621 = 2018 → 2400-2018 = 382 for all chrome + status bar
    # So webview content starts at ~382 device px from top (or similar)
    
    # More accurate: use adb shell dumpsys activity windows to find webview bounds
    # Actually, let's just test empirically: tap at known location and verify
    print("\n=== TAP TEST: firstName input ===")
    # firstName at y=298 CSS, let's try tapping there
    # With offset = 382: device_y = 298*2.621 + 382 ≈ 1163
    fx_rect = await ev("(function(){var el=document.querySelector('input[name=firstName]');var r=el.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()")
    fx = json.loads(fx_rect) if isinstance(fx_rect, str) and fx_rect.startswith('{') else fx_rect
    print(f"  firstName CSS: {fx}")
    
    # Try tap on lastName (at CSS y=218)
    ln_rect = await ev("(function(){var el=document.querySelector('input[name=lastName]');var r=el.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()")
    ln = json.loads(ln_rect) if isinstance(ln_rect, str) and ln_rect.startswith('{') else ln_rect
    
    # Calculate offset: Try to figure out where to tap by testing
    # Known: lastName at CSS (206, 218), width=360, height=52
    # If we tap at correct screen position, keyboard should appear / field focused
    # Let's try multiple offsets and see which triggers focus
    
    scale = 1080.0 / 412.0
    css_x = ln['x']
    css_y = ln['y']
    device_x = int(css_x * scale)
    
    # Try offset=382
    offset = 382
    device_y = int(css_y * scale) + offset
    print(f"  Tap ({device_x},{device_y}) → checking focus...")
    adb_cmd(["input", "tap", str(device_x), str(device_y)])
    await asyncio.sleep(1)
    focus = await ev("document.activeElement.tagName+':'+document.activeElement.name")
    print(f"  Focus: {focus}")
    
    if 'lastName' not in str(focus):
        # Adjust offset
        for off_test in [320, 340, 360, 400, 420]:
            device_y = int(css_y * scale) + off_test
            adb_cmd(["input", "tap", str(device_x), str(device_y)])
            await asyncio.sleep(0.8)
            focus = await ev("document.activeElement.tagName+':'+document.activeElement.name")
            print(f"  offset={off_test} y={device_y} → {focus}")
            if 'lastName' in str(focus):
                offset = off_test
                print(f"  ✓ OFFSET={offset}")
                break
    
    await ws.close()

asyncio.run(main())
