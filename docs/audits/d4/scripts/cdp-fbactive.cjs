// print activeElement on fb target
const base = 'http://127.0.0.1:9322';
async function main(){
 const t=await(await fetch(base+'/json/list')).json();
 const p=t.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);
 const ws=new WebSocket(p.webSocketDebuggerUrl);
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'));});
 const mid=21;
 const val=await new Promise((res,rej)=>{
   const h=(e)=>{const msg=JSON.parse(e.data);if(msg.id===mid){ws.removeEventListener('message',h);res(msg.result&&msg.result.result?msg.result.result.value:JSON.stringify(msg).slice(0,120));}};
   ws.addEventListener('message',h);
   ws.send(JSON.stringify({id:mid,method:'Runtime.evaluate',params:{expression:`document.activeElement.tagName+':'+(document.activeElement.name||document.activeElement.id||'')`,returnByValue:true}}));
   setTimeout(()=>rej(new Error('eval timeout')),12000);
 });
 console.log('ACTIVE:',val);
 ws.close();
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1);});
