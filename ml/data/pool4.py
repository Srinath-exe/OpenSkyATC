"""Round-4 training pool: all of plain4 (14,000), part of round 3's new lines and a sample of the older pool, so nothing learned
before is forgotten.   python3 ml/data/pool4.py -> ml/data/out8/ds/pool.jsonl"""
import json, random
rng = random.Random(4); D = "ml/data/out8/ds"
new = [l.strip() for l in open(f"{D}/new.jsonl")]; r3 = [l.strip() for l in open("ml/data/out7/ds/new.jsonl")]; keys = set(r3)
old = [l.strip() for l in open("ml/data/out7/ds/pool.jsonl") if l.strip() not in keys]; rng.shuffle(r3); rng.shuffle(old)
pool = new + r3[:14000] + old[:26000]; rng.shuffle(pool); open(f"{D}/pool.jsonl", "w").write("\n".join(pool) + "\n"); print(len(new), min(14000, len(r3)), min(26000, len(old)), "pool", len(pool))
