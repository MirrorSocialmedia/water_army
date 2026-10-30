import re, subprocess, sys, time
ADB="/home/kenneth/.openclaw/workspace/tools/platform-tools/adb"; SER="127.0.0.1:15001"
URL="https://accounts.google.com/signup"
def adb(*a,timeout=25):
    r=subprocess.run([ADB,"-s",SER]+list(a),capture_output=True,timeout=timeout); return r.stdout
def sh(s,timeout=25): return adb("shell",s,timeout=timeout)
def say(*x): print(*x,flush=True)
def focus(): return sh("dumpsys window | grep -m1 mCurrentFocus").decode()
def alive(): return "webview_shell" in focus()
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
def edits(s):
    return [a for a in N(s) if a.get("class")=="android.widget.EditText" and not (a.get("text") or "").startswith("http")]
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
