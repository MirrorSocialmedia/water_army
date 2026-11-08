#!/usr/bin/env python3
"""gen40: Click continue through remaining steps to submit"""
import asyncio, json, os, subprocess
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"
SECRETS = "/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json"

with open(SECRETS) as f:
    SECRET = json.load(f)
PW = SECRET.get("password", SECRET.get("pw", ""))
USERNAME = "danielrowe7144"

async def main():
    ws = await websockets.connect(WS_URL, max_size=15*1024*1024)
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

    async def find_and_click_cta():
        """Find and click the primary CTA button (繼續/創建帳戶/etc)"""
        r = await ev("""(function(){
            var btns=document.querySelectorAll('button,[role=button]');
            for(var i=0;i<btns.length;i++){
                var t=btns[i].textContent.trim();
                if(t==='繼續'||t==='創建帳戶'||t==='創建'||t==='下一步'){
                    var rect=btns[i].getBoundingClientRect();
                    if(rect.height>0) return JSON.stringify({text:t,x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
                }
            }
            // Broader search
            for(var i=0;i<btns.length;i++){
                var t=btns[i].textContent.trim();
                if(t.includes('繼續')||t.includes('創建')){
                    var rect=btns[i].getBoundingClientRect();
                    if(rect.height>0) return JSON.stringify({text:t.substring(0,20),x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
                }
            }
            return null;
        })()""")
        if isinstance(r,dict):
            print(f"  CTA '{r['text']}' at ({r['x']},{r['y']})")
            await click(r['x'], r['y'])
            return True
        return False

    # === Birthday → Continue ===
    print("=== BIRTHDAY → CONTINUE ===")
    if await find_and_click_cta():
        await asyncio.sleep(4)
        pathname = await ev('location.pathname')
        print(f"  Now: {pathname}")
        # If still on birthday (silent no-op), second click
        if 'birthday' in str(pathname):
            print("  Silent no-op! Second click...")
            if await find_and_click_cta():
                await asyncio.sleep(4)
                print(f"  Now: {await ev('location.pathname')}")
    
    # === USERNAME STEP ===
    pathname = await ev('location.pathname')
    print(f"\n=== AT: {pathname} ===")
    print(f"  TITLE: {await ev('document.title')}")
    print(f"  BODY: {await ev('document.body.innerText.substring(0,300)')}")
    
    if 'username' in str(pathname) or 'choose' in str(pathname):
        print("\n=== FILL USERNAME ===")
        r = await ev(f"""(function(){{
            var inp = document.querySelector('input[type=email], input[name=fixedEmail], input[name=email], input[aria-label*="用户名"], input[aria-label*="用戶名"]');
            if(!inp) {{
                // Try all visible inputs
                var inps = document.querySelectorAll('input');
                for(var i=0;i<inps.length;i++){{
                    var r=inps[i].getBoundingClientRect();
                    if(r.height>0 && r.y>100) return 'input found: type='+inps[i].type+' name='+inps[i].name+' y='+Math.round(r.y);
                }}
                return 'NO INPUT FOUND';
            }}
            var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(inp, '{USERNAME}');
            inp.dispatchEvent(new Event('input',{{bubbles:true}}));
            inp.dispatchEvent(new Event('change',{{bubbles:true}}));
            return 'SET: '+inp.value+' type='+inp.type;
        }})()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        
        # Continue
        print("\n=== USERNAME → CONTINUE ===")
        if await find_and_click_cta():
            await asyncio.sleep(4)
            print(f"  Now: {await ev('location.pathname')} | {await ev('document.title')}")
            pathname = await ev('location.pathname')
    
    # === PASSWORD STEP ===
    if 'password' in str(pathname):
        print("\n=== FILL PASSWORD ===")
        r = await ev(f"""(function(){{
            var inp = document.querySelector('input[type=password], input[name=Passwd], input[aria-label*="密碼"]');
            if(!inp) return 'NO PW INPUT';
            var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(inp, '{PW}');
            inp.dispatchEvent(new Event('input',{{bubbles:true}}));
            inp.dispatchEvent(new Event('change',{{bubbles:true}}));
            // Also fill confirm if exists
            var confirm = document.querySelectorAll('input[type=password]');
            if(confirm.length > 1){{
                setter.call(confirm[1], '{PW}');
                confirm[1].dispatchEvent(new Event('input',{{bubbles:true}}));
                confirm[1].dispatchEvent(new Event('change',{{bubbles:true}}));
            }}
            return 'SET pw len='+inp.value.length+' inputs='+confirm.length;
        }})()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        
        print("\n=== PASSWORD → SUBMIT ===")
        if await find_and_click_cta():
            await asyncio.sleep(5)
            print(f"  Now: {await ev('location.pathname')} | {await ev('document.title')}")
            pathname = await ev('location.pathname')
    
    # === FINAL STATE ===
    print(f"\n=== FINAL: {await ev('location.pathname')} ===")
    print(f"  TITLE: {await ev('document.title')}")
    print(f"  BODY: {await ev('document.body.innerText.substring(0,300)')}")
    
    # Screencap
    subprocess.run([ADB,"-s",DEV,"shell","screencap","-p","/data/local/tmp/tmpcap.png"],check=True,capture_output=True)
    subprocess.run([ADB,"-s",DEV,"pull","/data/local/tmp/tmpcap.png",f"{EVIDENCE}/s7-s40-04-progress.png"],check=True,capture_output=True)
    print(f"\n  Screencap saved")
    
    await ws.close()

asyncio.run(main())
