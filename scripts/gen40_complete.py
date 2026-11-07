#!/usr/bin/env python3
"""gen40 COMPLETE: Fill birthday → username → password → submit"""
import asyncio, json, os, subprocess, urllib.request
import websockets

ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
PW = json.load(open("/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json")).get("password","")

targets = json.loads(urllib.request.urlopen("http://127.0.0.1:19222/json/list").read())
WS = targets[0]["webSocketDebuggerUrl"]

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
    async def press(k,kc):
        await send('Input.dispatchKeyEvent',{'type':'keyDown','key':k,'code':'','windowsVirtualKeyCode':kc,'nativeVirtualKeyCode':kc})
        await send('Input.dispatchKeyEvent',{'type':'keyUp','key':k,'code':'','windowsVirtualKeyCode':kc,'nativeVirtualKeyCode':kc})
    async def click(x,y):
        await send('Input.dispatchMouseEvent',{'type':'mousePressed','x':x,'y':y,'button':'left','clickCount':1,'buttons':1})
        await send('Input.dispatchMouseEvent',{'type':'mouseReleased','x':x,'y':y,'button':'left','clickCount':1,'buttons':0})
    async def cdp_click_button(text):
        """Focus button with text, press Enter (trusted keyboard activation)"""
        await ev(f"(function(){{var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++){{if(b[i].textContent.trim()==='{text}'&&b[i].getBoundingClientRect().height>0){{b[i].focus();return 1}}}}return 0}})()")
        await asyncio.sleep(0.3)
        await press('Enter', 13)
    async def cdp_click_pos(x, y):
        """CDP mouse click + Enter keyboard"""
        await click(x, y)

    await send('Runtime.enable')
    await send('Page.enable')

    # === STEP: BIRTHDAY (already reached, fill fields) ===
    print("=== BIRTHDAY FILL ===")
    # Fill day/year
    r = await ev("(function(){var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;var d=document.querySelector('input[name=day]');var y=document.querySelector('input[name=year]');if(!d||!y)return 'MISSING';s.call(d,'14');d.dispatchEvent(new Event('input',{bubbles:true}));d.dispatchEvent(new Event('change',{bubbles:true}));s.call(y,'1991');y.dispatchEvent(new Event('input',{bubbles:true}));y.dispatchEvent(new Event('change',{bubbles:true}));return 'd='+d.value+' y='+y.value})()")
    print(f"  {r}")
    
    # Month: focus combobox → ArrowDown (opens) → ArrowDown x2 (navigate) → Enter
    await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if(cbs[i].textContent.trim()==='月'){cbs[i].focus();return 1}}return 0})()")
    await press('ArrowDown',40); await asyncio.sleep(0.3)
    await press('ArrowDown',40); await asyncio.sleep(0.1)
    await press('ArrowDown',40); await asyncio.sleep(0.1)
    # Focus 3月 option + Enter
    await ev("(function(){var o=document.querySelectorAll('[role=option]');for(var i=0;i<o.length;i++){if(o[i].textContent.trim()==='3 月'&&o[i].getBoundingClientRect().height>0){o[i].focus();return 1}}return 0})()")
    await press('Enter',13); await asyncio.sleep(0.5)
    r = await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){var t=cbs[i].textContent.trim();if(t.includes('月')&&t.length<10)return t}return '?'})()")
    print(f"  Month: {r}")
    
    # Gender: focus combobox → ArrowDown → focus 男 → Enter
    await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if(cbs[i].textContent.trim()==='性別'){cbs[i].focus();return 1}}return 0})()")
    await press('ArrowDown',40); await asyncio.sleep(0.3)
    await ev("(function(){var o=document.querySelectorAll('[role=option]');for(var i=0;i<o.length;i++){if(o[i].textContent.trim()==='男'&&o[i].getBoundingClientRect().height>0){o[i].focus();return 1}}return 0})()")
    await press('Enter',13); await asyncio.sleep(0.5)
    r = await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){var t=cbs[i].textContent.trim();if(t==='男'||t==='性別男')return 'GENDER='+t}return '?'})()")
    print(f"  {r}")
    
    screencap("s7-s40-02-birthday-filled.png")
    
    # === CLICK 繼續 (birthday) ===
    print("\n=== BIRTHDAY → CONTINUE ===")
    # Try CDP click first
    btn = await ev("(function(){var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++){if(b[i].textContent.trim()==='繼續'){var r=b[i].getBoundingClientRect();if(r.height>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}}return null})()")
    if isinstance(btn,str) and btn.startswith('{'):
        btn = json.loads(btn)
    print(f"  CTA: {btn}")
    if btn:
        await click(btn['x'], btn['y'])
        await asyncio.sleep(5)
    path = await ev('location.pathname')
    print(f"  Path: {path}")
    
    if 'birthday' in str(path):
        # Try focus+Enter
        await cdp_click_button("繼續")
        await asyncio.sleep(5)
        path = await ev('location.pathname')
        print(f"  After keyboard: {path}")
    
    if 'birthday' in str(path):
        print("  STILL STUCK on birthday step! Checking...")
        print(f"  Title: {await ev('document.title')}")
        # Try form element submit
        print(f"  Form submit attempt: {await ev('(function(){var f=document.querySelector(\"input[name=day]\").closest(\"form\");return f?f.submit()+\" YES\":\"NO FORM\"})()')}")
        await asyncio.sleep(5)
        path = await ev('location.pathname')
        print(f"  Path: {path}")
    
    # === USERNAME ===
    if 'username' in str(path) or 'choose' in str(path):
        print(f"\n=== USERNAME ===")
        r = await ev("""(function(){var inp=document.querySelector('input[name=fixedEmail],input[type=email]');if(!inp){var all=document.querySelectorAll('input');for(var i=0;i<all.length;i++){var r=all[i].getBoundingClientRect();if(r.height>0&&all[i].type==='text'&&r.y>100){inp=all[i];break;}}}if(!inp)return 'NO INPUT';var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(inp,'danielrowe7144');inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));return 'SET:'+inp.value})()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        btn = await ev("(function(){var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++){if(b[i].textContent.trim()==='繼續'){var r=b[i].getBoundingClientRect();if(r.height>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}}return null})()")
        if isinstance(btn,str) and btn.startswith('{'): btn=json.loads(btn)
        if btn:
            await click(btn['x'], btn['y'])
            await asyncio.sleep(5)
            path = await ev('location.pathname')
            if 'username' in str(path):
                await click(btn['x'], btn['y'])
                await asyncio.sleep(5)
                path = await ev('location.pathname')
            print(f"  Path: {path}")
    
    # === PASSWORD ===
    if 'password' in str(path):
        print(f"\n=== PASSWORD ===")
        r = await ev(f"""(function(){{var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;var all=document.querySelectorAll('input[type=password]');for(var i=0;i<all.length;i++){{s.call(all[i],'{PW}');all[i].dispatchEvent(new Event('input',{{bubbles:true}}));all[i].dispatchEvent(new Event('change',{{bubbles:true}}));}}return 'SET count='+all.length}})()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        btn = await ev("(function(){var b=document.querySelectorAll('button');for(var i=0;i<b.length;i++){if(b[i].textContent.trim()==='繼續'){var r=b[i].getBoundingClientRect();if(r.height>0)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}}return null})()")
        if isinstance(btn,str) and btn.startswith('{'): btn=json.loads(btn)
        if btn:
            await click(btn['x'], btn['y'])
            await asyncio.sleep(8)
            path = await ev('location.pathname')
            if 'password' in str(path):
                await click(btn['x'], btn['y'])
                await asyncio.sleep(8)
                path = await ev('location.pathname')
            print(f"  Path: {path}")
    
    # === 5-MINUTE PATIENCE WINDOW ===
    print(f"\n=== POST-SUBMIT: {path} ===")
    for minute in range(5):
        await asyncio.sleep(60)
        path = await ev('location.pathname')
        title = await ev('document.title')
        body = await ev('document.body.innerText.substring(0,150)')
        print(f"  [{minute+1}min] {path} | {title}")
        print(f"    Body: {body[:100]}")
        screencap(f"s7-s40-03-pat{minute+1}.png")
        # Check for 429
        if '429' in str(body) or 'too many' in str(body).lower():
            print("  *** 429 DETECTED ***")
            break
        # Check for phone screen
        if '驗證' in str(body) or '電話' in str(body) or 'phone' in str(body).lower():
            print("  *** PHONE SCREEN ***")
            break
        # Check for success/welcome
        if '歡迎' in str(body) or 'welcome' in str(body).lower() or 'MyAccount' in str(path):
            print("  *** SUCCESS/WELCOME ***")
            break
    
    # Final
    print(f"\n=== FINAL STATE ===")
    print(f"  Path: {await ev('location.pathname')}")
    print(f"  Title: {await ev('document.title')}")
    screencap("s7-s40-final.png")
    
    await ws.close()

asyncio.run(main())
