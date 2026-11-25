"""Training data, round 3: step-by-step taxi (TaxiAst.limit: "cross 28R, hold short of K", "taxi via B, hold short of H")
and looser airborne wording, plus the lines that must NOT become commands. Situations from the exporter (ctx), values drawn
fresh; every label is parsed by the game before it is kept (ml/data/check3.ts). Templates here share no line with the exam
(ml/s1/freeword/steps.json; the airports it uses, WSSS and VIDP, are left out too).

    python3 ml/data/plain3.py ml/data/out3/{KBOS,OMDB,RJTT,VHHH}.jsonl --out ml/data/out7/ds
"""
import argparse, json, random, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from plain import CLIMB, DESCEND, HDG, HDG_DIR, SLOW, FAST, ONES, digits, level_words, pick  # noqa: E402

PH = dict(A="alpha", B="bravo", C="charlie", D="delta", E="echo", F="foxtrot", G="golf", H="hotel", J="juliett", K="kilo", L="lima", M="mike", N="november", P="papa", Q="quebec", R="romeo", S="sierra", T="tango", U="uniform", V="victor", W="whiskey", Y="yankee", Z="zulu")
TWY = list(PH) * 3 + [f"{l}{d}" for l in "ABCEFKMNSVWZ" for d in (1, 2, 4, 5, 8)]
def tw(t): return PH[t[0]] + (" " + " ".join(ONES[int(c)] for c in t[1:]) if t[1:] else "")
def rw(r, rng):
    s = " ".join(ONES[int(c)] for c in r if c.isdigit()); side = {"L": " left", "R": " right", "C": " center"}.get(r[-1], "")
    return pick(rng, ["", "runway ", "runway ", "the "]) + s + side if side else pick(rng, ["runway ", "runway ", ""]) + s + side

GO = ["taxi", "continue taxi", "proceed", "go", "continue", "carry on", "taxi now"]
ON = ["via {a}", "on {a}", "along {a}", "by {a}", "using {a}"]
HS = ["hold short of {h}", "holding short of {h}", "hold short {h}", "and hold short of {h}", "then hold short of {h}", "hold at {h}", "and hold at {h}", "stop short of {h}", "and stop at {h}", "wait at {h}", "and wait short of {h}", "to hold short of {h}"]
UNTIL = ["until {h}", "up to {h}", "as far as {h}", "till {h}", "down to {h}"]
TO = ["taxi to {h}", "taxi up to {h}", "go to {h}", "go to {h} and hold", "go to {h} and hold there", "proceed to {h} and hold", "taxi to {h} and hold short", "taxi hold short of {h}", "continue to {h}", "taxi to {h} and wait", "move up to {h}", "make your way to {h}", "head to {h} and hold"]
X = ["cross {r}", "cross {r}", "cleared to cross {r}", "you can cross {r}", "go ahead and cross {r}", "cross over {r}", "you're clear to cross {r}"]
LINK = [" ", " ", " and ", " then ", " and then "]
REP = ["", "", "", "", " and report", " and call me", " report holding", " let me know when you're there", " call me there", " and advise"]
TURN = ["turn left on {a}", "turn right on {a}", "left on {a}", "right on {a}", "left turn {a}", "right turn onto {a}", "turn left at {a}", "take {a}", "make a right on {a}"]
PRE = ["", "", "", "", "okay ", "uh ", "and ", "alright ", "now "]
POST = ["", "", "", "", " please", " thanks", " for now", " thank you"]

def ground(rng, rwys):
    a, b, h = rng.sample(TWY, 3); k = rng.random()
    if k < 0.22: return pick(rng, TO).format(h=tw(h)) + pick(rng, REP), f"Taxi hold short twy {h}"
    if k < 0.47:
        via = pick(rng, [pick(rng, GO) + " " + pick(rng, ON), pick(rng, TURN), pick(rng, GO) + " " + pick(rng, ON)]).format(a=tw(a))
        return via + " " + pick(rng, HS + UNTIL).format(h=tw(h)) + pick(rng, REP), f"Taxi via {a}, hold short twy {h}"
    if k < 0.58:
        return pick(rng, GO) + " " + pick(rng, ON).format(a=tw(a)) + pick(rng, [" ", " then ", " and ", " "]) + tw(b) + " " + pick(rng, HS).format(h=tw(h)) + pick(rng, REP), f"Taxi via {a}, {b}, hold short twy {h}"
    if k < 0.78 and rwys:
        r = pick(rng, rwys); return pick(rng, X).format(r=rw(r, rng)) + pick(rng, LINK) + pick(rng, HS).format(h=tw(h)) + pick(rng, REP), f"Taxi cross {r}, hold short twy {h}"
    if k < 0.86 and rwys:
        r = pick(rng, rwys); return pick(rng, X).format(r=rw(r, rng)), f"Cross {r}"
    if k < 0.92: return pick(rng, ["hold short of {h}", "hold short {h}", "hold short of taxiway {h}"]).format(h=tw(h)), f"Hold short twy {h}"
    if k < 0.97: return pick(rng, ["taxi to the gate", "taxi to your gate", "taxi to parking", "go to your gate", "continue to the gate", "taxi to your stand", "head for the gate"]), "Taxi"
    return pick(rng, ["taxi to the gate via {a}", "go via {a} to your gate", "taxi via {a} to parking"]).format(a=tw(a)), f"Taxi via {a}"

DN = ["reduce altitude to {v}", "lower your altitude to {v}", "decrease altitude to {v}", "drop your altitude to {v}", "get down to {v}", "i need you at {v}", "make your altitude {v}", "set your altitude {v}", "take her down to {v}", "let down to {v}", "sink to {v}", "come on down to {v}", "i'd like you down at {v}", "altitude {v}", "go down now to {v}", "down you go to {v}", "want you at {v}"]
UPW = ["increase altitude to {v}", "raise your altitude to {v}", "bring your altitude up to {v}", "get up to {v}", "i need you at {v}", "make your altitude {v}", "set your altitude {v}", "take her up to {v}", "altitude {v}", "climb on to {v}", "i'd like you up at {v}", "want you at {v}", "up you go to {v}"]
SPD = ["cut your speed to {v}", "reduce your speed to {v}", "bring your speed back to {v}", "slow it to {v}", "slow it down to {v}", "back to {v} knots", "pull it back to {v} knots", "give me {v} knots", "make it {v} knots", "take it back to {v}", "i need {v} knots from you", "your speed {v}", "set speed {v}", "hold {v} knots", "do {v} knots"]
HD = ["head {v}", "go heading {v}", "steer {v}", "make it heading {v}", "set heading {v}", "take heading {v}", "i need you on heading {v}", "turn it to {v}", "roll out on {v}"]
HDD = ["swing {d} heading {v}", "take it {d} to {v}", "bring it {d} heading {v}", "go {d} heading {v}", "come {d} to heading {v}", "bank {d} to {v}", "make a {d} to {v}", "swing {d} to {v}"]
LAND = ["you can land on {r}", "you're good to land {r}", "go ahead and land {r}", "cleared to land {r}", "you may land {r}", "land {r} you're cleared", "okay to land {r}"]
ILS = ["clear for the ils {r}", "cleared for the ils {r}", "take the ils {r}", "you're cleared ils {r}", "you can take the ils {r}", "go ahead with the ils {r}", "cleared for approach ils {r}"]

def airborne(rng, alt, arr, rwys, phase):
    k = rng.random()
    if k < 0.45:
        ft = rng.choice([x for x in range(2000, 15001, 1000) if abs(x - alt) >= 900] or [5000])
        return pick(rng, (UPW + CLIMB[:4]) if ft > alt else (DN + DESCEND[:4])).format(v=level_words(ft, rng) + pick(rng, ["", "", " feet"])).replace("level feet", "level"), f"Altitude {ft}"
    if k < 0.62: v = rng.randrange(150, 251, 10); return pick(rng, SPD + SLOW[:3]).format(v=digits(v)), f"Speed {v}"
    if k < 0.85 or not (arr and rwys):
        h = rng.randrange(10, 361, 5); v = digits(h, 3)
        if rng.random() < 0.5: d = rng.choice(["left", "right"]); return pick(rng, HDD + HDG_DIR[:2]).format(d=d, v=v), f"Turn {d} heading {h:03d}"
        return pick(rng, HD + HDG[:3]).format(v=v), f"Fly heading {h:03d}"
    r = pick(rng, rwys); w = rw(r, rng).replace("the ", "")
    if phase == "approach" and rng.random() < 0.5: return pick(rng, LAND).format(r=w), f"Cleared to land {r}"
    return pick(rng, ILS).format(r=w), f"Cleared ILS {r}, report established"

NEG = ["do not cross {r}", "don't cross {r}", "are you clear of {r}", "have you crossed {r}", "are you holding short of {h}", "don't taxi yet", "do not descend", "did you descend to {v}", "what's your altitude", "can you see the traffic ahead", "is that you on {h}", "hold on a second", "i'll call you back", "which taxiway are you on", "say your position", "you're not cleared to cross", "where are you going", "how far are you from {h}", "don't go past {h}", "i have not cleared you", "what heading are you on", "why are you stopped", "are you ready", "nice landing", "keep an eye on the traffic", "did you copy the hold short"]

def skywest(r):
    """SkyWest's radio name came to the game after the first exports, which spell it ("skw865", "sierra kilo whiskey")."""
    r["ctx"] = re.sub(r"\bskw(\d)", r"skywest \1", r["ctx"])
    for k in ("said", "heard"):
        if k in r: r[k] = re.sub(r"\bsierra kilo (?:(?:uh|um|ah|er) )?whisk(?:ey|y)\b|\bskw(?=[ \d])", "skywest", r[k]).replace("skywest", "skywest ").replace("  ", " ")
    return r

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("inputs", nargs="+"); ap.add_argument("--out", default="ml/data/out7/ds"); ap.add_argument("--seed", type=int, default=3); ap.add_argument("--n", type=int, default=26000)
    a = ap.parse_args(); rng = random.Random(a.seed); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    exam = {re.sub(r"^\S+( \S+){0,4}? ", "", r["heard"]) for r in json.loads(Path("ml/s1/freeword/steps.json").read_text())}
    recs = [skywest(json.loads(l)) for p in a.inputs for l in open(p)]; rows = []; sk = [r for r in recs if "SKW" in r["ctx"]]
    while len(rows) < a.n:
        want_sk = rng.random() < 0.14; rec = pick(rng, sk if want_sk else recs); lines = rec["ctx"].splitlines(); rwys = [r for r in lines[0].split()[1:] if r[:1].isdigit()]
        sl = [x for x in lines[1:] if x.startswith("SKW")]; l = pick(rng, sl) if want_sk and sl else pick(rng, lines[1:]) if len(lines) > 1 else None
        if not l: continue
        w = l.split(); i = next((k for k, x in enumerate(w) if x in ("ARR", "DEP")), None)
        if i is None: continue
        cs, name, arr, phase = w[0], " ".join(w[1:i]), w[i] == "ARR", w[i + 2] if len(w) > i + 2 else ""
        spoken = " ".join(digits(x) if x.isdigit() else " ".join(ONES[int(c)] if c.isdigit() else c for c in x) if x[:1].isdigit() else x for x in name.split())
        if rng.random() < 0.15: spoken = re.sub(r"(\w+) (\w+)$", r"\1 \2", spoken)
        alt = next((int(x[:-2]) for x in w if x.endswith("ft")), None)
        if rng.random() < 0.10: said, line = pick(rng, NEG).format(r=rw(pick(rng, rwys or ["27"]), rng), h=tw(pick(rng, TWY)), v=level_words(4000, rng)), "SAY AGAIN"
        elif alt is None and phase in ("taxi", "hold_short", "rollout"): said, line = ground(rng, rwys); line = f"{cs} {line}"
        elif alt is not None and alt > 1500: said, line = airborne(rng, alt, arr, rwys, phase); line = f"{cs} {line}"
        else: continue
        if line != "SAY AGAIN": said = pick(rng, PRE) + said + pick(rng, POST)
        said = re.sub(r"\b(and|then)( \1)+\b", r"\1", said); said = re.sub(r"\s+", " ", f"{spoken} {said}".replace("'", "")).strip()
        rows.append({"key": f"z{len(rows)}", "ctx": rec["ctx"], "said": said, "heard": said, "line": line, "kind": "step" if "Taxi" in line or "Cross" in line or "Hold short" in line else "sayAgain" if line == "SAY AGAIN" else "air", "src": "plain3", "icao": rec["icao"], "gate": True})
    (out / "new.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    old = [l for l in open("ml/data/out6/ds/pool.jsonl")]; rng.shuffle(old)
    keep = [json.dumps(skywest(json.loads(l))) for l in old[: int(a.n * 1.5)]]
    pool = [json.dumps(r) for r in rows] + [l.strip() for l in keep]; rng.shuffle(pool); (out / "pool.jsonl").write_text("\n".join(pool))
    import collections; print(len(rows), collections.Counter(r["kind"] for r in rows), "old", len(keep), "pool", len(pool)); print("\n".join(f"{r['said']}  =>  {r['line']}" for r in rows[:14]))
if __name__ == "__main__": main()
