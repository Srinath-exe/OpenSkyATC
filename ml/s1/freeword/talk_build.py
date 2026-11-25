"""The round-4 exam (talk.json): corrections, questions to the crew, questions that must not become instructions, cut-off calls.
Hand-written, worded away from ml/data/plain4.py's templates, at airports its training data leaves out (WSSS, VIDP)."""
import json, random, re, sys
sys.path.insert(0, "ml/data")
from plain import digits, ONES
from plain3 import skywest, tw
rng = random.Random(99)
recs = [skywest(json.loads(l)) for ap in ("WSSS", "VIDP") for l in open(f"ml/data/out3/{ap}.jsonl")]
AIR = [  # (said, line) - corrections in the air
 ("come left zero four zero thats right zero four zero", "Turn right heading 040"), ("make it one nine zero knots oops i meant one seven zero knots", "Speed 170"), ("heading two two zero disregard that heading two four zero", "Fly heading 240"),
 ("slow down to two ten no sorry two hundred knots", "Speed 200"), ("turn left one one zero my mistake turn left one three zero", "Turn left heading 130"), ("turn right heading three three zero correction three five zero", "Turn right heading 350"),
 ("speed one eight zero actually make it one six zero", "Speed 160"), ("heading zero nine zero check that zero seven zero", "Fly heading 070"), ("turn left sorry right heading two six zero", "Turn right heading 260"), ("reduce to two twenty knots correction two three zero knots", "Speed 230")]
GND = [("hold short of november sorry i meant hold short of papa", "Hold short twy P"), ("taxi via sierra my mistake via tango and stop short of whiskey", "Taxi via T, hold short twy W"), ("hold short of yankee check that uniform", "Hold short twy U"),
 ("taxi on quebec correction romeo hold short of victor", "Taxi via R, hold short twy V"), ("hold short of lima one actually lima two", "Hold short twy L2")]
ASK_AIR = [("talk to me about the ride", "Report ride"), ("is it rough up there", "Report ride"), ("you getting knocked around much", "Report ride"), ("what have you got left in the tanks", "Report fuel"), ("give me your fuel in minutes", "Report fuel"), ("whats the head count back there", "Report pob"),
 ("remind me what heading you are on", "Report heading"), ("what altitude are you through right now", "Report altitude"), ("and what speed are you back to", "Report airspeed"), ("got the localizer alive yet", "Report established"), ("tell me what you want to do", "Report intentions"), ("i need your souls on board", "Report pob")]
ASK_GND = [("whenever youre ready just say are you ready", "Report ready"), ("all buttoned up and ready to go", "Report ready"), ("are you fully off the runway now", "Report vacated"), ("which intersection are you sitting at", "Report position")]
NEG = ["i never gave you six thousand did i", "what did the last guy assign you was it two five zero", "would one nine zero knots be doable for you", "were you looking for a left turn to three zero zero", "who told you to descend to four thousand", "reckon you can get down to five thousand in time",
 "did approach say three thousand or four thousand", "is runway two zero center what you planned on", "you werent told to cross two zero left were you", "thinking about giving you a shortcut later", "ill have something for you in a minute", "you were number three now you are number two", "sorry about the wait the arrivals are stacked up",
 "dont take that as a clearance", "ignore that it was for someone else", "i heard two people talking there"]
CUT = ["maintain", "turn to heading two", "reduce speed to one", "cleared to", "runway two zero left cleared", "start your", "pushback is", "descend and", "taxi via alpha then", "line up and"]
def pick_ac(want):
    while True:
        rec = rng.choice(recs); ls = rec["ctx"].splitlines()[1:]
        if not ls: continue
        w = rng.choice(ls).split(); i = next((k for k, x in enumerate(w) if x in ("ARR", "DEP")), None)
        if i is None: continue
        alt = next((int(x[:-2]) for x in w if x.endswith("ft")), None); air = alt is not None and alt > 1500; phase = w[i + 2] if len(w) > i + 2 else ""
        if want == "air" and not air or want == "gnd" and (air or phase not in ("taxi", "hold_short")): continue
        name = " ".join(w[1:i]); sp = " ".join(" ".join(ONES[int(c)] if c.isdigit() else c for c in x) if x[:1].isdigit() else x for x in name.split())
        return rec, w[0], sp
rows = []
def add(kind, want, xs):
    for said, line in xs:
        rec, cs, sp = pick_ac(want); rows.append({"key": f"t{len(rows)}", "style": "talk", "kind": kind, "heard": f"{sp} {said}", "ctx": rec["ctx"], "line": line if line == "SAY AGAIN" else f"{cs} {line}"})
add("correction", "air", AIR); add("correction", "gnd", GND); add("ask", "air", ASK_AIR); add("ask", "gnd", ASK_GND)
add("neg", "any", [(x, "SAY AGAIN") for x in NEG]); add("cut", "any", [(x, "SAY AGAIN") for x in CUT])
json.dump(rows, open("ml/s1/freeword/talk.json", "w"), indent=1); print(len(rows))
tr = [json.loads(l)["said"] for l in open("ml/data/out8/ds/new.jsonl")]; bod = {r["heard"].split(" ", 1)[1][-40:] for r in rows}; print("exam lines whose last 40 letters are in training:", sum(any(t.endswith(b) for t in tr) for b in bod))
