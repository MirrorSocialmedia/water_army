#!/usr/bin/env python3
"""gen40: Button click via focus+Enter, full flow to submit"""
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

    async def focus_and_enter_button(text):
        """Focus button containing text, press Enter"""
        r = await ev(f"""(function(){{
            var btns=document.querySelectorAll('button,[role=button]');
            for(var i=0;i<btns.length;i++){{
                if(btns[i].textContent.includes('{text}')&&btns[i].getBoundingClientRect().height>0){{
                    btns[i].focus();
                    return 'focused:'+btns[i].tagName+'.'+((btns[i].className||'')+'').substring(0,20)+' active='+document.activeElement.tagName;
                }}
            }}
            return 'NOT FOUND';
        }})()""")
        if 'focused' in str(r):
            await press('Enter',13)
            return True
        return False

    # === STEP 1: birthday 繼續 ===
    print("=== BIRTHDAY: 繼續 (focus+Enter) ===")
    ok = await focus_and_enter_button("繼續")
    print(f"  {ok}")
    await asyncio.sleep(5)
    path = await ev('location.pathname')
    print(f"  Path: {path}")
    
    if 'birthday' in str(path):
        # CDP click approach
        print("  CDP click at (350,449)...")
        await click(350, 449)
        await asyncio.sleep(5)
        path = await ev('location.pathname')
        print(f"  Path after CDP: {path}")
    
    if 'birthday' in str(path):
        # Check if the button has jsaction that needs special handling
        print("  Check jsaction:")
        r = await ev("""(function(){
            var btns=document.querySelectorAll('button');
            for(var i=0;i<btns.length;i++){
                if(btns[i].textContent.trim()==='繼續'){
                    return 'jsaction='+btns[i].getAttribute('jsaction')+' jsname='+btns[i].getAttribute('jsname')+' type='+btns[i].type;
                }
            }
            return 'no 繼續 btn';
        })()""")
        print(f"  {r}")
        
        # Try form submit
        print("  Try form submit...")
        await ev("var f=document.querySelector('form');if(f)f.submit();else'no form'")
        await asyncio.sleep(5)
        path = await ev('location.pathname')
        print(f"  Path after form.submit: {path}")
    
    # === STEP 2: username (if reached) ===
    if 'username' in str(path) or 'choose' in str(path):
        print(f"\n=== USERNAME ===")
        r = await ev("""(function(){
            var inps=document.querySelectorAll('input');
            for(var i=0;i<inps.length;i++){
                var r=inps[i].getBoundingClientRect();
                if(r.height>0&&(inps[i].type==='email'||inps[i].name==='fixedEmail')){
                    var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
                    setter.call(inps[i],'danielrowe7144');
                    inps[i].dispatchEvent(new Event('input',{bubbles:true}));
                    inps[i].dispatchEvent(new Event('change',{bubbles:true}));
                    return 'SET:'+inps[i].value;
                }
            }
            return 'NO INPUT';
        })()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        await focus_and_enter_button("繼續")
        await asyncio.sleep(5)
        path = await ev('location.pathname')
        print(f"  Path: {path}")
    
    # === STEP 3: password (if reached) ===
    if 'password' in str(path):
        print(f"\n=== PASSWORD ===")
        r = await ev(f"""(function(){{
            var pw='{PW}';
            var inp=document.querySelector('input[type=password]');
            if(!inp) return 'NO PW';
            var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(inp,pw);
            inp.dispatchEvent(new Event('input',{{bubbles:true}}));
            inp.dispatchEvent(new Event('change',{{bubbles:true}}));
            var all=document.querySelectorAll('input[type=password]');
            if(all.length>1){{setter.call(all[1],pw);all[1].dispatchEvent(new Event('input',{{bubbles:true}}));all[1].dispatchEvent(new Event('change',{{bubbles:true}}));}}
            return 'SET len='+inp.value.length+' count='+all.length;
        }})()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        await focus_and_enter_button("繼續")
        await asyncio.sleep(5)
        path = await ev('location.pathname')
        print(f"  Path: {path}")
    
    print(f"\n=== FINAL: {path} ===")
    print(f"  Title: {await ev('document.title')}")
    
    await ws.close()

asyncio.run(main())
