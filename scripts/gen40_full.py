#!/usr/bin/env python3
"""gen40 FULL: Complete registration in one pass"""
import asyncio, json, os, subprocess, time
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"
SECRETS = "/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json"

with open(SECRETS) as f:
    SECRET = json.load(f)
PW = SECRET.get("password", SECRET.get("pw", ""))

# Get current WS target
import urllib.request
targets = json.loads(urllib.request.urlopen("http://127.0.0.1:19222/json/list").read())
WS = targets[0]["webSocketDebuggerUrl"]
print(f"WS: {WS}")

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

    async def wait_page(pred_kw, max_wait=20):
        for _ in range(max_wait):
            await asyncio.sleep(1)
            path = await ev('location.pathname')
            if pred_kw in str(path): return path
        return await ev('location.pathname')

    async def wait_page_change(not_kw, max_wait=20):
        for _ in range(max_wait):
            await asyncio.sleep(1)
            path = await ev('location.pathname')
            if not_kw not in str(path): return path
        return await ev('location.pathname')

    async def click_cta():
        """Focus CTA button and press Enter"""
        await ev("(function(){var btns=document.querySelectorAll('button');for(var i=0;i<btns.length;i++){if(btns[i].textContent.trim().match(/^(繼續|創建帳戶|下一步)$/)&&btns[i].getBoundingClientRect().height>0){btns[i].focus();return 1}}return 0})()")
        await asyncio.sleep(0.2)
        await press('Enter', 13)

    def screencap(name):
        path=f"{EVIDENCE}/{name}"
        subprocess.run([ADB,"-s",DEV,"shell","screencap","-p","/data/local/tmp/tmpcap.png"],check=True,capture_output=True)
        subprocess.run([ADB,"-s",DEV,"pull","/data/local/tmp/tmpcap.png",path],check=True,capture_output=True)
        print(f"  [cap:{name}] {os.path.getsize(path)}B")

    await send('Runtime.enable')
    await send('Page.enable')

    # === STEP 1: Wait for page load ===
    print("\n=== STEP 1: Waiting for name step ===")
    path = await wait_page('name', 15)
    print(f"  Path: {path}")
    
    # Fill name
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
    screencap("s7-s40-01-name-filled.png")
    
    # Click 繼續
    await click_cta()
    await asyncio.sleep(2)
    # Check if it worked (may need second click)
    path = await ev('location.pathname')
    if 'name' in str(path):
        print("  2nd click...")
        await click_cta()
        await asyncio.sleep(5)
    path = await wait_page('birthdaygender', 10)
    print(f"  At: {path}")
    
    # === STEP 2: Birthday/Gender ===
    print("\n=== STEP 2: Birthday/Gender ===")
    # Wait for form fields to be VISIBLE (not display:none)
    print("  Checking visibility...")
    for attempt in range(10):
        vis = await ev("""(function(){
            var day=document.querySelector('input[name=day]');
            if(!day) return 'no day input';
            var wiz=day.closest('c-wiz');
            var h=wiz?wiz.offsetHeight:0;
            var display=wiz?getComputedStyle(wiz).display:'?';
            return 'wiz_h='+h+' display='+display+' day_visible='+(day.getBoundingClientRect().height>0);
        })()""")
        print(f"  [{attempt}] {vis}")
        if 'day_visible=True' in str(vis):
            break
        if attempt == 5:
            # Force display:block if still hidden after 5s
            print("  Forcing display:block...")
            await ev("""(function(){
                var day=document.querySelector('input[name=day]');
                if(day){var w=day.closest('c-wiz');if(w){w.style.display='block';}}
                var ln=document.querySelector('input[name=lastName]');
                if(ln){var w=ln.closest('c-wiz');if(w)w.style.display='none';}
            })()""")
        await asyncio.sleep(1)
    
    # Check c-wiz display state (is the birthday form naturally visible or forced?)
    init_state = await ev("(function(){var d=document.querySelector('input[name=day]');var w=d.closest('c-wiz');return 'wiz_display='+getComputedStyle(w).display+' h='+w.offsetHeight+' forced='+w.style.display})()")
    print(f"  c-wiz: {init_state}")
    
    # Fill day and year
    r = await ev("""(function(){
        var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        var day=document.querySelector('input[name=day]');
        var year=document.querySelector('input[name=year]');
        if(!day||!year)return 'MISSING';
        setter.call(day,'14');day.dispatchEvent(new Event('input',{bubbles:true}));day.dispatchEvent(new Event('change',{bubbles:true}));
        setter.call(year,'1991');year.dispatchEvent(new Event('input',{bubbles:true}));year.dispatchEvent(new Event('change',{bubbles:true}));
        return 'day='+day.value+' year='+year.value;
    })()""")
    print(f"  Day/Year: {r}")
    
    # Month: focus combobox → ArrowDown → ArrowDown x2 → focus "3 月" → Enter
    print("  Month...")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){if(cbs[i].textContent.trim()==='月'){cbs[i].focus();return 'ok';}}
        return 'FAIL';
    })()""")
    await press('ArrowDown', 40); await asyncio.sleep(0.3)
    # Navigate to 3月: ArrowDown x2 (from first option)
    await press('ArrowDown', 40); await asyncio.sleep(0.1)
    await press('ArrowDown', 40); await asyncio.sleep(0.1)
    # Focus 3月 option directly
    await ev("""(function(){
        var opts=document.querySelectorAll('[role=option]');
        for(var i=0;i<opts.length;i++){if(opts[i].textContent.trim()==='3 月'&&opts[i].getBoundingClientRect().height>0){opts[i].focus();return 1}}
        return 0;
    })()""")
    await press('Enter', 13); await asyncio.sleep(0.5)
    
    # Verify
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){var t=cbs[i].textContent.trim();if(t.includes('月')&&t.length<10)return t;}
        return '?';
    })()""")
    print(f"  Month: {r}")
    
    # Gender: focus → ArrowDown → focus "男" → Enter
    print("  Gender...")
    await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if(cbs[i].textContent.trim()==='性別'){cbs[i].focus();return 1}}return 0})()")
    await press('ArrowDown', 40); await asyncio.sleep(0.3)
    await ev("""(function(){
        var opts=document.querySelectorAll('[role=option]');
        for(var i=0;i<opts.length;i++){if(opts[i].textContent.trim()==='男'&&opts[i].getBoundingClientRect().height>0){opts[i].focus();return 1}}
        return 0;
    })()""")
    await press('Enter', 13); await asyncio.sleep(0.5)
    
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){var t=cbs[i].textContent.trim();if(t==='男'||t==='性別男')return t;}
        return '?';
    })()""")
    print(f"  Gender: {r}")
    
    screencap("s7-s40-02-birthday-filled.png")
    
    # === STEP 3: Click 繼續 (birthday) ===
    print("\n=== STEP 3: Birthday → Continue ===")
    await click_cta()
    await asyncio.sleep(3)
    path = await ev('location.pathname')
    print(f"  Path after click: {path}")
    
    if 'birthday' in str(path):
        print("  Retry CTA...")
        await click_cta()
        await asyncio.sleep(3)
        path = await ev('location.pathname')
        print(f"  After retry: {path}")
    
    if 'birthday' in str(path):
        # Last resort: dispatch trusted click via CDP at correct coords
        print("  CDP mouse click...")
        r = await ev("""(function(){
            var btns=document.querySelectorAll('button');
            for(var i=0;i<btns.length;i++){
                if(btns[i].textContent.trim()==='繼續'){
                    var rect=btns[i].getBoundingClientRect();
                    if(rect.height>0) return JSON.stringify({x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
                }
            }
            return null;
        })()""")
        if r and isinstance(r,dict):
            await send('Input.dispatchMouseEvent',{'type':'mousePressed','x':r['x'],'y':r['y'],'button':'left','clickCount':1,'buttons':1})
            await send('Input.dispatchMouseEvent',{'type':'mouseReleased','x':r['x'],'y':r['y'],'button':'left','clickCount':1,'buttons':0})
            await asyncio.sleep(5)
            path = await ev('location.pathname')
            print(f"  After CDP click: {path}")
    
    # === STEP 4: Username ===
    if 'username' in str(path) or 'choose' in str(path):
        print(f"\n=== STEP 4: Username ===")
        r = await ev("""(function(){
            var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            var inp=document.querySelector('input[type=email],input[name=fixedEmail]');
            if(!inp){var all=document.querySelectorAll('input');for(var i=0;i<all.length;i++){if(all[i].type==='text'&&all[i].getBoundingClientRect().height>0&&all[i].getBoundingClientRect().y>100){inp=all[i];break;}}}
            if(!inp)return 'NO INPUT';
            setter.call(inp,'danielrowe7144');
            inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));
            return 'SET:'+inp.value;
        })()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        await click_cta()
        await asyncio.sleep(3)
        path = await wait_page_change('username', 10)
        if 'username' in str(path):
            await click_cta(); await asyncio.sleep(5)
            path = await ev('location.pathname')
        print(f"  Path: {path}")
    
    # === STEP 5: Password ===
    if 'password' in str(path):
        print(f"\n=== STEP 5: Password ===")
        r = await ev(f"""(function(){{
            var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            var inp=document.querySelector('input[type=password]');
            if(!inp)return 'NO PW';
            setter.call(inp,'{PW}');
            inp.dispatchEvent(new Event('input',{{bubbles:true}}));inp.dispatchEvent(new Event('change',{{bubbles:true}}));
            var all=document.querySelectorAll('input[type=password]');
            if(all.length>1){{setter.call(all[1],'{PW}');all[1].dispatchEvent(new Event('input',{{bubbles:true}}));all[1].dispatchEvent(new Event('change',{{bubbles:true}}));}}
            return 'SET count='+all.length;
        }})()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        await click_cta()
        await asyncio.sleep(5)
        path = await ev('location.pathname')
        if 'password' in str(path):
            await click_cta(); await asyncio.sleep(5)
            path = await ev('location.pathname')
        print(f"  Path: {path}")
    
    # === FINAL ===
    print(f"\n=== FINAL: {path} ===")
    print(f"  Title: {await ev('document.title')}")
    body = await ev('document.body.innerText.substring(0,200)')
    print(f"  Body: {body[:150]}")
    screencap("s7-s40-03-final.png")
    
    await ws.close()

asyncio.run(main())
