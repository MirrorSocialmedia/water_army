#!/bin/bash
# d3-api.sh METHOD PATH [JSON_BODY] — product API via admin session (no port published)
# Prints "HTTP <status>" then body.
M="${1:-GET}"; P="$2"; B="${3:-}"
T=$(cat /tmp/adv-session-token)
docker exec -e M="$M" -e P="$P" -e B="$B" -e T="$T" water-army-api-1 node -e '
const base="http://127.0.0.1:3000";
fetch(base+process.env.P,{method:process.env.M,
  headers:{"content-type":"application/json",Cookie:"session="+process.env.T},
  ...(process.env.B?{body:process.env.B}:{})
}).then(async r=>{const t=await r.text();console.log("HTTP "+r.status);console.log(t)}).catch(e=>{console.log("ERR "+e.message)})'
