#!/usr/bin/env python3
"""gen40: Keyboard-only dropdown interaction - no coordinate clicks"""
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

    # Step 1: Check current state (from previous run's 繼續 click?)
    print("STATE:", await ev('location.pathname + "|" + document.title'))
    
    # Check month/gender combobox current values
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        var out=[];
        for(var i=0;i<cbs.length;i++){
            var t=cbs[i].textContent.trim();
            if(t==='月'||t==='性別'||(t.includes('月')&&t.length<10)||(t.includes('男')&&t.length<10)){
                out.push(t+' expanded='+cbs[i].getAttribute('aria-expanded'));
            }
        }
        return out.join(', ');
    })()""")
    print(f"  Combos: {r}")
    
    # Step 2: Month - focus, open with ArrowDown, navigate to "3 月"
    print("\n=== MONTH: keyboard approach ===")
    # Focus
    await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if(cbs[i].textContent.trim()==='月'){cbs[i].focus();return 1;}}return 0;})()")
    await asyncio.sleep(0.2)
    
    # Open dropdown
    await press('ArrowDown', 40)
    await asyncio.sleep(0.3)
    
    # Check expanded state and visible options
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='月'){
                var exp=cbs[i].getAttribute('aria-expanded');
                // Find visible options that are siblings or in related listbox
                var parent=cbs[i].parentElement;
                while(parent){
                    var opts=parent.querySelectorAll('[role=option]');
                    if(opts.length>0){
                        var vis=[];
                        for(var j=0;j<opts.length;j++){
                            var r=opts[j].getBoundingClientRect();
                            var selected=opts[j].getAttribute('aria-selected');
                            if(r.height>0) vis.push(opts[j].textContent.trim().substring(0,6)+(selected==='true'?'*':''));
                        }
                        return 'expanded='+exp+' visible_opts('+vis.length+'): '+vis.slice(0,15).join(',');
                    }
                    parent=parent.parentElement;
                }
                return 'expanded='+exp+' no opts found';
            }
        }
        return 'NO COMBO';
    })()""")
    print(f"  {r}")
    
    # Navigate down to "3 月" (2nd option after opening, 0-indexed: Jan=0, Feb=1, Mar=2)
    # Actually: from "month" default, ArrowDown x2 should land on Feb (index 1) or Mar (index 2)
    # The first ArrowDown already landed on first option (Jan or the placeholder). Let's do 2 more
    await press('ArrowDown', 40); await asyncio.sleep(0.1)
    await press('ArrowDown', 40); await asyncio.sleep(0.1)
    await press('ArrowDown', 40); await asyncio.sleep(0.1)
    
    # Check what's highlighted
    r = await ev("""(function(){
        var opts=document.querySelectorAll('[role=option][aria-selected=true]');
        var out=[];
        for(var i=0;i<opts.length;i++) out.push(opts[i].textContent.trim().substring(0,8));
        return out.join(',');
    })()""")
    print(f"  Selected: {r}")
    
    # Press Enter to select
    await press('Enter', 13)
    await asyncio.sleep(0.5)
    
    # Verify
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim().includes('月')&&cbs[i].textContent.trim().length<10) return 'month text='+cbs[i].textContent.trim();
        }
        return '?';
    })()""")
    print(f"  Month after Enter: {r}")
    
    # Step 3: Gender
    print("\n=== GENDER: keyboard approach ===")
    await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if(cbs[i].textContent.trim()==='性別'){cbs[i].focus();return 1;}}return 0;})()")
    await asyncio.sleep(0.2)
    
    # Open
    await press('ArrowDown', 40)
    await asyncio.sleep(0.3)
    
    # Check
    r = await ev("""(function(){
        var opts=document.querySelectorAll('[role=option][aria-selected=true]');
        var out=[];
        for(var i=0;i<opts.length;i++) out.push(opts[i].textContent.trim().substring(0,10));
        return out.join(',');
    })()""")
    print(f"  Selected after open: {r}")
    
    # Navigate to 男 (女=first, 男=second)
    await press('ArrowDown', 40); await asyncio.sleep(0.1)
    
    r = await ev("""(function(){
        var opts=document.querySelectorAll('[role=option][aria-selected=true]');
        var out=[];
        for(var i=0;i<opts.length;i++) out.push(opts[i].textContent.trim().substring(0,10));
        return out.join(',');
    })()""")
    print(f"  After 1x Down: {r}")
    
    # Enter to select
    await press('Enter', 13)
    await asyncio.sleep(0.5)
    
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            var t=cbs[i].textContent.trim();
            if(t==='男'||t==='性別'||t==='女') return 'gender text='+t;
        }
        return '?';
    })()""")
    print(f"  Gender after Enter: {r}")
    
    # Step 4: FINAL STATE
    print("\n=== FINAL ===")
    print(await ev("""(function(){
        var state={};
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            var t=cbs[i].textContent.trim();
            if(t.length<10&&t.length>0) state['combo'+i]=t;
        }
        state.day=document.querySelector('input[name=day]')?.value||'?';
        state.year=document.querySelector('input[name=year]')?.value||'?';
        return JSON.stringify(state);
    })()"""))
    
    await ws.close()

asyncio.run(main())
