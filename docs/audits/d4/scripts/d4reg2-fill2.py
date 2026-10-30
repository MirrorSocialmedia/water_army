#!/usr/bin/env python3
# WA-D4 gen6: autonomous drive of Google basic signup in WebView shell.
# Protocol: dump-driven taps (bounds truth), liveness-checked, no fragile keys.
import re, subprocess, sys, time
ADB="/home/kenneth/.openclaw/workspace/tools/platform-tools/adb"; SER="127.0.0.1:15001"
def adb(*a,timeout=20):
    r=subprocess.run([ADB,"-s",SER]+list(a),capture_output=True,timeout=timeout); return r.stdout
def sh(s,timeout=25): return adb("shell",s,timeout=timeout)
def say(*x): print(*x,flush=True)
def focus():
    return sh("dumpsys window | grep -m1 mCurrentFocus").decode()
def alive():
    f=focus()
    return "webview_shell" in f
def goto(url):
    adb("shell","am","start","-a","android.intent.action.VIEW","-d",url,"-n","org.chromium.webview_shell/.WebViewBrowserActivity")
    time.sleep(9)
def dump(retries=8,mini=9000):
    s=""
    for _ in range(retries):
        s=sh("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml").decode("utf-8","replace")
        if len(s)>mini: return s
        time.sleep(1.5)
    return s
def N(s):
    return [dict(re.findall(r'(\w+)="([^"]*)"',m.group(1))) for m in re.finditer(r'<node ([^>]*?)/?>',s)]
def B(a):
    m=re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]",a.get("bounds","") or ""); return list(map(int,m.groups())) if m else None
def edits(s,urlbar=True):
    es=[a for a in N(s) if a.get("class")=="android.widget.EditText"]
    if urlbar: es=[a for a in es if not (a.get("text") or "").startswith("http")]
    return es
def textnodes(s,pat):
    return [a for a in N(s) if re.search(pat,(a.get("text") or "")+(a.get("content-desc") or ""),re.I)]
def tapb(a,dx=0,dy=0):
    b=B(a); x,y=(b[0]+b[2])//2+dx,(b[1]+b[3])//2+dy
    sh(f"input tap {x} {y}"); time.sleep(1.0); return x,y
def typ(t): sh(f"input text {t}"); time.sleep(0.5)
def shot(p,force_fresh=False):
    def grab(): return adb("exec-out","screencap","-p")
    a=grab()
    if force_fresh or len(a)<40000:
        sh("pkill -9 -f surfaceflinger"); time.sleep(6); a=grab()
    open(p,"wb").write(a); say("SHOT",p,len(a),"bytes")

MODE=sys.argv[1] if len(sys.argv)>1 else "namestep"
URL="https://accounts.google.com/signup"
if not alive():
    say("relaunch webview_shell"); goto(URL)
else:
    say("focus:",focus().strip())
s=dump()
say("dump bytes",len(s),"| edits:",[(a.get('text'),a.get('bounds')) for a in edits(s)])

if MODE=="namestep":
    es=edits(s)
    if len(es)<2:
        say("edits<2, relaunch fresh"); goto(URL); s=dump(); es=edits(s)
        if len(es)<2: say("FATAL: no name edits"); sys.exit(2)
    tapb(es[0]); typ("Daniel")
    s=dump(); a=[x for x in edits(s) if x.get("text")=="Daniel"]
    if not a: say("FAIL Daniel"); sys.exit(2)
    b=B(a[0]); say("Daniel@",a[0]["bounds"])
    es2=edits(s)
    last=[x for x in es2 if B(x) and B(x)[1]>b[1]]
    if not last: say("FAIL: no edit below Daniel"); sys.exit(2)
    tapb(last[0]); typ("Rowe")
    s=dump()
    ok=[x for x in edits(s) if x.get("text")=="Rowe"]
    say("Rowe:",bool(ok), [x.get('text') for x in edits(s)])
    if not ok: sys.exit(2)
    shot("/tmp/gen6-evidence-names.png",force_fresh=True)
    say("NAMES_OK")
elif MODE=="next":
    nxt=[a for a in N(s) if a.get("class")=="android.widget.Button" and a.get("text")=="Next"]
    if not nxt: say("FAIL: no Next node; dump edits",[(a.get('text'),a.get('bounds')) for a in edits(s)]); sys.exit(2)
    say("Next@",nxt[0]["bounds"])
    tapb(nxt[0]); time.sleep(3)
    if not alive(): say("DEAD after Next"); goto(URL)
    s=dump(); say("after-Next dump",len(s))
    say("texts:",[ (a.get('text') or a.get('content-desc'))[:30] for a in N(s) if (a.get('text') or a.get('content-desc')) ][:25])
