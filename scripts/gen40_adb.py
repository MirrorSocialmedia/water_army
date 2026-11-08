#!/usr/bin/env python3
"""gen40: Calibrated adb tap full flow"""
import asyncio, json, os, subprocess, urllib.request
import websockets

ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
SECRETS = "/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json"
PW = json.load(open(SECRETS)).get("password","")

targets = json.loads(urllib.request.urlopen("http://127.0.0.1:19222/json/list").read())
WS = targets[0]["webSocketDebuggerUrl"]

def adb_tap(x, y):
    subprocess.run([ADB,"-s",DEV,"shell","input","tap",str(x),str(y)], capture_output=True)

def screencap(name):
    path=f"{EVIDENCE}/{name}"
    subprocess.run([ADB,"-s",DEV,"shell","screencap","-p","/data/local/tmp/tmpcap.png"],check=True,capture_output=True)
    subprocess.run([ADB,"-s",DEV,"pull","/data/local/tmp/tmpcap.png",path],check=True,capture_output=True)
    sz = os.path.getsize(path)
    print(f"  [cap:{name}] {sz}B")
    return sz

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
    
    # Calibrate tap offset: get viewport size and content offset
    vp = await ev("JSON.stringify({w:innerWidth,h:innerHeight})")
    vps = json.loads(vp) if isinstance(vp,str) else vp
    VW, VH = vps['w'], vps['h']
    DW, DH = 1080, 2400  # device screen
    SCALE = DW / VW
    # Content offset: status bar + webview address bar
    # Let's determine empirically: we know lastName is at CSS y=218
    # Try tapping at CSS (206, 244) which is the lastName input center
    # Device coord = (206*SCALE, 244*SCALE + OFFSET)
    # We need to find OFFSET. Test: tap at (CSS_x*SCALE, CSS_y*SCALE) WITHOUT offset first
    print(f"Viewport: {VW}x{VH}, Scale: {SCALE:.3f}")
    
    # Empirical calibration: tap lastName
    css_lx, css_ly = 206, 244  # lastName center
    device_x = int(css_lx * SCALE)
    
    for offset in range(200, 500, 20):
        device_y = int(css_ly * SCALE) + offset
        adb_tap(device_x, device_y)
        await asyncio.sleep(0.7)
        focus = await ev("document.activeElement.name||document.activeElement.tagName")
        if 'lastName' in str(focus):
            print(f"  ✓ TAP CALIBRATED: offset={offset} (lastName focused)")
            OFFSET = offset
            break
        # Dismiss keyboard if it appears
        adb_tap(540, 2300)  # tap far bottom to dismiss
        await asyncio.sleep(0.3)
    else:
        print(f"  OFFSET NOT FOUND. Last focus: {focus}")
        OFFSET = 320  # default guess
    
    await asyncio.sleep(1)
    # Dismiss keyboard
    adb_tap(540, 2390)
    await asyncio.sleep(0.5)
    
    # === FULL FLOW ===
    async def tap_css(css_x, css_y, wait=1.0):
        """Tap at CSS coordinates via adb"""
        adb_tap(int(css_x * SCALE), int(css_y * SCALE) + OFFSET)
        await asyncio.sleep(wait)
    
    async def get_path():
        return await ev('location.pathname')
    
    async def get_rect(selector, text=None):
        """Get CSS center of element"""
        expr = f"""(function(){{
            var els=document.querySelectorAll('{selector}');
            for(var i=0;i<els.length;i++){{
                {'if(!els[i].textContent.includes("'+text+'"))continue;' if text else ''}
                var r=els[i].getBoundingClientRect();
                if(r.height>0) return JSON.stringify({{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}});
            }}
            return null;
        }})()"""
        r = await ev(expr)
        return json.loads(r) if isinstance(r,str) and r.startswith('{') else r
    
    async def fill_input(selector, value):
        r = await ev(f"""(function(){{
            var inp=document.querySelector('{selector}');
            if(!inp)return 'MISSING';
            var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(inp,'{value}');
            inp.dispatchEvent(new Event('input',{{bubbles:true}}));
            inp.dispatchEvent(new Event('change',{{bubbles:true}}));
            return 'SET:'+inp.value;
        }})()""")
        return r

    # === STEP 1: Name ===
    print("\n=== NAME STEP ===")
    r = await fill_input('input[name=lastName]', 'Wong')
    print(f"  {r}")
    r = await fill_input('input[name=firstName]', 'Daniel')
    print(f"  {r}")
    
    # Tap 繼續 button
    btn = await get_rect('button', '繼續')
    print(f"  CTA: {btn}")
    if btn:
        await tap_css(btn['x'], btn['y'], 3)
        path = await get_path()
        print(f"  Path after tap: {path}")
        
        if 'name' in str(path):
            # Second tap
            print("  2nd tap...")
            btn = await get_rect('button', '繼續')
            if btn:
                await tap_css(btn['x'], btn['y'], 5)
            path = await get_path()
            print(f"  Path: {path}")
    
    if 'birthday' not in str(path):
        print(f"  FAILED to reach birthday. Path={path}")
        screencap("s7-s40-fail-name.png")
        await ws.close()
        return
    
    # === STEP 2: Birthday ===
    print("\n=== BIRTHDAY STEP ===")
    # Fill day + year
    r = await fill_input('input[name=day]', '14')
    print(f"  Day: {r}")
    r = await fill_input('input[name=year]', '1991')
    print(f"  Year: {r}")
    
    # Month: tap combobox → wait → tap option "3 月"
    cb = await get_rect('[role=combobox]', '月')
    print(f"  Month combobox: {cb}")
    if cb:
        await tap_css(cb['x'], cb['y'], 1.5)
        # Find "3 月" option
        opt = await get_rect('[role=option]', '3 月')
        print(f"  3月 option: {opt}")
        if opt:
            await tap_css(opt['x'], opt['y'], 1)
    
    # Gender: tap combobox → tap "男"
    cb = await get_rect('[role=combobox]', '性別')
    print(f"  Gender combobox: {cb}")
    if cb:
        await tap_css(cb['x'], cb['y'], 1.5)
        opt = await get_rect('[role=option]', '男')
        print(f"  男 option: {opt}")
        if opt:
            await tap_css(opt['x'], opt['y'], 1)
    
    # Verify
    print(f"  State: {await ev('JSON.stringify({d:document.querySelector(\"input[name=day]\").value,y:document.querySelector(\"input[name=year]\").value})')}")
    
    # Tap 繼續
    btn = await get_rect('button', '繼續')
    print(f"  CTA: {btn}")
    if btn:
        await tap_css(btn['x'], btn['y'], 5)
        path = await get_path()
        print(f"  Path: {path}")
        if 'birthday' in str(path):
            await tap_css(btn['x'], btn['y'], 5)
            path = await get_path()
            print(f"  After 2nd: {path}")
    
    # === STEP 3: Username ===
    if 'username' in str(path) or 'choose' in str(path):
        print("\n=== USERNAME ===")
        # Find input
        inp_sel = 'input[name=fixedEmail],input[type=email]'
        r = await ev(f"""(function(){{
            var inp=document.querySelector('{inp_sel}');
            if(!inp){{var all=document.querySelectorAll('input');for(var i=0;i<all.length;i++){{var r=all[i].getBoundingClientRect();if(r.height>0&&all[i].type==='text'&&r.y>100){{inp=all[i];break;}}}}}}
            if(!inp)return 'NO INPUT';
            var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(inp,'danielrowe7144');
            inp.dispatchEvent(new Event('input',{{bubbles:true}}));inp.dispatchEvent(new Event('change',{{bubbles:true}}));
            return 'SET:'+inp.value;
        }})()""")
        print(f"  {r}")
        btn = await get_rect('button', '繼續')
        if btn:
            await tap_css(btn['x'], btn['y'], 5)
            path = await get_path()
            if 'username' in str(path):
                await tap_css(btn['x'], btn['y'], 5)
                path = await get_path()
            print(f"  Path: {path}")
    
    # === STEP 4: Password ===
    if 'password' in str(path):
        print("\n=== PASSWORD ===")
        r = await ev(f"""(function(){{
            var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            var all=document.querySelectorAll('input[type=password]');
            for(var i=0;i<all.length;i++){{setter.call(all[i],'{PW}');all[i].dispatchEvent(new Event('input',{{bubbles:true}}));all[i].dispatchEvent(new Event('change',{{bubbles:true}}));}}
            return 'SET count='+all.length;
        }})()""")
        print(f"  {r}")
        btn = await get_rect('button', '繼續')
        if btn:
            await tap_css(btn['x'], btn['y'], 8)
            path = await get_path()
            if 'password' in str(path):
                await tap_css(btn['x'], btn['y'], 8)
                path = await get_path()
            print(f"  Path: {path}")
    
    # === FINAL ===
    print(f"\n=== FINAL: {path} ===")
    print(f"  Title: {await ev('document.title')}")
    body = await ev('document.body.innerText.substring(0,200)')
    print(f"  Body: {body[:150]}")
    screencap("s7-s40-04-submit.png")
    
    await ws.close()

asyncio.run(main())
