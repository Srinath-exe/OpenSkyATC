"""The gate's fourth fitting set, trainP (ml/verify/out/trainP.in.jsonl): everyday wording. The first three are book phrasing
(Nov 8), so a gate fitted on them alone distrusts calls like "take it down to six thousand" however right the model is.

  out5/ds/val_plain.jsonl    everyday wording of validation sessions (seed 4): no S1 model trained on these lines
  out8/gate/new.jsonl        step-by-step taxi and looser wording, fresh seed (ml/data/plain3.py --seed 44)
Half as written, half with recogniser damage (a misheard digit, a lost or added word, a cut-off tail). The exams in
ml/s1/freeword are never read; lines whose words equal a training line of out7 are dropped.

    python3 ml/verify/make_plain.py
"""
import json, random, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]; sys.path[:0] = [str(ROOT / "ml/data"), str(ROOT / "ml/verify")]
from make_sets import DIGIT_CONFUSE, COMMON, OUT  # noqa: E402
import re
rng = random.Random(11)
def skw(r):
    r = dict(r); r["ctx"] = re.sub(r"\bskw(\d)", r"skywest \1", r["ctx"])
    r["said"] = re.sub(r"\s+", " ", re.sub(r"\bsierra kilo (?:(?:uh|um|ah|er) )?whisk(?:ey|y)\b|\bskw(?=[ \d])", "skywest", r["said"])); return r
def damage(s):
    w = s.split()
    if rng.random() < 0.22:
        idx = [i for i, x in enumerate(w) if x in DIGIT_CONFUSE]
        if idx: i = rng.choice(idx); w[i] = rng.choice(DIGIT_CONFUSE[w[i]])
    if rng.random() < 0.10 and len(w) > 3: w.pop(rng.randrange(1, len(w)))
    if rng.random() < 0.08: w.insert(rng.randrange(len(w) + 1), rng.choice(COMMON))
    if rng.random() < 0.06 and len(w) > 4: w = w[: rng.randrange(3, len(w))]
    return " ".join(w)
seen = {json.loads(l)["said"] for l in open(ROOT / "ml/data/out7/ds/pool.jsonl")}
rows = [skw(json.loads(l)) for l in open(ROOT / "ml/data/out5/ds/val_plain.jsonl")] + [json.loads(l) for l in open(ROOT / "ml/data/out8/gate/new.jsonl")]
rows = [r for r in rows if r["said"] not in seen]; rng.shuffle(rows)
out = [{"id": i, "set": "trainP", "ctx": r["ctx"], "said": damage(r["said"]) if i % 2 else r["said"], "line": r["line"], "kind": r["kind"], "icao": r["icao"]} for i, r in enumerate(rows)]
(OUT / "trainP.in.jsonl").write_text("\n".join(json.dumps(r) for r in out) + "\n")
print(len(out), "rows", sum(r["line"] == "SAY AGAIN" for r in out), "say again")
