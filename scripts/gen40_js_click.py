#!/usr/bin/env python3
"""gen40: JS native click on listbox options"""
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

    # Both dropdowns are already expanded.
    # Strategy: Find the 3月 option in the month listbox and click it via JS
    print("=== JS CLICK 3月 OPTION ===")
    r = await ev("""(function(){
        // Find ALL options, identify which belongs to month (should be in a listbox near the month combobox)
        var cbs=document.querySelectorAll('[role=combobox]');
        var monthCb=null;
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='月') {monthCb=cbs[i];break;}
        }
        if(!monthCb) return 'NO MONTH COMBO';
        
        // The listbox is usually a child or sibling of the combobox's parent container
        var parent=monthCb.parentElement;
        var listbox=null;
        while(parent && !listbox){
            listbox=parent.querySelector('[role=listbox]');
            if(!listbox) parent=parent.parentElement;
        }
        if(!listbox) return 'NO LISTBOX FOUND';
        
        var opts=listbox.querySelectorAll('[role=option]');
        var target=null;
        for(var i=0;i<opts.length;i++){
            if(opts[i].textContent.trim()==='3 \\u6708') { target=opts[i]; break; }
        }
        if(!target) return '3月 NOT FOUND in '+opts.length+' opts';
        
        // Try multiple click approaches
        target.click();
        var expandedAfter = monthCb.getAttribute('aria-expanded');
        var textAfter = monthCb.textContent.trim();
        return 'clicked: expanded='+expandedAfter+' text='+textAfter;
    })()""")
    print(f"  {r}")
    
    await asyncio.sleep(0.5)
    
    # Verify month
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='月'||cbs[i].textContent.trim().includes('月')) return 'month: '+cbs[i].textContent.trim();
        }
        return '?';
    })()""")
    print(f"  Month: {r}")
    
    # Same for gender (expanded=true)
    print("\n=== JS CLICK 男 OPTION ===")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        var genderCb=null;
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='性別'||cbs[i].textContent.trim()==='男') {genderCb=cbs[i];break;}
        }
        if(!genderCb) return 'NO GENDER COMBO';
        
        var parent=genderCb.parentElement;
        var listbox=null;
        while(parent && !listbox){
            listbox=parent.querySelector('[role=listbox]');
            if(!listbox) parent=parent.parentElement;
        }
        if(!listbox) return 'NO LISTBOX';
        
        var opts=listbox.querySelectorAll('[role=option]');
        var target=null;
        for(var i=0;i<opts.length;i++){
            if(opts[i].textContent.trim()==='男') { target=opts[i]; break; }
        }
        if(!target) return '男 NOT FOUND in opts: '+Array.from(opts).map(o=>o.textContent.trim().substring(0,5)).join(',');
        
        target.click();
        return 'clicked 男; text_after='+genderCb.textContent.trim();
    })()""")
    print(f"  {r}")
    
    await asyncio.sleep(0.5)
    
    # FINAL check
    print("\n=== FINAL ===")
    print(await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        var out=[];
        for(var i=0;i<cbs.length;i++){
            var t=cbs[i].textContent.trim();
            if(t.length<15) out.push(t+'(exp='+cbs[i].getAttribute('aria-expanded')+')');
        }
        return out.join(' | ');
    })()"""))
    
    # If still showing labels (not values), try dispatching custom events
    print("\n=== TRY: dispatchEvent on option ===")
    r = await ev("""(function(){
        // Try pointerdown on 3月 option (MDC might listen to this)
        var cbs=document.querySelectorAll('[role=combobox]');
        var monthCb=null;
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='月') {monthCb=cbs[i];break;}
        }
        if(!monthCb) return 'no month';
        var parent=monthCb.parentElement;
        var listbox=null;
        while(parent && !listbox){
            listbox=parent.querySelector('[role=listbox]');
            if(!listbox) parent=parent.parentElement;
        }
        if(!listbox) return 'no listbox';
        var opts=listbox.querySelectorAll('[role=option]');
        var target=null;
        for(var i=0;i<opts.length;i++){
            if(opts[i].textContent.trim()==='3 \\u6708'){target=opts[i];break;}
        }
        if(!target) return 'no 3月';
        
        // Try a sequence of events that MDC Select might respond to
        var events = ['pointerdown','pointerup','click'];
        events.forEach(function(evtType){
            target.dispatchEvent(new PointerEvent(evtType,{bubbles:true,cancelable:true}));
        });
        return 'pointer events dispatched; expanded='+monthCb.getAttribute('aria-expanded');
    })()""")
    print(f"  {r}")
    await asyncio.sleep(0.5)
    
    print(await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if(cbs[i].textContent.trim().includes('月')&&cbs[i].textContent.trim().length<10)return cbs[i].textContent.trim();}return '?'})()"))
    
    await ws.close()

asyncio.run(main())
