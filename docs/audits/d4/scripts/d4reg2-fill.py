#!/usr/bin/env python3
# WA-D4 gen6: fill Google basic signup form step by step (dump-verified, no blind taps)
import re, subprocess, sys, time
ADB="/home/kenneth/.openclaw/workspace/tools/platform-tools/adb"; SER="127.0.0.1:15001"
def adb(*a,timeout=20):
    r=subprocess.run([ADB,"-s",SER]+list(a),capture_output=True,timeout=timeout); return r.stdout
def sh(s,timeout=20): return adb("shell",s,timeout=timeout)
def dump(retries=6):
    for _ in range(retries):
        s=sh("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml").decode("utf-8","replace")
        if len(s)>9000: return s
        time.sleep(1.5)
    return s
def N(s):
    return [dict(re.findall(r'(\w+)="([^"]*)"',m.group(1))) for m in re.finditer(r'<node ([^>]*?)/?>',s)]
def edits(s):
    return [a for a in N(s) if a.get("class")=="android.widget.EditText" and a.get("bounds")!="[0,121][794,240]"]
def bounds(b):
    m=re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]",b); return list(map(int,m.groups())) if m else None
def label_bottom(s,text):
    for a in N(s):
        t=(a.get("text") or "")+(a.get("content-desc") or "")
        if re.search(text,t,re.I):
            b=bounds(a.get("bounds"));
            if b: return b[3]
def edit_by_text(s,pat):
    for a in edits(s):
        if re.search(pat,a.get("text") or "",re.I): return a
def tap(x,y): sh(f"input tap {x} {y}"); time.sleep(1.0)
def typ(t): sh(f"input text {t}"); time.sleep(0.5)
def say(*a): print(*a,flush=True)

step=sys.argv[1] if len(sys.argv)>1 else "names"
s=dump()
say("edits:",[(a.get("text"),a.get("bounds")) for a in edits(s)])
if step=="names":
    es=edits(s)
    if len(es)<2: say("FAIL: need 2 empty edits, got",len(es)); sys.exit(2)
    b0=bounds(es[0]["bounds"])
    say("first edit:",es[0]["bounds"])
    tap((b0[0]+b0[2])//2, (b0[1]+b0[3])//2); typ("Daniel")
    s=dump(); a=edit_by_text(s,"Daniel")
    if not a: say("FAIL: Daniel not in any edit"); sys.exit(2)
    say("Daniel node:",a["bounds"])
    b=bounds(a["bounds"])
    tap(540, b[3]+130)           # field below First name = Last name (keyboard-open layout)
    typ("Rowe")
    s=dump(); a=edit_by_text(s,"^Rowe$")
    if not a:
        a=edit_by_text(s,"Rowe")
        say("WARN Rowe state:",a["bounds"] if a else None,(a or {}).get("text"))
    else: say("Rowe node:",a["bounds"])
    sh("input keyevent 111"); time.sleep(0.8)
    say("NAMES_DONE")
elif step=="birthday":
    s=dump(); say("edits now:",[(a.get("text"),a.get("bounds")) for a in edits(s)])
