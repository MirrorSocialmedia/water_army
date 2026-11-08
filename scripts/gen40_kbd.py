#!/usr/bin/env python3
"""gen40: Keyboard-driven combobox selection"""
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
    async def key(key_type, key_char=None, keyCode=None):
        p={'type':key_type}
        if key_char: p['key']=key_char
        if keyCode: p['windowsVirtualKeyCode']=keyCode; p['nativeVirtualKeyCode']=keyCode
        p['code']=''
        await send('Input.dispatchKeyEvent', p)

    # Focus the month combobox
    print("=== FOCUS MONTH COMBOBOX ===")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='月'){
                cbs[i].focus();
                return 'focused tag='+cbs[i].tagName+' now active='+document.activeElement.getAttribute('role');
            }
        }
        return 'NOT FOUND';
    })()""")
    print(r)
    
    # Try Down arrow to open/navigate
    await asyncio.sleep(0.3)
    await key('keyDown', 'ArrowDown', 40)
    await key('keyUp', 'ArrowDown', 40)
    await asyncio.sleep(0.5)
    
    # Check state
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='月'){
                return 'text='+cbs[i].textContent.trim()+' expanded='+cbs[i].getAttribute('aria-expanded');
            }
        }
        return '?';
    })()""")
    print(f"After ArrowDown: {r}")
    
    # Try Space to open
    await key('keyDown', ' ', 32)
    await key('keyUp', ' ', 32)
    await asyncio.sleep(0.5)
    print(f"After Space: {r}")
    
    # Check if there's a visible listbox popup now
    r = await ev("""(function(){
        var lists=document.querySelectorAll('[role=listbox]');
        for(var i=0;i<lists.length;i++){
            var rect=lists[i].getBoundingClientRect();
            if(rect.height>0) return 'VISIBLE listbox id='+lists[i].id+' opts='+lists[i].querySelectorAll('[role=option]').length;
        }
        return 'no visible listbox';
    })()""")
    print(r)
    
    # Try approach: click the formfield CONTAINER (parent of combobox)
    print("\n=== CLICK FORMFIELD PARENT ===")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim()==='月'){
                // The MDC select's clickable area is often the full container
                // Go up to the "Udn8cf" level (the formfield root)
                var formfield = cbs[i].closest('[class*=Udn8cf],[class*=S2ZeGc],[class*=nTjNoe]');
                if(!formfield) formfield = cbs[i].parentElement.parentElement;
                var rect = formfield.getBoundingClientRect();
                return JSON.stringify({tag:formfield.tagName, cls:formfield.className.substring(0,40), x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2), w:Math.round(rect.width), h:Math.round(rect.height)});
            }
        }
        return null;
    })()""")
    print(f"Formfield rect: {r}")
    
    if r and isinstance(r, dict) and r.get('h',0) > 0:
        # Click via CDP at formfield center
        print(f"  CDP click ({r['x']},{r['y']})")
        await send('Input.dispatchMouseEvent', {'type':'mousePressed','x':r['x'],'y':r['y'],'button':'left','clickCount':1,'buttons':1})
        await send('Input.dispatchMouseEvent', {'type':'mouseReleased','x':r['x'],'y':r['y'],'button':'left','clickCount':1,'buttons':0})
        await asyncio.sleep(1)
        
        # Check expanded
        r2 = await ev("""(function(){
            var cbs=document.querySelectorAll('[role=combobox]');
            for(var i=0;i<cbs.length;i++){
                if(cbs[i].textContent.trim()==='月') return 'expanded='+cbs[i].getAttribute('aria-expanded');
            }
            return '?';
        })()""")
        print(f"  Expanded: {r2}")
        
        # Check options visible
        r2 = await ev("""(function(){
            var opts=document.querySelectorAll('[role=option]');
            var vis=[];
            for(var i=0;i<opts.length;i++){
                var rect=opts[i].getBoundingClientRect();
                if(rect.height>0 && rect.y>0) vis.push(opts[i].textContent.trim().substring(0,6)+'@'+Math.round(rect.x+rect.width/2)+','+Math.round(rect.y+rect.height/2));
            }
            return vis.length+' visible: '+vis.slice(0,8).join(', ');
        })()""")
        print(f"  Options: {r2}")
    
    await ws.close()

asyncio.run(main())
