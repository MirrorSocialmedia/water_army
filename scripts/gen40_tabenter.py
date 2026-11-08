#!/usr/bin/env python3
"""gen40: Tab-focus to 繼續 button then Enter (trusted key events)"""
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

    async def focus_continue_button():
        """Find and focus the continue button"""
        r = await ev("""(function(){
            var btns=document.querySelectorAll('button');
            for(var i=0;i<btns.length;i++){
                if(btns[i].textContent.trim()==='繼續'){
                    btns[i].focus();
                    return 'focused:'+document.activeElement.textContent.trim().substring(0,10);
                }
            }
            return 'NOT FOUND';
        })()""")
        return 'focused' in str(r)

    async def submit_step(text='繼續'):
        """Focus CTA + press Enter (trusted)"""
        for attempt in range(2):
            await focus_continue_button()
            await asyncio.sleep(0.3)
            await press('Enter', 13)
            await asyncio.sleep(5)
            path = await ev('location.pathname')
            if text not in str(await ev('document.body.innerText.substring(0,50)')):
                pass  # check by path instead
            if text not in str(path) and 'birthday' not in str(path) and 'username' not in str(path) and 'password' not in str(path):
                return path
            # Re-check path change
            if 'birthday' in str(path) and attempt == 0:
                print(f"  Attempt {attempt+1}: still birthday, retry...")
                continue
            break
        return await ev('location.pathname')

    # === Attempt: focus button + Enter ===
    print("=== BIRTHDAY: focus button + Enter ===")
    path = await submit_step()
    print(f"  Path: {path}")
    
    if 'birthday' in str(path):
        print("  STILL STUCK. Trying full page reload approach...")
        # Reload the page fresh
        await ev("location.reload()")
        await asyncio.sleep(8)
        print(f"  After reload: {await ev('location.pathname')} | {await ev('document.title')}")
        
        # Check if selections survived reload
        r = await ev("""(function(){
            var cbs=document.querySelectorAll('[role=combobox]');
            var out=[];
            for(var i=0;i<cbs.length;i++){
                var t=cbs[i].textContent.trim();
                if(t.length<15) out.push(t);
            }
            var day=document.querySelector('input[name=day]');
            var year=document.querySelector('input[name=year]');
            return JSON.stringify({combos:out, day:day?day.value:'?', year:year?year.value:'?'});
        })()""")
        print(f"  Form state after reload: {r}")
    
    print(f"\n=== FINAL: {await ev('location.pathname')} ===")
    print(f"  Title: {await ev('document.title')}")
    
    await ws.close()

asyncio.run(main())
