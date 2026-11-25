#!/usr/bin/env python3
"""OpenStreetMap data round an airport, in tiles from the main OSM API (small, occasional use).
  python3 scripts/ground/fetch.py ICAO out_dir [pad_deg]     prints the bbox and the aerodrome relations / ways found"""
import json, os, sys, urllib.request, urllib.error, concurrent.futures as cf
ICAO, OUT = sys.argv[1], sys.argv[2]; PAD = float(sys.argv[3]) if len(sys.argv) > 3 else 0.008
os.makedirs(OUT, exist_ok=True)
xs, ys = [], []
def v(c):
    if isinstance(c[0], (int, float)): xs.append(c[0]); ys.append(c[1])
    else: [v(x) for x in c]
for f in json.load(open(f'/root/atc/public/maps/osm/{ICAO}.geojson'))['features']: v(f['geometry']['coordinates'])
W, S, E, N = min(xs) - PAD, min(ys) - PAD, max(xs) + PAD, max(ys) + PAD
UA = {'User-Agent': 'map-check/1.0'}
def get(w, s, e, n, tag, depth=0):
    f = f'{OUT}/{tag}.json'
    if os.path.exists(f): return []
    for k in range(3):
        try:
            b = urllib.request.urlopen(urllib.request.Request(f'https://api.openstreetmap.org/api/0.6/map.json?bbox={w:.5f},{s:.5f},{e:.5f},{n:.5f}', headers=UA), timeout=90).read(); open(f, 'wb').write(b); return []
        except urllib.error.HTTPError as ex:
            if ex.code == 400 and depth < 3:
                mx, my = (w + e) / 2, (s + n) / 2
                return sum((get(*c, tag + str(i), depth + 1) for i, c in enumerate([(w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)])), [])
            err = ex.code
        except Exception as ex: err = str(ex)[:40]
    return [(tag, err)]
nx, ny = max(2, round((E - W) / 0.018)), max(2, round((N - S) / 0.014))
with cf.ThreadPoolExecutor(4) as p:
    bad = sum((f.result() for f in [p.submit(get, W + (E - W) * i / nx, S + (N - S) * j / ny, W + (E - W) * (i + 1) / nx, S + (N - S) * (j + 1) / ny, f'{i:02d}{j:02d}') for i in range(nx) for j in range(ny)]), [])
rel, ways = {}, {}
for f in os.listdir(OUT):
    for e in json.load(open(f'{OUT}/{f}'))['elements']:
        t = e.get('tags', {})
        if e['type'] == 'relation' and (t.get('aeroway') == 'aerodrome' or t.get('natural') == 'water' or t.get('natural') == 'coastline'): rel[e['id']] = e
        if e['type'] == 'way' and t.get('aeroway') == 'aerodrome': ways[e['id']] = t
for i, r in rel.items():     # whole outlines, not only the part inside the box
    f = f'{OUT}/rel{i}.json'
    if len(r['members']) < 400 and not os.path.exists(f):
        try: open(f, 'wb').write(urllib.request.urlopen(urllib.request.Request(f'https://api.openstreetmap.org/api/0.6/relation/{i}/full.json', headers=UA), timeout=90).read())
        except Exception as ex: bad.append((i, str(ex)[:40]))
print(ICAO, f'bbox {W:.4f},{S:.4f},{E:.4f},{N:.4f}', 'failed', bad, 'aerodromes', [(i, r['tags'].get('name'), len(r['members'])) for i, r in rel.items() if r['tags'].get('aeroway')], [(i, t.get('name')) for i, t in ways.items()])
