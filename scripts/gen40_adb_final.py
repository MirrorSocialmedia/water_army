#!/usr/bin/env python3
"""gen40 FINAL: Full registration with correct adb tap offset (126)"""
import asyncio, json, os, subprocess, urllib.request, time
import websockets

ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
PW = json.load(open("/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json")).get("password","")
SCALE = 2.621
OFFSET = 126  # WebView top from dumpsys

targets = json.loads(urllib.request.urlopen("http://127.0.0.1:19222/json/list").read())
WS = targets[0]["webSocketDebuggerUrl"]

def adb_tap(css_x, css_y):
    dx = int(css_x * SCALE)
    dy = int(css_y * SCALE) + OFFSET
    subprocess.run([ADB,"-s",DEV,"shell","input","tap",str(dx),str(dy)], capture_output=True)
    print(f"  tap CSS({css_x:.0f},{css_y:.0f})→dev({dx},{dy})")

def adb_screencap(name):
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
    async def get_rect(selector, text=None):
        t_filter = f"if(!els[i].textContent.includes('{text}'))continue;" if text else ""
        expr = f"""(function(){{var els=document.querySelectorAll('{selector}');for(var i=0;i<els.length;i++){{{t_filter}var r=els[i].getBoundingClientRect();if(r.height>0)return JSON.stringify({{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})}}return null}})()"""
        r = await ev(expr)
        return json.loads(r) if isinstance(r,str) and r.startswith('{') else r
    
    async def fill(selector, value):
        r = await ev(f"""(function(){{var inp=document.querySelector('{selector}');if(!inp)return 'MISSING';var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(inp,'{value}');inp.dispatchEvent(new Event('input',{{bubbles:true}}));inp.dispatchEvent(new Event('change',{{bubbles:true}}));return 'SET:'+inp.value}})()""")
        return r

    # === CALIBRATION: tap lastName ===
    print("=== CALIBRATION ===")
    adb_tap(206, 244)  # lastName center
    await asyncio.sleep(1)
    focus = await ev("document.activeElement.name||document.activeElement.tagName")
    print(f"  Focus after tap: {focus}")
    if 'lastName' not in str(focus):
        print("  Calibration FAILED!")
        # Try offset 140
        subprocess.run([ADB,"-s",DEV,"shell","input","tap","540","718"], capture_output=True)  # 244*2.621+140=780
        await asyncio.sleep(0.7)
        focus = await ev("document.activeElement.name||document.activeElement.tagName")
        print(f"  Try 780: {focus}")
        if 'lastName' not in str(focus):
            print("  ABORT: adb tap cannot focus webview elements")
            await ws.close()
            return
    
    # === STEP 1: Name ===
    print("\n=== STEP 1: NAME ===")
    print(f"  {await fill('input[name=lastName]', 'Wong')}")
    print(f"  {await fill('input[name=firstName]', 'Daniel')}")
    
    # Tap 繼續
    btn = await get_rect('button', '繼續')
    print(f"  CTA: {btn}")
    if btn:
        adb_tap(btn['x'], btn['y'])
        await asyncio.sleep(3)
        # First tap might be no-op; check
        p = await get_path()
        print(f"  Path: {p}")
        if 'name' in str(p):
            # Wait more (Glif hydration)
            await asyncio.sleep(3)
            p = await get_path()
            print(f"  After wait: {p}")
        if 'name' in str(p):
            # Second tap
            btn = await get_rect('button', '繼續')
            if btn: adb_tap(btn['x'], btn['y'])
            await asyncio.sleep(5)
        p = await get_path()
        print(f"  Path: {p}")
    
    # === STEP 2: Birthday ===
    if 'birthday' in str(p):
        print("\n=== STEP 2: BIRTHDAY ===")
        # Fill day/year
        print(f"  {await fill('input[name=day]', '14')}")
        print(f"  {await fill('input[name=year]', '1991')}")
        
        # Month: tap combobox to open
        cb = await get_rect('[role=combobox]', '月')
        print(f"  Month CB: {cb}")
        if cb:
            adb_tap(cb['x'], cb['y'])
            await asyncio.sleep(1.5)
            # Tap "3 月" option
            opt = await get_rect('[role=option]', '3 月')
            print(f"  3月: {opt}")
            if opt:
                adb_tap(opt['x'], opt['y'])
                await asyncio.sleep(0.5)
        
        # Gender: tap combobox
        cb = await get_rect('[role=combobox]', '性別')
        print(f"  Gender CB: {cb}")
        if cb:
            adb_tap(cb['x'], cb['y'])
            await asyncio.sleep(1.5)
            opt = await get_rect('[role=option]', '男')
            print(f"  男: {opt}")
            if opt:
                adb_tap(opt['x'], opt['y'])
                await asyncio.sleep(0.5)
        
        # Verify state
        r = await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');var out=[];for(var i=0;i<cbs.length;i++){var t=cbs[i].textContent.trim();if(t.length<12)out.push(t)}return out.join(' | ')})()")
        print(f"  State: {r}")
        
        # Tap 繼續
        btn = await get_rect('button', '繼續')
        print(f"  CTA: {btn}")
        if btn:
            adb_tap(btn['x'], btn['y'])
            await asyncio.sleep(5)
            p = await get_path()
            print(f"  Path: {p}")
            if 'birthday' in str(p):
                adb_tap(btn['x'], btn['y'])
                await asyncio.sleep(5)
                p = await get_path()
                print(f"  After 2nd: {p}")
    
    # === STEP 3: Username ===
    if 'username' in str(p) or 'choose' in str(p):
        print("\n=== STEP 3: USERNAME ===")
        r = await ev("""(function(){var inp=document.querySelector('input[name=fixedEmail],input[type=email]');if(!inp){var all=document.querySelectorAll('input');for(var i=0;i<all.length;i++){var r=all[i].getBoundingClientRect();if(r.height>0&&all[i].type==='text'&&r.y>100){inp=all[i];break;}}}if(!inp)return 'NO INPUT';var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(inp,'danielrowe7144');inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));return 'SET:'+inp.value})()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        btn = await get_rect('button', '繼續')
        if btn:
            adb_tap(btn['x'], btn['y'])
            await asyncio.sleep(5)
            p = await get_path()
            if 'username' in str(p):
                adb_tap(btn['x'], btn['y']); await asyncio.sleep(5)
                p = await get_path()
            print(f"  Path: {p}")
    
    # === STEP 4: Password ===
    if 'password' in str(p):
        print("\n=== STEP 4: PASSWORD ===")
        r = await ev(f"""(function(){{var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;var all=document.querySelectorAll('input[type=password]');for(var i=0;i<all.length;i++){{s.call(all[i],'{PW}');all[i].dispatchEvent(new Event('input',{{bubbles:true}}));all[i].dispatchEvent(new Event('change',{{bubbles:true}}));}}return 'SET count='+all.length}})()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        btn = await get_rect('button', '繼續')
        if btn:
            adb_tap(btn['x'], btn['y'])
            await asyncio.sleep(8)
            p = await get_path()
            if 'password' in str(p):
                adb_tap(btn['x'], btn['y'])
                await asyncio.sleep(8)
                p = await get_path()
            print(f"  Path: {p}")
    
    # === FINAL ===
    print(f"\n=== FINAL: {p} ===")
    print(f"  Title: {await ev('document.title')}")
    body = await ev('document.body.innerText.substring(0,200)')
    print(f"  Body: {body[:150]}")
    adb_screencap("s7-s40-04-final.png")
    
    await ws.close()

asyncio.run(main())
