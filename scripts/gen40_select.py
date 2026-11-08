#!/usr/bin/env python3
"""gen40: Complete birthday form fill via keyboard"""
import asyncio, json, os, subprocess
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"
EVIDENCE = "/home/kenneth/.openclaw/workspace/water_army/docs/audits/stealth7/evidence"
ADB = "/home/kenneth/.local/share/platform-tools/adb"
DEV = "127.0.0.1:16701"
SECRETS = "/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json"

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
    async def key(ktype, key_char, keyCode):
        await send('Input.dispatchKeyEvent', {'type':ktype,'key':key_char,'code':'','windowsVirtualKeyCode':keyCode,'nativeVirtualKeyCode':keyCode})
    async def press(key_char, keyCode):
        await key('keyDown',key_char,keyCode); await key('keyUp',key_char,keyCode)
    async def click(x,y):
        await send('Input.dispatchMouseEvent',{'type':'mousePressed','x':x,'y':y,'button':'left','clickCount':1,'buttons':1})
        await send('Input.dispatchMouseEvent',{'type':'mouseReleased','x':x,'y':y,'button':'left','clickCount':1,'buttons':0})

    # === MONTH: Already expanded. Find "3 月" option and click it ===
    print("=== SELECT 3月 ===")
    r = await ev("""(function(){
        var opts=document.querySelectorAll('[role=option]');
        for(var i=0;i<opts.length;i++){
            if(opts[i].textContent.trim()==='3 \\u6708' || opts[i].textContent.trim()==='3月'){
                var rect=opts[i].getBoundingClientRect();
                return JSON.stringify({text:opts[i].textContent.trim(),x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)});
            }
        }
        // List all visible options for diagnosis
        var vis=[];
        for(var i=0;i<opts.length;i++){
            var rect=opts[i].getBoundingClientRect();
            if(rect.height>0&&rect.y>0) vis.push(opts[i].textContent.trim());
        }
        return JSON.stringify({error:'not found',visible:vis.slice(0,15)});
    })()""")
    print(f"  3月: {r}")
    
    opt = json.loads(r) if isinstance(r, str) and r.startswith('{') else r
    if isinstance(opt, dict) and 'x' in opt:
        await click(opt['x'], opt['y'])
        await asyncio.sleep(0.5)
    elif isinstance(opt, dict) and 'error' in opt:
        # Try ArrowDown x2 + Enter
        print("  Using keyboard: 2x ArrowDown from top")
        await send('Input.dispatchMouseEvent',{'type':'mousePressed','x':206,'y':244,'button':'left','clickCount':1,'buttons':1})
        await send('Input.dispatchMouseEvent',{'type':'mouseReleased','x':206,'y':244,'button':'left','clickCount':1,'buttons':0})
        await asyncio.sleep(0.5)
        # Focus and arrow
        await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if(cbs[i].textContent.trim()==='月'){cbs[i].focus();return 'ok';}}return 'no';})()")
        for _ in range(2):
            await press('ArrowDown', 40)
            await asyncio.sleep(0.2)
        await press('Enter', 13)
        await asyncio.sleep(0.5)
    
    # Verify month
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            var lbl=cbs[i].getAttribute('aria-label')||'';
            if(lbl.indexOf('月')>=0) return cbs[i].getAttribute('aria-label')+' text='+cbs[i].textContent.trim();
        }
        // Check by parent form field
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            var t=cbs[i].textContent.trim();
            if(t.includes('月')&&t.length<5) return 'month combo: text='+t;
        }
        return 'not verified';
    })()""")
    print(f"  After select: {r}")
    
    # === GENDER: Focus and ArrowDown to open ===
    print("\n=== SELECT 男 ===")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='性別'){
                cbs[i].focus();
                return 'focused gender: '+document.activeElement.getAttribute('role');
            }
        }
        return 'NOT FOUND';
    })()""")
    print(f"  {r}")
    
    await press('ArrowDown', 40)
    await asyncio.sleep(0.5)
    
    # Check expanded and find 男
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        var genderCb=null;
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='性別'||cbs[i].textContent.trim()==='男'){
                genderCb=cbs[i]; break;
            }
        }
        if(!genderCb) return 'no gender combo';
        var expanded = genderCb.getAttribute('aria-expanded');
        // Find 男 option
        var opts=genderCb.querySelectorAll('[role=option]') || genderCb.nextElementSibling.querySelectorAll('[role=option]');
        var maleOpt=null;
        if(!opts||opts.length===0){
            // search all options
            var allOpts=document.querySelectorAll('[role=option]');
            for(var i=0;i<allOpts.length;i++){
                if(allOpts[i].textContent.trim()==='男'){
                    var rect=allOpts[i].getBoundingClientRect();
                    if(rect.height>0) maleOpt={x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
                    break;
                }
            }
        }
        return JSON.stringify({expanded:expanded, text:genderCb.textContent.trim(), maleOpt:maleOpt});
    })()""")
    print(f"  {r}")
    
    gd = json.loads(r) if isinstance(r, str) and r.startswith('{') else r
    if isinstance(gd, dict):
        if gd.get('maleOpt'):
            mo = gd['maleOpt']
            print(f"  Click 男 at ({mo['x']},{mo['y']})")
            await click(mo['x'], mo['y'])
            await asyncio.sleep(0.5)
        elif gd.get('expanded') == 'true':
            # Options visible but 男 not found, try ArrowDown+Enter
            print("  男 not found visible; try keyboard Down from gender combo")
            await press('ArrowDown', 40)  # first = 女
            await press('ArrowDown', 40)  # second = 男
            await press('Enter', 13)
            await asyncio.sleep(0.5)
    
    # === VERIFY FINAL STATE ===
    print("\n=== BIRTHDAY STATE ===")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        var state={};
        for(var i=0;i<cbs.length;i++){
            var t=cbs[i].textContent.trim();
            if(t==='月'||t.includes('月')&&t.length<5) state.month=t;
            if(t==='性別'||t==='男'||t==='女') state.gender=t;
        }
        state.day=document.querySelector('input[name=day]')?document.querySelector('input[name=day]').value:'?';
        state.year=document.querySelector('input[name=year]')?document.querySelector('input[name=year]').value:'?';
        return JSON.stringify(state);
    })()""")
    print(f"  {r}")
    
    # === CLICK 繼續 ===
    print("\n=== CLICK 繼續 ===")
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
    
    if r and isinstance(r, dict):
        await click(r['x'], r['y'])
        await asyncio.sleep(3)
        
        # Check next page
        print(f"\n  URL after continue: {await ev('location.pathname')}")
        print(f"  TITLE: {await ev('document.title')}")
        print(f"  BODY: {await ev('document.body.innerText.substring(0,200)')}")
    
    # Screencap
    subprocess.run([ADB,"-s",DEV,"shell","screencap","-p","/data/local/tmp/tmpcap.png"],check=True,capture_output=True)
    subprocess.run([ADB,"-s",DEV,"pull","/data/local/tmp/tmpcap.png",f"{EVIDENCE}/s7-s40-03-birthday.png"],check=True,capture_output=True)
    
    await ws.close()

asyncio.run(main())
