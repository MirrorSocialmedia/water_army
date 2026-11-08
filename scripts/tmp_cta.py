#!/usr/bin/env python3
import asyncio, json, websockets

WS_URL = "ws://127.0.0.1:19222/devtools/page/D2C178F5F50B8DD7DA644545D84513CD"

async def main():
    ws = await websockets.connect(WS_URL, max_size=15*1024*1024)
    cid=[0]
    async def ev(expr):
        cid[0]+=1
        await ws.send(json.dumps({'id':cid[0],'method':'Runtime.evaluate','params':{'expression':expr,'returnByValue':True,'timeout':5000}}))
        while True:
            raw=await asyncio.wait_for(ws.recv(),10)
            r=json.loads(raw)
            if r.get('id')==cid[0]: return r.get('result',{}).get('result',{}).get('value', r.get('result',{}).get('result',{}))

    # Find CTA
    r = await ev("""(function(){
        var all=document.querySelectorAll('button,[role=button],a,span,div');
        var out=[];
        for(var i=0;i<all.length;i++){
            if(all[i].textContent.trim()==='繼續'){
                var r2=all[i].getBoundingClientRect();
                var tag=all[i].tagName;
                var role=all[i].getAttribute('role')||'';
                var vis=r2.height>0;
                if(vis) out.push(tag+'.'+((all[i].className||'')+'').substring(0,20)+' role='+role+' x='+Math.round(r2.x+r2.width/2)+' y='+Math.round(r2.y+r2.height/2)+' w='+Math.round(r2.width)+' h='+Math.round(r2.height));
            }
        }
        return out.length+': '+out.join(' | ');
    })()""")
    print(f"CTA: {r}")
    
    await ws.close()

asyncio.run(main())
