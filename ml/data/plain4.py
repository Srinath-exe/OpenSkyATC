"""Training data, round 4: how people really talk - corrections in the middle of a call, questions to the crew (as report
requests), questions that must NOT become instructions, and calls cut off before their value. Situations from the exporter
(ctx), values drawn fresh; every label is parsed by the game before it is kept (ml/data/check4.cjs). Templates here share no
line with the exams (ml/s1/freeword/*.json): a generated line that equals an exam line is dropped and counted.

    python3 ml/data/plain4.py ml/data/out3/{KBOS,OMDB,RJTT,VHHH}.jsonl --out ml/data/out8/ds
"""
import argparse, collections, json, random, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from plain import ONES, digits, level_words, pick  # noqa: E402
from plain3 import TWY, PRE, POST, skywest, tw, rw  # noqa: E402

FIX = ["correction", "correction", "sorry", "i mean", "no wait", "make that", "scratch that", "rather", "uh correction", "er no"]
Q = {  # what the crew reports: ways a controller asks for it
 "ride": ["hows the ride", "how is your ride up there", "any chop at your level", "is it smooth where you are", "getting any bumps", "what kind of ride are you getting", "any turbulence to report", "how are the rides"],
 "fuel": ["how much fuel have you got", "hows your fuel looking", "say fuel remaining", "how are you for fuel", "how much gas do you have", "how long can you hold for", "what is your endurance"],
 "pob": ["how many people on board", "say souls on board", "how many souls", "how many do you have on board", "give me the number of people on board"],
 "position": ["where are you now", "say your position", "what is your position", "where are you at", "tell me where you are"],
 "altitude": ["what altitude are you at", "whats your altitude now", "say altitude leaving", "how high are you", "say level", "what level are you passing"],
 "airspeed": ["whats your speed", "say airspeed", "how fast are you going", "say your speed now", "what speed are you showing"],
 "heading": ["whats your heading", "say heading", "what heading are you flying", "what are you heading now", "which heading have you got"],
 "ready": ["are you ready to go", "you ready for departure", "are you ready to roll", "are you all set to go", "let me know are you ready"],
 "established": ["are you established", "are you on the localizer yet", "established yet", "have you got the localizer"],
 "vacated": ["are you clear of the runway", "are you off the runway", "have you vacated", "you clear of the runway yet"],
 "reason": ["what was the reason for the go around", "whats the problem", "why did you go around", "say the reason"],
 "intentions": ["what are your intentions", "what would you like to do", "say intentions", "what do you want to do next"],
}
# questions and remarks that are no command and have no report: never an instruction, whatever value they carry
NOQ = ["are you able to climb to {v}", "would you be able to take {v}", "are you able {s} knots", "can you accept heading {h} later on", "did you say you wanted {v}", "did i give you {v}", "were you cleared to {v}",
       "who cleared you to {v}", "is that you at {v}", "have i cleared you to cross {r}", "did you read back {r}", "are you expecting {r}", "was it heading {h} i gave you", "do you want {v} or stay where you are",
       "are you able to take {t}", "would {r} work for you", "what runway were you told", "could you make {t} if i asked", "do you see the company traffic on {t}", "which way were you planning to go"]
CUT = ["climb to", "descend and maintain", "take it down to", "turn right", "fly heading", "slow to", "reduce to", "cleared for", "runway cleared for", "cleared to land runway", "line up on", "hold short of", "taxi via",
       "taxi to runway", "cross", "contact", "proceed direct to", "expect runway", "cleared for the", "cleared ils approach runway", "cleared for takeoff runway", "go to", "turn left to"]


def spoken(name, rng):
    s = " ".join(" ".join(ONES[int(c)] if c.isdigit() else c for c in x) if x[:1].isdigit() else x for x in name.split())
    if rng.random() < 0.3:
        s2 = " ".join(digits(x) if x.isdigit() else x for x in name.split()); return s2
    return s


def correction(rng, alt, air, rwys):
    f = pick(rng, FIX); k = rng.random()
    if air:
        if k < 0.30:
            a, b = rng.sample(range(5, 361, 5), 2); d, e = rng.sample(["left", "right"], 2)
            return pick(rng, [(f"turn {d} {f} {e} heading {digits(b, 3)}", f"Turn {e} heading {b:03d}"), (f"turn {d} heading {digits(a, 3)} {f} {e} heading {digits(b, 3)}", f"Turn {e} heading {b:03d}"),
                              (f"fly heading {digits(a, 3)} {f} heading {digits(b, 3)}", f"Fly heading {b:03d}"), (f"turn {d} heading {digits(a, 3)} {f} {digits(b, 3)}", f"Turn {d} heading {b:03d}")])
        if k < 0.62:
            up = [x for x in range(2000, 15001, 1000) if x > alt + 900]; dn = [x for x in range(2000, 15001, 1000) if x < alt - 900]
            c = up if (len(up) > 1 and rng.random() < 0.5) or len(dn) < 2 else dn
            if len(c) < 2: return None
            a, b = rng.sample(c, 2); w = "climb" if c is up else "descend"
            return pick(rng, [f"{w} to {level_words(a, rng)} {f} {level_words(b, rng)}", f"{w} and maintain {level_words(a, rng)} {f} {w} {level_words(b, rng)}", f"{w} {level_words(a, rng)} {f} make it {level_words(b, rng)}"]).replace("make that make it", "make that"), f"Altitude {b}"
        if k < 0.86:
            a, b = rng.sample(range(150, 251, 10), 2); return pick(rng, [f"speed {digits(a)} {f} {digits(b)}", f"reduce speed {digits(a)} {f} {digits(b)} knots", f"slow to {digits(a)} {f} {digits(b)}"]), f"Speed {b}"
        if len(rwys) < 2: return None
        a, b = rng.sample(rwys, 2); return f"cleared ils runway {rw(a, rng).replace('runway ', '').replace('the ', '')} {f} {rw(b, rng).replace('runway ', '').replace('the ', '')}", f"Cleared ILS {b}, report established"
    if k < 0.5:
        a, b, h = rng.sample(TWY, 3); return pick(rng, [f"taxi via {tw(a)} {f} {tw(b)} hold short of {tw(h)}", f"taxi via {tw(a)} {f} via {tw(b)} hold short of {tw(h)}"]), f"Taxi via {b}, hold short twy {h}"
    if k < 0.8:
        a, h = rng.sample(TWY, 2); return f"hold short of {tw(a)} {f} {tw(h)}", f"Hold short twy {h}"
    if len(rwys) < 2: return None
    a, b = rng.sample(rwys, 2); return f"cross {rw(a, rng).replace('the ', '')} {f} {rw(b, rng).replace('the ', '')}", f"Cross {b}"


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("inputs", nargs="+"); ap.add_argument("--out", default="ml/data/out8/ds"); ap.add_argument("--seed", type=int, default=41); ap.add_argument("--n", type=int, default=14000)
    a = ap.parse_args(); rng = random.Random(a.seed); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    body = lambda s: re.sub(r"^\S+( \S+){0,4}? ", "", s)
    exam = {re.sub(r"'", "", r["heard"]) for p in Path("ml/s1/freeword").glob("*.json") if p.stem in ("steps", "skywest", "indep", "stress", "held", "rows") for r in json.loads(p.read_text())}
    exam_tail = {tuple(x.split()[-6:]) for x in exam if len(x.split()) >= 9}
    recs = [skywest(json.loads(l)) for p in a.inputs for l in open(p)]; rows = []; dropped = 0
    while len(rows) < a.n:
        rec = pick(rng, recs); lines = rec["ctx"].splitlines()
        if len(lines) < 2: continue
        rwys = [r for r in lines[0].split()[1:] if r[:1].isdigit()]; w = pick(rng, lines[1:]).split(); i = next((k for k, x in enumerate(w) if x in ("ARR", "DEP")), None)
        if i is None: continue
        cs, name, phase = w[0], " ".join(w[1:i]), w[i + 2] if len(w) > i + 2 else ""; alt = next((int(x[:-2]) for x in w if x.endswith("ft")), None); air = alt is not None and alt > 1500
        k = rng.random()
        if k < 0.36:
            c = correction(rng, alt or 0, air, rwys) if air or phase in ("taxi", "hold_short", "rollout") else None
            if not c: continue
            said, line, kind = c[0], f"{cs} {c[1]}", "correction"
        elif k < 0.64:
            item = pick(rng, [x for x in Q if (air or x not in ("altitude", "airspeed", "heading", "established")) and (not air or x not in ("ready", "vacated"))]); said, line, kind = pick(rng, Q[item]), f"{cs} Report {item}", "ask"
        elif k < 0.84:
            said, line, kind = pick(rng, NOQ).format(v=level_words(rng.randrange(2000, 15001, 1000), rng), s=digits(rng.randrange(150, 251, 10)), h=digits(rng.randrange(5, 361, 5), 3), r=rw(pick(rng, rwys or ["27"]), rng), t=tw(pick(rng, TWY))), "SAY AGAIN", "sayAgain"
        else: said, line, kind = pick(rng, CUT), "SAY AGAIN", "sayAgain"
        if kind != "sayAgain": said = pick(rng, PRE) + said + pick(rng, POST)
        said = re.sub(r"\s+", " ", f"{spoken(name, rng)} {said}".replace("'", "")).strip()
        if said in exam or tuple(said.split()[-6:]) in exam_tail: dropped += 1; continue
        rows.append({"key": f"q{len(rows)}", "ctx": rec["ctx"], "said": said, "heard": said, "line": line, "kind": kind, "src": "plain4", "icao": rec["icao"], "gate": True})
    (out / "unchecked.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    print(len(rows), collections.Counter(r["kind"] for r in rows), "equal to an exam line, dropped:", dropped)
    for r in rng.sample(rows, 16): print(" ", r["said"], " => ", r["line"])


if __name__ == "__main__": main()
