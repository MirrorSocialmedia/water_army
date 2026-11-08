#!/usr/bin/env python3
"""gen40: Direct DOM manipulation for combobox selection"""
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

    # Get detailed HTML of month combobox area
    print("=== COMBOBOX STRUCTURE ===")
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0){
                // Walk up 3 levels and return outerHTML snippet
                var el=cbs[i];
                var outer='';
                var parent = el.parentElement;
                if(parent && parent.parentElement){
                    outer = parent.parentElement.outerHTML.substring(0,800);
                }
                return outer;
            }
        }
        return 'NOT FOUND';
    })()""")
    print(r[:600] if r else 'EMPTY')
    
    # Check listbox options (they exist as [role=option] in the document)
    print("\n=== MONTH LISTBOX ===")
    r = await ev("""(function(){
        // Find the listbox linked to month combobox
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0){
                var c=cbs[i];
                var controlsId = c.getAttribute('aria-controls')||'';
                var lb = controlsId ? document.getElementById(controlsId) : null;
                if(!lb){
                    // Try sibling
                    lb = c.nextElementSibling;
                    while(lb && lb.getAttribute('role')!=='listbox') lb=lb.nextElementSibling;
                }
                if(!lb) return 'no listbox found; aria-controls='+controlsId;
                var opts = lb.querySelectorAll('[role=option]');
                var optInfo = [];
                for(var j=0;j<Math.min(opts.length,5);j++){
                    var rect=opts[j].getBoundingClientRect();
                    optInfo.push(opts[j].textContent.trim().substring(0,8)+' vis='+(rect.height>0)+' y='+Math.round(rect.y));
                }
                return 'listbox id='+lb.id+' opts='+opts.length+' first5='+optInfo.join(', ');
            }
        }
        return 'NOT FOUND';
    })()""")
    print(r)
    
    # Try JS native click on the combobox trigger area (MDC form field approach)
    print("\n=== NATIVE CLICK TRIES ===")
    # Try 1: dispatch click event with proper bubbling on the combobox
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0){
                var c=cbs[i];
                c.focus();
                // Dispatch mousedown+mouseup+click sequence
                ['mousedown','mouseup','click'].forEach(function(type){
                    c.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:206,clientY:244}));
                });
                return 'dispatched; expanded='+c.getAttribute('aria-expanded')+' active='+document.activeElement.getAttribute('aria-label');
            }
        }
        return 'NOT FOUND';
    })()""")
    print(r)
    await asyncio.sleep(0.5)
    
    # Check if expanded
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0) return 'expanded='+cbs[i].getAttribute('aria-expanded');
        }
        return '?';
    })()""")
    print(f"  After JS click: {r}")
    
    # Check if options became visible
    r = await ev("""(function(){
        var opts = document.querySelectorAll('[role=option]');
        var vis=[];
        for(var i=0;i<opts.length;i++){
            var r=opts[i].getBoundingClientRect();
            if(r.height>0&&r.y>0) vis.push(opts[i].textContent.trim().substring(0,6));
        }
        return vis.length+' visible: '+vis.slice(0,6).join(',');
    })()""")
    print(f"  Visible options: {r}")
    
    # If still not expanded, try keyboard navigation (ArrowDown to cycle)
    print("\n=== KEYBOARD SELECT MONTH ===")
    # Focus the combobox and send ArrowDown key
    r = await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if((cbs[i].getAttribute('aria-label')||'').indexOf('月')>=0){
                cbs[i].focus();
                return 'focused: '+document.activeElement.getAttribute('aria-label');
            }
        }
        return 'NOT FOUND';
    })()""")
    print(r)
    
    await ws.close()

asyncio.run(main())
