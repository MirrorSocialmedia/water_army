#!/usr/bin/env python3
"""WA-D4 gen6 WebView-shell driver: dump-driven taps with retry (zombie-display safe).
Usage: d4reg2-drive.py <cmd> [args]
cmds:
  nodes <regex>          print nodes matching text/desc regex: class|text|bounds|focused
  tapnode <regex>        tap center of first node matching text regex (retry up to 6x)
  tap <x> <y>
  type <text>            adb input text (no spaces)
  keys <code...>         batched keyevents
  goto <url>             am start VIEW url (cold if needs)
  shot <path>            screencap (freshness double-check; SF-kill once if frozen)
"""
import re, subprocess, sys, time
ADB="/home/kenneth/.openclaw/workspace/tools/platform-tools/adb"
SER="127.0.0.1:15001"
def adb(*args,**kw):
    cmd=[ADB,"-s",SER]+list(args)
    r=subprocess.run(cmd,capture_output=True,timeout=kw.get("timeout",20))
    return r.returncode, r.stdout, r.stderr
def sh(script,timeout=20):
    return adb("shell",script,timeout=timeout)[1]
def dump():
    for _ in range(6):
        s=sh("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml").decode("utf-8","replace")
        if len(s)>9000: return s
        time.sleep(1.5)
    return s
def nodes(s):
    for m in re.finditer(r'<node ([^>]*?)/?>',s):
        yield dict(re.findall(r'(\w+)="([^"]*)"',m.group(1)))
def find(pat,timeout=15):
    t0=time.time()
    while time.time()-t0<timeout:
        s=dump()
        for a in nodes(s):
            t=(a.get("text") or "")+(a.get("content-desc") or "")
            if t and re.search(pat,re.escape(t),re.I):
                yield a
        if time.time()-t0<timeout: time.sleep(1.5)
def center(b):
    m=re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]",b)
    x1,y1,x2,y2=map(int,m.groups()); return (x1+x2)//2,(y1+y2)//2
def main():
    cmd=sys.argv[1]
    if cmd=="nodes":
        for a in find(sys.argv[2],timeout=5):
            print(a.get("class","").split(".")[-1],"|",repr(a.get("text") or a.get("content-desc"))[:40],"|",a.get("bounds"),"| focus=",a.get("focused"))
    elif cmd=="tapnode":
        hit=None
        for a in find(sys.argv[2]):
            hit=a; break
        if not hit: print("NOTFOUND"); sys.exit(2)
        x,y=center(hit["bounds"])
        sh(f"input tap {x} {y}"); time.sleep(1.0)
        print("TAPPED",hit.get("bounds"),repr((hit.get('text') or ''))[:30])
    elif cmd=="tap":
        sh(f"input tap {sys.argv[2]} {sys.argv[3]}"); time.sleep(0.8); print("OK")
    elif cmd=="type":
        sh(f"input text {sys.argv[2]}"); time.sleep(0.4); print("OK")
    elif cmd=="keys":
        sh("input keyevent "+" ".join(sys.argv[2:])); time.sleep(0.5); print("OK")
    elif cmd=="goto":
        adb("shell","am","start","-a","android.intent.action.VIEW","-d",sys.argv[2],"-n","org.chromium.webview_shell/.WebViewBrowserActivity")
        time.sleep(9); print("OK")
    elif cmd=="shot":
        p=sys.argv[2]
        def grab():
            _,png,_=adb("exec-out","screencap","-p")
            return png
        a=grab()
        if len(a)<40000:  # likely frozen flat frame
            sh("pkill -9 -f surfaceflinger"); time.sleep(6)
            a=grab()
        open(p,"wb").write(a); print(len(a),"bytes ->",p)
if __name__=="__main__":
    main()
