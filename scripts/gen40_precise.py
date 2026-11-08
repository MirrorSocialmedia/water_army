#!/usr/bin/env python3
"""gen40: Precise dropdown interaction"""
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
            if r.get('id')==cid[0]: return r.get('result',{}).get('result',{}).get('value', r)
    async def click(x,y):
        await send('Input.dispatchMouseEvent',{'type':'mousePressed','x':x,'y':y,'button':'left','clickCount':1})
        await send('Input.dispatchMouseEvent',{'type':'mouseReleased','x':x,'y':y,'button':'left','clickCount':1})

    # Get combobox rects
    print("COMBO RECTS:")
    rects = await ev("""(function(){
        var cbs = document.querySelectorAll('[role=combobox]');
        var out = [];
        for(var i=0;i<cbs.length;i++){
            var c = cbs[i];
            var r = c.getBoundingClientRect();
            var lbl = (c.getAttribute('aria-label')||c.textContent.trim()).substring(0,15);
            out.push({label:lbl, x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), h:Math.round(r.height), expanded:c.getAttribute('aria-expanded')});
        }
        return JSON.stringify(out);
    })()""")
    print(rects)
    
    combos = json.loads(rects) if isinstance(rects,str) else rects
    if not combos:
        print("ERROR: No combos found"); await ws.close(); return
    
    # Month combobox position
    month_cb = next((c for c in combos if '月' in c.get('label','')), None)
    gender_cb = next((c for c in combos if '性別' in c.get('label','')), None)
    print(f"  Month: {month_cb}")
    print(f"  Gender: {gender_cb}")
    
    if month_cb and month_cb['h'] > 0:
        # Try clicking the month combobox
        print(f"\nClicking month at ({month_cb['x']}, {month_cb['y']})")
        await click(month_cb['x'], month_cb['y'])
        await asyncio.sleep(1)
        
        # Check for visible options
        vis_opts = await ev("""(function(){
            var opts = document.querySelectorAll('[role=option]');
            var vis = [];
            for(var i=0;i<opts.length;i++){
                var r = opts[i].getBoundingClientRect();
                if(r.height > 0 && r.y > 0) vis.push(opts[i].textContent.trim().substring(0,8)+'@'+Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2));
            }
            return vis.length + ':' + vis.slice(0,10).join(',');
        })()""")
        print(f"  Visible options: {vis_opts}")
        
        # If no visible options, try focusing and dispatching keyboard
        if vis_opts and vis_opts.split(':')[0] == '0':
            print("  Options not showing via click. Try keyboard Enter on focused combobox...")
            await send('Input.dispatchKeyEvent', {'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13})
            await send('Input.dispatchKeyEvent', {'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13})
            await asyncio.sleep(1)
            vis_opts = await ev("""(function(){
                var opts = document.querySelectorAll('[role=option]');
                var vis = [];
                for(var i=0;i<opts.length;i++){
                    var r = opts[i].getBoundingClientRect();
                    if(r.height > 0 && r.y > 0) vis.push(opts[i].textContent.trim().substring(0,8)+'@'+Math.round(r.x+r.width/2)+','+Math.round(r.y+r.height/2));
                }
                return vis.length + ':' + vis.slice(0,10).join(',');
            })()""")
            print(f"  After Enter: {vis_opts}")
    
    await ws.close()

asyncio.run(main())
