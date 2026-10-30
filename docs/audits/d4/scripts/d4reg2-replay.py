#!/usr/bin/env python3
# WA-D4 gen6: replay basic signup flow to the device-check wall with evidence screenshots (no mid-flow SF-kill)
import sys, time, json
sys.path.insert(0,"/home/kenneth/.openclaw/workspace/water_army/docs/audits/d4/scripts")
from d4reg2_fill2_lib import *
SHOTDIR="/tmp"
def sp(name):  # quick screencap during fresh burst
    p=f"{SHOTDIR}/d4reg2-gm-{name}.png"
    open(p,"wb").write(adb("exec-out","screencap","-p")); say("SHOT",p)
def step_dumps(pat):
    s=dump()
    return [a for a in N(s) if re.search(pat,(a.get('text') or '')+(a.get('content-desc') or ''),re.I)]
pw=json.load(open("/home/kenneth/.openclaw/workspace/water_army/secrets/gacct-pilot-003.json"))["password"]
assert alive(), "webview not alive"
s=dump()
assert "Enter your name" in s, "not at name step"
sp("08-namestep")
es=edits(s); tapb(es[0]); typ("Daniel")
s=dump(); d=[x for x in edits(s) if x.get("text")=="Daniel"]; b=B(d[0])
es2=edits(s); last=[x for x in es2 if B(x) and B(x)[1]>b[1]]; tapb(last[0]); typ("Rowe")
s=dump()
assert any(x.get("text")=="Rowe" for x in edits(s)), "Rowe missing"
nxt=step_dumps("^Next$"); tapb(nxt[0]); time.sleep(4)
s=dump()
assert "birthday" in (s or "").lower(), "not birthday step"
sp("09-birthday")
sp1=[a for a in N(s) if a.get("class")=="android.widget.Spinner" and "English" not in (a.get("text") or "")]
tapb(sp1[0]); time.sleep(1.2)
s=dump(mini=3000); mar=[a for a in N(s) if a.get("text")=="March"]
assert mar, "no March option"; tapb(mar[0]); time.sleep(1.2)
s=dump()
dayy=[a for a in edits(s) if B(a) and 700<B(a)[1]<950 and not (a.get("text") or "").startswith("http")]
dayy=sorted(dayy,key=lambda a:B(a)[0])
if len(dayy)<2:
    # day/year not yet exposed; tap Next-less path: select gender first via Spinner
    pass
say("dayyr:",[(a.get('text'),a.get('bounds')) for a in dayy])
tapb(dayy[0]); typ("14")
s=dump(); yr=[a for a in edits(s) if B(a) and B(a)[0]>600 and 700<B(a)[1]<950]
tapb(yr[0]); typ("1991")
s=dump()
gen=[a for a in N(s) if a.get("class")=="android.widget.Spinner" and "English" not in (a.get("text") or "") and "March" not in (a.get("text") or "")]
tapb(gen[0]); time.sleep(1.2)
s=dump(mini=3000); male=[a for a in N(s) if a.get("text")=="Male"]
assert male, "no Male option"; tapb(male[0]); time.sleep(1.2)
s=dump(); nxt=step_dumps("^Next$"); tapb(nxt[0]); time.sleep(4)
s=dump()
assert "Gmail address" in s, "not username step: "+repr([a.get('text') for a in N(s) if a.get('text')][:6])
sp("10-username")
eu=[a for a in edits(s) if B(a) and 780<B(a)[1]<980 and B(a)[0]<200]
tapb(eu[0]); typ("danielrowe7144"); time.sleep(1)
s=dump(); nxt=step_dumps("^Next$"); tapb(nxt[0]); time.sleep(5)
s=dump()
assert "strong password" in s, "not password step: "+repr([a.get('text') for a in N(s) if a.get('text')][:6])
sp("11-password")
ep=sorted([a for a in edits(s) if B(a) and 780<B(a)[1]<1200 and B(a)[0]<200],key=lambda a:B(a)[1])
tapb(ep[0]); typ(pw)
s=dump(); ep2=[a for a in edits(s) if B(a) and 780<B(a)[1]<1200 and B(a)[0]<200 and not (a.get("text") or "")]
tapb(ep2[0]); typ(pw)
s=dump(); nxt=step_dumps("^Next$"); tapb(nxt[0]); time.sleep(5)
s=dump()
wall = "Verify some info" in s or "device check" in s
sp("12-devicecheck-wall")
print("WALL_HIT" if wall else "NO_WALL_STILL_PROGRESSING")
print("STATE:",repr([a.get('text') for a in N(s) if a.get('text')][:12]))
