#!/usr/bin/env python3
"""gen40: Click continue, fill username+password, submit"""
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
    async def click(x,y):
        await send('Input.dispatchMouseEvent',{'type':'mousePressed','x':x,'y':y,'button':'left','clickCount':1,'buttons':1})
        await send('Input.dispatchMouseEvent',{'type':'mouseReleased','x':x,'y':y,'button':'left','clickCount':1,'buttons':0})

    async def cdp_click_button(text_contains):
        """Find button containing text and click via JS"""
        r = await ev(f"""(function(){{
            var btns=document.querySelectorAll('button');
            for(var i=0;i<btns.length;i++){{
                if(btns[i].textContent.includes('{text_contains}')&&btns[i].getBoundingClientRect().height>0){{
                    btns[i].click();
                    return 'clicked:'+btns[i].textContent.trim().substring(0,15);
                }}
            }}
            return 'NOT FOUND';
        }})()""")
        return r

    async def wait_page_change(expected_kw, timeout=8):
        """Wait for page to leave current step"""
        for _ in range(timeout):
            await asyncio.sleep(1)
            path = await ev('location.pathname')
            if expected_kw not in str(path):
                return True
        return False

    # === CLICK 繼續 (birthday step) ===
    print("=== CLICK 繼續 (birthday) ===")
    r = await cdp_click_button("繼續")
    print(f"  {r}")
    
    # Wait for page change (up to 8 sec)
    changed = await wait_page_change("birthday", 8)
    path = await ev('location.pathname')
    print(f"  Path: {path}")
    
    if not changed:
        # Try second click (silent no-op pattern)
        print("  Second click...")
        await cdp_click_button("繼續")
        await asyncio.sleep(5)
        path = await ev('location.pathname')
        print(f"  Path: {path}")
    
    # === USERNAME STEP ===
    print(f"\n=== CURRENT: {path} ===")
    title = await ev('document.title')
    print(f"  Title: {title}")
    body = await ev('document.body.innerText.substring(0,200)')
    print(f"  Body: {body[:200]}")
    
    if 'username' in path or 'choose' in path:
        print("\n=== FILL USERNAME ===")
        r = await ev("""(function(){
            var inps=document.querySelectorAll('input');
            var emailInput=null;
            for(var i=0;i<inps.length;i++){
                var r=inps[i].getBoundingClientRect();
                if(r.height>0&&(inps[i].type==='email'||inps[i].name==='fixedEmail'||inps[i].getAttribute('aria-label')&&inps[i].getAttribute('aria-label').includes('用户名'))){
                    emailInput=inps[i];break;
                }
            }
            // Fallback: first visible text input
            if(!emailInput){
                for(var i=0;i<inps.length;i++){
                    var r=inps[i].getBoundingClientRect();
                    if(r.height>0&&inps[i].type==='text'&&r.y>100){emailInput=inps[i];break;}
                }
            }
            if(!emailInput) return 'NO INPUT';
            var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(emailInput,'danielrowe7144');
            emailInput.dispatchEvent(new Event('input',{bubbles:true}));
            emailInput.dispatchEvent(new Event('change',{bubbles:true}));
            return 'SET:'+emailInput.value+' type='+emailInput.type+' name='+emailInput.name;
        })()""")
        print(f"  {r}")
        await asyncio.sleep(1)
        
        # Click 繼續
        r = await cdp_click_button("繼續")
        print(f"  Click: {r}")
        changed = await wait_page_change("username", 8)
        path = await ev('location.pathname')
        print(f"  Path: {path}")
        
        if not changed:
            await cdp_click_button("繼續")
            await asyncio.sleep(5)
            path = await ev('location.pathname')
            print(f"  Path after 2nd: {path}")
    
    # === PASSWORD STEP ===
    if 'password' in str(path):
        print(f"\n=== FILL PASSWORD ===")
        r = await ev(f"""(function(){{
            var pw='{PW}';
            var inp=document.querySelector('input[type=password]');
            if(!inp) return 'NO PW INPUT';
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
        
        r = await cdp_click_button("繼續")
        print(f"  Click: {r}")
        changed = await wait_page_change("password", 10)
        path = await ev('location.pathname')
        print(f"  Path: {path}")
        
        if not changed:
            await cdp_click_button("繼續")
            await asyncio.sleep(5)
            path = await ev('location.pathname')
            print(f"  Path after 2nd: {path}")
    
    # === FINAL STATE ===
    print(f"\n=== FINAL: {await ev('location.pathname')} ===")
    print(f"  Title: {await ev('document.title')}")
    body = await ev('document.body.innerText.substring(0,300)')
    print(f"  Body: {body[:300]}")
    
    # Check for consent/welcome screens
    url = await ev('location.href')
    print(f"  URL: {url[:120]}")
    
    await ws.close()

asyncio.run(main())
