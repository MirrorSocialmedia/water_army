#!/usr/bin/env python3
import asyncio, json, websockets

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

    # Check month combobox: aria-labelledby, aria-controls, activedescendant
    print("MONTH COMBO ATTRS:")
    print(await ev("""(function(){
        var cbs=document.querySelectorAll('[role=combobox]');
        for(var i=0;i<cbs.length;i++){
            if(cbs[i].textContent.trim().indexOf('月')>=0){
                var c=cbs[i];
                var attrs={};
                for(var a of c.attributes) attrs[a.name]=a.value;
                return JSON.stringify(attrs);
            }
        }
        return 'NOT FOUND';
    })()"""))
    
    # Check selected options in ALL listboxes
    print("\nSELECTED OPTIONS:")
    print(await ev("""(function(){
        var lbs=document.querySelectorAll('[role=listbox]');
        var out=[];
        for(var i=0;i<lbs.length;i++){
            var lb=lbs[i];
            var sel=lb.querySelectorAll('[aria-selected=true]');
            var selText=[];
            for(var j=0;j<sel.length;j++) selText.push(sel[j].textContent.trim().substring(0,10));
            out.push('listbox#'+i+' id='+lb.id+' opts='+lb.querySelectorAll('[role=option]').length+' selected='+selText.join(','));
        }
        return out.join('\\n');
    })()"""))
    
    # Check the form validation state — what does the 繼續 button's click handler see?
    print("\nFORM STATE:")
    print(await ev("""(function(){
        // The Glif step form uses c-wiz data-params to track state
        var wiz=document.querySelector('input[name=day]').closest('c-wiz');
        var dataParams=wiz.getAttribute('data-params')||'';
        // Check if there's a hidden form or form state element
        var form=wiz.querySelector('form');
        var inputs=wiz.querySelectorAll('input[type=hidden]');
        var hiddenInfo=[];
        for(var i=0;i<inputs.length;i++) hiddenInfo.push(inputs[i].name+'='+inputs[i].value);
        return JSON.stringify({dataParams:dataParams.substring(0,100), hasForm:!!form, hidden:inputs.length, hiddenVals:hiddenInfo.join(','), wizAttrs:Object.keys(wiz.attributes).map(function(a){return a.name}).join(',')});
    })()"""))
    
    # Check button's jsaction and related handler
    print("\nBUTTON DETAIL:")
    print(await ev("""(function(){
        var btn=document.querySelector('button[jsaction]');
        var btns=document.querySelectorAll('button');
        for(var i=0;i<btns.length;i++){
            if(btns[i].textContent.trim()==='繼續'){
                var b=btns[i];
                return JSON.stringify({disabled:b.disabled, jsname:b.getAttribute('jsname'), jsaction:b.getAttribute('jsaction'), type:b.type, parentTag:b.parentElement.tagName, formTag:b.closest('form')?'YES':'NO'});
            }
        }
        return 'not found';
    })()"""))
    
    # Try: dispatch jsaction custom event directly
    print("\nJSACTION CUSTOM EVENT:")
    print(await ev("""(function(){
        // Google jsaction framework: dispatch a custom 'click' event that jsaction intercepts
        var btns=document.querySelectorAll('button');
        for(var i=0;i<btns.length;i++){
            if(btns[i].textContent.trim()==='繼續'){
                var e=new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0});
                btns[i].dispatchEvent(e);
                return 'dispatched bubbling click on '+btns[i].tagName;
            }
        }
        return 'not found';
    })()"""))
    await asyncio.sleep(5)
    print(f"  Path: {await ev('location.pathname')}")
    
    await ws.close()

asyncio.run(main())
