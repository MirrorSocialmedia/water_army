#!/usr/bin/env python3
# probe: fill names, then test scroll behaviour, all in one page-load (no SF-kill)
import sys, time
sys.path.insert(0,"/home/kenneth/.openclaw/workspace/water_army/docs/audits/d4/scripts")
from d4reg2_fill2_lib import *  # noqa
def main():
    if not alive():
        say("relaunch"); goto(URL); s=dump()
    else:
        s=dump()
    say("start edits:",[(a.get('text'),a.get('bounds')) for a in edits(s)])
    es=edits(s)
    if len(es)<2: say("FATAL no edits"); return
    tapb(es[0]); typ("Daniel")
    s=dump(); a=[x for x in edits(s) if x.get("text")=="Daniel"]
    if not a: say("FAIL Daniel"); return
    es2=edits(s); below=[x for x in es2 if B(x) and B(x)[1]>B(a[0])[1]]
    tapb(below[0]); typ("Rowe")
    s=dump(); say("after names:",[x.get('text') for x in edits(s)])
    for i in range(3):
        sh("input swipe 540 1250 540 450 400"); time.sleep(1.0)
        s=dump()
        es3=[(a.get('text'),a.get('bounds')) for a in edits(s)]
        bday=[(a.get('text') or a.get('content-desc'))[:22] for a in N(s) if re.search("Birthday|Month|Gender|male|Female", (a.get('text') or '')+(a.get('content-desc') or ''))]
        say(f"swipe{i+1}: edits={es3} bday/gender={bday}")
main()
