// WA-FIXALL S4: canvas toDataURL hash + webgl unmasked + WebRTC ICE candidates (two-phase, host-side sleep; no in-page timers).
// Usage: node s4-mini.cjs <cdpHttpBase> <outJson>
const fs = require('node:fs');
const base = process.argv[2];
const outFile = process.argv[3];
const KICK = `(function(){
  var p={};
  try{
    var c=document.createElement('canvas');c.width=64;c.height=16;
    var x=c.getContext('2d');x.textBaseline='top';x.font='14px Arial';
    x.fillStyle='#1A73E8';x.fillRect(0,0,64,16);
    x.fillStyle='#f60';x.fillRect(62,2,3,16);
    x.beginPath();x.arc(10,10,7,0,Math.PI*2,true);x.closePath();
    x.fillStyle='rgba(60,120,220,0.45)';x.fill();
    x.fillStyle='#0f0';x.fillText('Cwm Fi5íWørd',2,2);
    x.strokeStyle='#008';x.fillText('Cwm Fi5íWørd',2,4);
    p.canvasDataUrl=c.toDataURL();
    var gl=document.createElement('canvas').getContext('webgl');
    var dbg=gl&&gl.getExtension('WEBGL_debug_renderer_info');
    p.webgl=gl?{vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),
      unmaskedVendor:dbg?gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL):null,
      unmaskedRenderer:dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):null,
      maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)}:null;
    var pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
    pc.createDataChannel('x');
    window.__ice=[];
    pc.onicecandidate=function(e){if(e&&e.candidate)window.__ice.push(e.candidate.candidate);};
    pc.onicegatheringstatechange=function(){window.__iceState=pc.iceGatheringState;window.__iceConn=pc.iceConnectionState;};
    pc.onnegotiationneeded=function(){pc.createOffer().then(function(o){return pc.setLocalDescription(o);}).catch(function(e2){window.__iceErr=String(e2);});};
    pc.createOffer().then(function(o){return pc.setLocalDescription(o);}).catch(function(e2){window.__iceErr=String(e2);});
    p.webrtcKick='ok';
  }catch(e){p._err=String(e);}
  return JSON.stringify(p);
})()`;
const READ = `(function(){
  var p={candidates:window.__ice||null,state:window.__iceState||null,conn:window.__iceConn||null,err:window.__iceErr||null};
  try{var pc=window.__pcHack;}catch(e){}
  return JSON.stringify(p);
})()`;
async function main(){
  const targets=await (await fetch(base+'/json/list')).json();
  const page=targets.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);
  if(!page)throw new Error('no page target');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws failed'));});
  let id=0;const pending=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
  const send=(method,params)=>new Promise(res=>{id++;pending.set(id,res);ws.send(JSON.stringify({id,method,params:params||{}}));});
  await send('Runtime.enable');
  const r1=await send('Runtime.evaluate',{expression:KICK,returnByValue:true});
  const kick=JSON.parse(r1.result.result.value);
  await new Promise(r=>setTimeout(r,+(process.env.WINDOW_MS||6000)));
  const r2=await send('Runtime.evaluate',{expression:READ,returnByValue:true});
  const read=JSON.parse(r2.result.result.value);
  const crypto=require('node:crypto');
  const du=kick.canvasDataUrl||'';
  const out={_ts:new Date().toISOString(),canvas:{dataUrlLen:du.length,sha256:du?crypto.createHash('sha256').update(du).digest('hex'):'null'},webgl:kick.webgl,webrtc:read,_err:kick._err||null};
  fs.writeFileSync(outFile,JSON.stringify(out,null,2));
  console.log('canvas_sha',out.canvas.sha256.slice(0,16),'len',out.canvas.dataUrlLen);
  console.log('webgl',JSON.stringify(out.webgl));
  console.log('ice',JSON.stringify(out.webrtc));
  ws.close();
}
main().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
