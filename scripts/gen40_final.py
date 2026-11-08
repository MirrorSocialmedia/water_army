#!/usr/bin/env python3
"""gen40: Full birthday fill — open via keyboard, select via global JS click"""
import asyncio, json, os, subprocess
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"

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
    async def press(key_char, keyCode):
        await send('Input.dispatchKeyEvent', {'type':'keyDown','key':key_char,'code':'','windowsVirtualKeyCode':keyCode,'nativeVirtualKeyCode':keyCode})
        await send('Input.dispatchKeyEvent', {'type':'keyUp','key':key_char,'code':'','windowsVirtualKeyCode':keyCode,'nativeVirtualKeyCode':keyCode})
    async def click(x,y):
        await send('Input.dispatchMouseEvent',{'type':'mousePressed','x':x,'y':y,'button':'left','clickCount':1,'buttons':1})
        await send('Input.dispatchMouseEvent',{'type':'mouseReleased','x':x,'y':y,'button':'left','clickCount':1,'buttons':0})

    # === STEP A: Open month dropdown via keyboard, then find option globally ===
    print("=== A: MONTH ===")
    # 1. Focus
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='月'){cbs[i].focus();return document.activeElement.getAttribute('role');}
        }
        return 'NOT FOUND';
    })()""")
    print(f"  Focus: {r}")
    
    # 2. Open with ArrowDown
    await press('ArrowDown', 40)
    await asyncio.sleep(0.3)
    
    # 3. Find 3月 option GLOBALLY
    r = await ev("""(function(){
        var opts=document.querySelectorAll('[role=option]');
        var results=[];
        for(var i=0;i<opts.length;i++){
            var t=opts[i].textContent.trim();
            var rect=opts[i].getBoundingClientRect();
            if(t==='3 \\u6708' && rect.height>0){
                return JSON.stringify({text:t,x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
            }
            if(rect.height>0 && t.length<10) results.push(t);
        }
        return JSON.stringify({error:'not found',visible:results.slice(0,20)});
    })()""")
    print(f"  3月 global: {r}")
    
    opt = json.loads(r) if isinstance(r,str) and r.startswith('{') else r
    if isinstance(opt,dict) and 'x' in opt:
        # 4. Click the option
        print(f"  Click 3月 at ({opt['x']},{opt['y']})")
        await click(opt['x'], opt['y'])
        await asyncio.sleep(0.5)
        
        # 5. Verify
        r = await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){var t=cbs[i].textContent.trim();if(t.length<10&&t.length>0&&t.includes('月'))return t;}return 'still 月?';})()")
        print(f"  Result: {r}")
    
    # === STEP B: Gender ===
    print("\n=== B: GENDER ===")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='性別'){cbs[i].focus();return document.activeElement.getAttribute('role');}
        }
        return 'NOT FOUND';
    })()""")
    print(f"  Focus: {r}")
    
    await press('ArrowDown', 40)
    await asyncio.sleep(0.3)
    
    # Find 男 option globally
    r = await ev("""(function(){
        var opts=document.querySelectorAll('[role=option]');
        var results=[];
        for(var i=0;i<opts.length;i++){
            var t=opts[i].textContent.trim();
            var rect=opts[i].getBoundingClientRect();
            if(t==='男' && rect.height>0){
                return JSON.stringify({text:t,x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
            }
            if(rect.height>0 && (t==='女'||t==='男'||t==='其他'||t==='不便透露')) results.push(t);
        }
        return JSON.stringify({error:'not found',visible:results.slice(0,10)});
    })()""")
    print(f"  男 global: {r}")
    
    opt = json.loads(r) if isinstance(r,str) and r.startswith('{') else r
    if isinstance(opt,dict) and 'x' in opt:
        print(f"  Click 男 at ({opt['x']},{opt['y']})")
        await click(opt['x'], opt['y'])
        await asyncio.sleep(0.5)
        
        r = await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){var t=cbs[i].textContent.trim();if(t==='男')return 'GENDER=男';if(t==='性別')return 'GENDER still label';}return '?';})()")
        print(f"  Result: {r}")
    
    # === STEP C: Verify + Continue ===
    print("\n=== C: FINAL STATE ===")
    print(await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        var combos=[];
        for(var i=0;i<cbs.length;i++){
            var t=cbs[i].textContent.trim();
            var rect=cbs[i].getBoundingClientRect();
            if(rect.height>0) combos.push(t);
        }
        return JSON.stringify({combos:combos, day:document.querySelector('input[name=day]').value, year:document.querySelector('input[name=year]').value, pathname:location.pathname});
    })()"""))
    
    # Find and click 繼續
    print("\n=== D: CLICK 繼續 ===")
    r = await ev("""(function(){
        var btns=document.querySelectorAll('button,[role=button]');
        for(var i=0;i<btns.length;i++){
            if(btns[i].textContent.trim()==='繼續'){
                var rect=btns[i].getBoundingClientRect();
                if(rect.height>0) return JSON.stringify({x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
            }
        }
        return null;
    })()""")
    print(f"  CTA: {r}")
    
    if isinstance(r,dict):
        await click(r['x'], r['y'])
        await asyncio.sleep(4)
        print(f"  URL: {await ev('location.pathname')}")
        print(f"  TITLE: {await ev('document.title')}")
        print(f"  BODY: {await ev('document.body.innerText.substring(0,200)')}")
        # Second click if needed (silent no-op pattern)
        r2 = await ev("location.pathname")
        if 'birthday' in str(r2):
            print("  Birthday step still active — second click needed")
            await click(r['x'], r['y'])
            await asyncio.sleep(4)
            print(f"  After 2nd: {await ev('location.pathname')} | {await ev('document.title')}")
    
    await ws.close()

asyncio.run(main())
