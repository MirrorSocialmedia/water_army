#!/usr/bin/env python3
"""gen40: Touch events + JS manipulation for Material combobox"""
import asyncio, json, os, subprocess
import websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"

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

    # Strategy 1: Try touch events on month combobox
    print("=== TOUCH EVENT MONTH ===")
    await send('Input.dispatchTouchEvent', {
        'type': 'touchStart',
        'touchPoints': [{'x': 206, 'y': 244}]
    })
    await send('Input.dispatchTouchEvent', {
        'type': 'touchEnd',
        'touchPoints': []
    })
    await asyncio.sleep(1)
    r = await ev("document.querySelector('[role=combobox][aria-label]')")
    # Check expanded state
    print(await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0)return 'expanded='+cbs[i].getAttribute('aria-expanded');}return '?'})()"))
    
    # Strategy 2: Check what the combobox structure looks like (inner elements)
    print("\nMONTH INTERNALS:")
    print(await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0){
                var c=cbs[i];
                var inner = c.innerHTML.substring(0,300);
                var tag = c.tagName;
                var parentTag = c.parentElement.tagName;
                var grandparent = c.parentElement.parentElement;
                return tag+' in '+parentTag+' in '+grandparent.tagName+': innerHTML='+inner;
            }
        }
        return 'NOT FOUND';
    })()"""))
    
    # Strategy 3: Try pointer events dispatch
    print("\nPOINTER EVENTS:")
    await send('Input.dispatchMouseEvent', {'type':'pointerDown','x':206,'y':244,'button':'left','pointerType':'mouse','clickCount':1})
    await send('Input.dispatchMouseEvent', {'type':'pointerUp','x':206,'y':244,'button':'left','pointerType':'mouse','clickCount':1})
    await asyncio.sleep(1)
    print(await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0)return 'expanded='+cbs[i].getAttribute('aria-expanded');}return '?'})()"))
    
    # Strategy 4: JS native click on the formfield wrapper (Material uses custom events)
    print("\nJS FORMFIELD CLICK:")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0){
                // Go up to find the mdc-select / form field container
                var el = cbs[i];
                while(el && el.tagName !== 'MDC-SELECT' && !el.classList.contains('mdc-select') && el.tagName !== 'DIV'){
                    el = el.parentElement;
                }
                // Try clicking the form field's root
                var formField = cbs[i].closest('.mdc-form-field, .mdc-select, [class*=select], [class*=dropdown]');
                if(formField){
                    formField.click();
                    return 'clicked formField: '+formField.tagName+'.'+formField.className.substring(0,30);
                }
                // If no class found, click the combobox itself
                cbs[i].click();
                return 'clicked combobox directly tag='+cbs[i].tagName;
            }
        }
        return 'NOT FOUND';
    })()""")
    print(r)
    await asyncio.sleep(1)
    print(await ev("(function(){var cbs=document.querySelectorAll('[role=combobox]');for(var i=0;i<cbs.length;i++){if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0)return 'expanded='+cbs[i].getAttribute('aria-expanded');}return '?'})()"))
    
    # Strategy 5: Simulate select option directly
    print("\nSELECT OPTION DIRECT:")
    r = await ev("""(function(){
        // For ARIA combobox with listbox, set aria-selected on the correct option
        var cbs=document.querySelectorAll('[role=combobox]');
        var monthCb = null;
        for(var i=0;i<cbs.length;i++){if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0){monthCb=cbs[i];break;}}
        if(!monthCb) return 'NO MONTH COMBO';
        
        // Check if there's a listbox linked to it
        var listbox = document.getElementById(monthCb.getAttribute('aria-controls')||'') || monthCb.nextElementSibling;
        var lbRole = listbox ? listbox.getAttribute('role') : 'none';
        var lbChildren = listbox ? listbox.children.length : 0;
        return 'controls='+monthCb.getAttribute('aria-controls')+' listbox='+lbRole+' children='+lbChildren;
    })()""")
    print(r)
    
    await ws.close()

asyncio.run(main())
