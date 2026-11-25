#!/usr/bin/env python3
"""
One-time download of an airport area's open map tiles (OpenStreetMap data via OpenFreeMap, OpenMapTiles schema, ODbL)
and the label fonts, so the airport lab runs without any map API:

  public/maps/offline/<ICAO>/{z}/{x}/{y}.pbf     vector tiles, zoom 0-14, the bbox only
  public/maps/offline/fonts/<font>/<range>.pbf   glyphs for the labels

    python3 scripts/maps/fetch_offline.py KSFO -122.53 37.54 -122.26 37.72
"""
import json, math, sys, time, urllib.request
from pathlib import Path

icao, w, s, e, n = sys.argv[1], *map(float, sys.argv[2:6])
OUT = Path('public/maps/offline'); UA = {'User-Agent': 'openatc-offline-fetch'}
tj = json.load(urllib.request.urlopen(urllib.request.Request('https://tiles.openfreemap.org/planet', headers=UA)))
tmpl = tj['tiles'][0]

def tile(lon, lat, z):
    x = int((lon + 180) / 360 * 2 ** z); r = math.radians(lat)
    y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)
    return x, y

def get(url, dest: Path):
    if dest.exists() and dest.stat().st_size:
        return 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
            dest.write_bytes(data); time.sleep(0.05); return len(data)
        except Exception as ex:
            if attempt == 3: print('  failed', url, ex)
            time.sleep(1 + attempt)
    return 0

total = n_tiles = 0
for z in range(0, 15):
    x0, y0 = tile(w, n, z); x1, y1 = tile(e, s, z)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            total += get(tmpl.replace('{z}', str(z)).replace('{x}', str(x)).replace('{y}', str(y)), OUT / icao / str(z) / str(x) / f'{y}.pbf'); n_tiles += 1
print(f'{icao}: {n_tiles} tiles, {total / 1e6:.1f} MB new')
fb = 0
for font in ('Noto Sans Regular', 'Noto Sans Bold'):
    for r0 in (0, 256, 512, 768, 8192, 8448):
        rng = f'{r0}-{r0 + 255}'
        fb += get(f'https://tiles.openfreemap.org/fonts/{urllib.request.quote(font)}/{rng}.pbf', OUT / 'fonts' / font / f'{rng}.pbf')
print(f'fonts: {fb / 1e3:.0f} KB new')
(OUT / icao / 'source.json').write_text(json.dumps({'source': tj['tiles'][0], 'attribution': '© OpenMapTiles © OpenStreetMap contributors', 'bbox': [w, s, e, n], 'maxzoom': 14}))
