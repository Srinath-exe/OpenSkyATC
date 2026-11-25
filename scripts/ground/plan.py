#!/usr/bin/env python3
"""The real ground of an airport (shoreline, grass, landside districts, roads, tunnel mouths, piers) from OpenStreetMap,
for components/atc/MapboxMap/groundPlan.ts. Map data (c) OpenStreetMap contributors, ODbL.

  python3 scripts/ground/plan.py RJTT <folder of api.openstreetmap.org map.json tiles> <aerodrome relation id>
"""
import numpy as np
import json, glob, math, sys, heapq, collections
from shapely.geometry import LineString, MultiLineString, Polygon, MultiPolygon, Point, box
from shapely.ops import polygonize, unary_union, linemerge
from shapely.prepared import prep
from shapely.strtree import STRtree
ICAO, DIR = sys.argv[1], sys.argv[2]
# RJTT's grass is fully mapped (what is neither grass nor pavement is tarmac); elsewhere what is not paved or built on is grass
MODE, REACH = ('mapped', 700) if ICAO == 'RJTT' else ('open', 4 if ICAO == 'OMDB' else 60)
N, W, R = {}, {}, {}
for f in glob.glob(DIR + '/*.json'):
    for e in json.load(open(f))['elements']: {'node': N, 'way': W, 'relation': R}[e['type']][e['id']] = e
osm = json.load(open(f'/root/atc/public/maps/osm/{ICAO}.geojson'))
LAT0 = sum(n['lat'] for n in N.values()) / len(N); LNG0 = sum(n['lon'] for n in N.values()) / len(N)
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110950
xy = lambda lng, lat: ((lng - LNG0) * KX, (lat - LAT0) * KY)
ll = lambda x, y: [round(x / KX + LNG0, 6), round(y / KY + LAT0, 6)]
pts = lambda w: [xy(N[n]['lon'], N[n]['lat']) for n in w['nodes'] if n in N]
tag = lambda w, k: w.get('tags', {}).get(k)
closed = lambda w: len(w['nodes']) > 3 and w['nodes'][0] == w['nodes'][-1] and all(n in N for n in w['nodes'])
def poly(w):
    p = Polygon(pts(w)); return p if p.is_valid else p.buffer(0)
def ring_polys(rel, role):
    ls = [LineString(pts(W[m['ref']])) for m in rel['members'] if m['type'] == 'way' and m['role'] == role and m['ref'] in W and len(pts(W[m['ref']])) > 1]
    return list(polygonize(unary_union(ls))) if ls else []
polys = lambda g: [] if g.is_empty else [g] if g.geom_type == 'Polygon' else [p for p in getattr(g, 'geoms', []) if p.geom_type == 'Polygon']

# the airport inside its fence: the aerodrome outline less the districts cut out of it
rel = {'members': []} if sys.argv[3][0] == 'w' else R[int(sys.argv[3])]
outer = unary_union(ring_polys(rel, 'outer')) if rel['members'] else unary_union([poly(W[int(x[1:])]) for x in sys.argv[3].split('+')])
fence = unary_union(ring_polys(rel, 'inner')) if rel['members'] else Polygon(); site = outer.difference(fence)
# Paris: the motorways through and round the field are left out (their ground is grass, and no tunnel mouths are drawn)
NO_HWY = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'} if ICAO == 'LFPG' else set()
W = {i: w for i, w in W.items() if tag(w, 'highway') not in NO_HWY}
bldA = [poly(w) for w in W.values() if closed(w) and tag(w, 'aeroway') == 'terminal']
# the land it stands on: the bbox cut by the coastline; water on the right-hand side of a coastline way
bb = box(*xy(min(n['lon'] for n in N.values()), min(n['lat'] for n in N.values())), *xy(max(n['lon'] for n in N.values()), max(n['lat'] for n in N.values())))
if len(sys.argv) > 4: w_, s_, e_, n_ = map(float, sys.argv[4].split(',')); bb = box(*xy(w_, s_), *xy(e_, n_))
coast = [LineString(pts(w)) for w in W.values() if tag(w, 'natural') == 'coastline' and len(pts(w)) > 1]
if ICAO == 'OMDB': coast = []      # (the Creek, 1 km off, is no shore of the field)
cells = list(polygonize(unary_union([c.intersection(bb) for c in coast] + [bb.boundary])))
pier = unary_union([poly(w) for w in W.values() if closed(w) and tag(w, 'man_made') in ('pier', 'bridge') and poly(w).area > 4000 and poly(w).distance(outer) < 5 and poly(w).length ** 2 / poly(w).area < 400])
def wet(c):
    v = 0
    for l in coast:
        co = list(l.coords)
        for a, b in zip(co, co[1:]):
            L = math.hypot(b[0] - a[0], b[1] - a[1])
            if L < 1: continue
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            if c.distance(Point(mx, my)) > 1: continue
            nx, ny = (b[1] - a[1]) / L, -(b[0] - a[0]) / L    # right of the way: the sea
            if c.contains(Point(mx + nx * 2, my + ny * 2)): v += L
            elif c.contains(Point(mx - nx * 2, my - ny * 2)): v -= L
    return v > 0
water = [poly(w) for w in W.values() if closed(w) and tag(w, 'natural') == 'water']
for r in R.values():
    if tag(r, 'natural') == 'water': water += ring_polys(r, 'outer')
paved = unary_union([LineString(pts(w)) for w in W.values() if tag(w, 'aeroway') in ('taxiway', 'taxilane', 'runway') and len(pts(w)) > 1]).buffer(70).union(unary_union([poly(w) for w in W.values() if closed(w) and tag(w, 'aeroway') == 'apron']).buffer(20))
water = [w for w in water if w.area > 9000 or w.centroid.distance(paved) > 0]        # (a drain basin by the apron is not a hole in it)
land = (unary_union([c for c in cells if not wet(c)]) if coast else bb).difference(unary_union(water))
land0 = land; land = land.intersection(outer.buffer(REACH)).buffer(-3).buffer(3)      # (the shore the airport stands on, not the towns beyond)
mine = [p for p in polys(land) if p.intersection(outer).area > 20000]
ground = unary_union(mine + [pier] + ([outer] if MODE == 'mapped' else [])).buffer(2).buffer(-2)
ground = unary_union([p for p in polys(ground) if p.intersection(outer).area > 1000])
if ICAO == 'WSSS':     # the cargo area, the air base's loops and the ground being built on between the runways, all inside the airport's outline
    ground = unary_union([p for p in polys(ground.buffer(450).buffer(-450).intersection(land0)) if p.area > 5e4]).union(ground).buffer(4).buffer(-4)
if ICAO == 'KSFO': ground = unary_union([p for p in polys(ground.buffer(160).buffer(-160).intersection(land0)) if p.area > 5e4]).union(ground).buffer(4).buffer(-4)      # the Coast Guard station in the corner of the field
print('land', [round(p.area / 1e6, 2) for p in polys(ground)], 'site', round(site.area / 1e6, 2), 'pier', round(pier.area / 1e6, 3))

lines = lambda *k: [LineString(pts(w)) for w in W.values() if tag(w, 'aeroway') in k and len(pts(w)) > 1]
taxi = unary_union(lines('taxiway', 'taxilane')); rwy = unary_union(lines('runway'))
aprons = unary_union([poly(w) for w in W.values() if closed(w) and tag(w, 'aeroway') == 'apron'])
# the mapped aprons with staircase edges drawn straight (and the notches between two of them closed)
if not aprons.is_empty: aprons = aprons.buffer(18, join_style=2).buffer(-36, join_style=2).buffer(18, join_style=2).simplify(13)
grass = unary_union([poly(w) for w in W.values() if closed(w) and (tag(w, 'landuse') in ('grass', 'meadow') or tag(w, 'natural') in ('grassland', 'scrub'))]
                    + [p for r in R.values() if tag(r, 'landuse') == 'grass' for p in ring_polys(r, 'outer')])
taxi = taxi.simplify(0.5); grass = grass.intersection(ground).difference(taxi.buffer(16)).difference(rwy.buffer(31)).difference(aprons).buffer(-2).buffer(4).buffer(-2)
grass = unary_union([p for p in polys(grass) if p.area > 150])
# landside: the ground outside the fence (the districts in the middle, the strip along the water)
car = [LineString(pts(w)) for w in W.values() if tag(w, 'highway') in ('motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential') and tag(w, 'tunnel') != 'yes' and len(pts(w)) > 1]
core = ground.difference(taxi.buffer(42)).difference(rwy.buffer(90)).difference(aprons.buffer(6)).difference(grass.buffer(8)).difference(pier.buffer(10))
core = core.buffer(-22).buffer(24)      # what no aircraft, apron or grass is near: terminal forecourts, hangar and cargo districts, tank farms
if MODE == 'open':
    # districts: streets, buildings and car parks close together, less what is airside
    bld = [poly(w) for w in W.values() if closed(w) and (tag(w, 'building') or tag(w, 'aeroway') in ('terminal', 'hangar')) and poly(w).area > 60]
    lots = [poly(w) for w in W.values() if closed(w) and tag(w, 'amenity') == 'parking']
    near_g = prep(ground.buffer(60)); pick = lambda l: [g for g in l if near_g.intersects(g)]
    core = unary_union([g.buffer(16) for g in pick(car)] + [g.buffer(22) for g in pick(bld)] + [g.buffer(8) for g in pick(lots)]).buffer(40).buffer(-52).buffer(12)
    core = core.intersection(ground).difference(taxi.buffer(42)).difference(rwy.buffer(90)).difference(aprons.buffer(2)).buffer(-8).buffer(8)
cover = unary_union([g.buffer(22) for g in pick(bld)] + [g.buffer(8) for g in pick(lots)]) if MODE == 'open' else None
landside = unary_union([p for p in polys(core) if (p.area > 15000 if MODE == 'mapped' else p.area > 12000 and p.intersection(cover).area > p.area * 0.15)] + ([ground.difference(site), fence] if MODE == 'mapped' else [])).buffer(12).buffer(-12)
landside = landside.difference(taxi.buffer(38)).difference(rwy.buffer(75)).difference(aprons).difference(grass if MODE == 'mapped' else Polygon()).difference(pier).buffer(-3).buffer(3)
landside = unary_union([p for p in polys(landside) if p.area > 900])
if NO_HWY:      # where the motorways were: only the ground round what is still there is paved
    used = unary_union([g.buffer(34, join_style=2) for g in pick(bld)] + [g.buffer(12, join_style=2) for g in pick(lots)] + [LineString(pts(w)).buffer(11) for w in W.values() if tag(w, 'highway') in ('secondary', 'tertiary', 'unclassified', 'residential', 'service') and tag(w, 'tunnel') != 'yes' and len(pts(w)) > 1 and near_g.intersects(LineString(pts(w)))])
    landside = unary_union([p for p in polys(landside.intersection(used.buffer(14).buffer(-14)).buffer(-6).buffer(6)) if p.area > 2500])
# ── aprons ── concrete with real, straight edges that stops exactly at a taxiway's edge
# (1) what is concrete: the mapped aprons, every stand of the game with its way in, and the ground up to the buildings they
#     stand at; gaps under 80 m between them closed square. (2) no sliver of grass between an apron and the taxiway beside it,
#     and a small island between taxiways is all concrete or all grass. (3) a taxi line deep inside is a lane on the concrete;
#     one along its edge or outside is a taxiway, and the concrete ends at that taxiway's shoulder.
FIELD = json.load(open(f'/root/atc/.tmp/field-{ICAO}.json'))
SPAN = dict(A=(15, 18), B=(24, 30), C=(36, 45), D=(52, 62), E=(65, 76), F=(80, 80))
MJ = dict(join_style=2, mitre_limit=2.0)
lparts = lambda g: [] if g.is_empty else [g] if g.geom_type == 'LineString' else [l for q in getattr(g, 'geoms', []) for l in lparts(q)]
merged = lambda g: lparts(linemerge(MultiLineString(lparts(g)))) if lparts(g) else []
pads, stpts = [], []
for s in FIELD['stands']:
    p = xy(s['lng'], s['lat']); h = math.radians(s['hdg']); f = (math.sin(h), math.cos(h)); span, ln = SPAN.get(s['size'], SPAN['C'])
    pads.append(LineString([(p[0] + f[0] * 12, p[1] + f[1] * 12), (p[0] - f[0] * (ln + 4), p[1] - f[1] * (ln + 4))]).buffer(span / 2 + 4, cap_style=2))
    lead = LineString([xy(*q) for q in s['lead']])
    if lead.length > 1: pads.append(lead.buffer(span / 2 + 5, cap_style=2, join_style=2))
    stpts.append(Point(p))
P = unary_union(pads); standsAt = prep(unary_union(stpts).buffer(1))
C = unary_union([LineString([xy(a, b), xy(c, d)]) for a, b, c, d in FIELD['taxi']])
allb = [poly(w) for w in W.values() if closed(w) and (tag(w, 'building') or tag(w, 'aeroway') in ('terminal', 'hangar')) and tag(w, 'building') != 'roof' and poly(w).area > 300]
nearP = prep(P.buffer(45)); by = unary_union([b for b in allb if nearP.intersects(b)])
A0 = unary_union([aprons, P, by]).buffer(40, **MJ).buffer(-40, **MJ)
A0 = A0.intersection(ground).difference(rwy.buffer(75)).difference(landside.difference(P.buffer(8))).difference(grass if MODE == 'mapped' else Polygon())
if MODE == 'open':
    # a patch of 'town' with apron all round it (a satellite, a hut between the stands) is apron
    isl = [p.buffer(14) for p in polys(landside) if p.area < 60000 and sum(c.intersection(p).length for c in car if c.intersects(p)) < 120 and p.exterior.intersection(A0.buffer(14)).length > p.exterior.length * 0.6]
    if isl: A0 = unary_union([A0] + isl).buffer(2).buffer(-2).difference(rwy.buffer(75))
if ICAO == 'KSFO':     # United's maintenance base, hangar to hangar: no stands of the game's, but all concrete
    base = box(*xy(-122.3985, 37.6292), *xy(-122.3868, 37.6425)).intersection(ground).difference(rwy.buffer(370, **MJ)).difference(landside)
    base = unary_union([p for p in polys(base.intersection(unary_union([b.minimum_rotated_rectangle.buffer(95, **MJ) for b in allb if b.area > 9000])).buffer(20, **MJ).buffer(-20, **MJ).buffer(-8, **MJ).buffer(8, **MJ)) if p.area > 8000]); A0 = A0.union(base)
A0 = unary_union([p for p in polys(A0.buffer(-5, **MJ).buffer(5, **MJ)) if p.area > 2500 or standsAt.intersects(p)])
Kall = C.buffer(15)
# an airport whose aprons are hardly mapped (Changi): the concrete is whatever lies between its stands, up to the taxiways round them
SPARSE = sum(aprons.contains(q) for q in stpts) < 0.6 * len(stpts) or ICAO in ('KSFO', 'OMDB'); SL = 32 if SPARSE else 13
HULL = prep(unary_union([P, by]).buffer(110).buffer(-110)) if SPARSE else None; HULLG = unary_union([P, by]).buffer(110).buffer(-110) if SPARSE else None
# (2a) slivers between the concrete and a taxiway beside it
U = unary_union([A0, Kall]); near0 = A0.buffer(0.7)
fill = [f for f in polys(U.buffer(SL, **MJ).buffer(-SL, **MJ).difference(U)) if f.area > 15 and f.boundary.intersection(near0).length > 0.25 * f.length]
A0 = unary_union([A0] + fill).difference(grass if MODE == 'mapped' else Polygon())
# (2b) small islands between taxiways: all or nothing
for fc in polys(ground.difference(Kall).difference(rwy.buffer(30))):
    if fc.area > (60000 if SPARSE else 20000): continue
    cov = fc.intersection(A0).area / fc.area; inside = SPARSE and HULL.intersects(fc) and fc.intersection(HULLG).area > 0.6 * fc.area
    if cov >= 0.98 and not inside: continue
    if cov >= 0.5 or inside or standsAt.intersects(fc): A0 = A0.union(fc.buffer(0.5))
    elif cov > 0.02: A0 = A0.difference(fc.buffer(0.5))
A0 = unary_union(polys(A0.intersection(ground).difference(rwy.buffer(75)).difference(grass if MODE == 'mapped' else Polygon())))
# (3) lanes and taxiways
deep = A0.buffer(-20); raw = C.difference(deep); Ab, Db = A0.boundary, deep.boundary
# inside the edge, a line is a taxiway only where it runs along the edge for a while; one that crosses it is a lane going in
ABL = [LineString(c) for l in lparts(Ab) for c in zip(l.coords, l.coords[1:]) if math.hypot(c[0][0] - c[1][0], c[0][1] - c[1][1]) > 0.5]; ABT = STRtree(ABL)
par = []
for q in merged(raw.intersection(A0)):
    for a, b in zip(q.coords, q.coords[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 0.05: continue
        e = ABL[int(ABT.nearest(Point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)))].coords; M = math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1])
        if abs((b[0] - a[0]) * (e[1][0] - e[0][0]) + (b[1] - a[1]) * (e[1][1] - e[0][1])) / L / M > 0.82: par.append(LineString([a, b]))
par = [g for g in polys(unary_union([x.buffer(0.6, cap_style=3) for x in par]).buffer(24).buffer(-24)) if g.length / 2 > 75] if par else []
PAR = unary_union(par).buffer(0.8) if par else Polygon()
# (SFO, whose lanes all start from a taxiway's fillets; elsewhere every line not deep inside is a taxiway)
Tw = merged(raw.difference(A0)) + (merged(raw.intersection(A0).intersection(PAR)) if ICAO == 'KSFO' else [q for q in merged(raw.intersection(A0)) if not (q.length < 50 and q.distance(deep) < 0.7)])
ends = collections.Counter((round(e[0], 1), round(e[1], 1)) for q in Tw for e in (q.coords[0], q.coords[-1]))
discs = [Point(e).buffer(15) for q in Tw for e in (q.coords[0], q.coords[-1]) if (ICAO != 'KSFO' or ends[(round(e[0], 1), round(e[1], 1))] > 1) and Point(e).distance(Ab) > 0.7 and Point(e).distance(Db) > 0.7 and Point(e).distance(A0) < 40]
K = unary_union([q.buffer(15, cap_style=2) for q in Tw if q.distance(A0) < 40] + discs)
if ICAO == 'KSFO': K = K.buffer(28).buffer(-28)
op = 9 if ICAO == 'KSFO' else 4
A = A0.difference(K).buffer(-op, **MJ).buffer(op, **MJ).difference(K).intersection(A0)
A = unary_union([Polygon(p.exterior, [i for i in p.interiors if Polygon(i).area > 500]) for p in polys(A) if p.area > 1500 or standsAt.intersects(p)])
extra = A0
print('aprons', round(A.area / 1e6, 2), 'km2 in', len(polys(A)), 'pieces;', len(Tw), 'taxiway runs,', len(FIELD['stands']), 'stands')
if MODE == 'open':
    landside = landside.difference(A0); landside = unary_union([p for p in polys(landside) if p.area > 3000])
    grass = ground.difference(landside).difference(taxi.buffer(19)).difference(C.buffer(19)).difference(rwy.buffer(36)).difference(A0).difference(pier).buffer(-5).buffer(9).buffer(-4)
    grass = grass.intersection(ground).difference(A0); grass = unary_union([p for p in polys(grass) if p.area > 400])
    # puddles: grass shut in by concrete and streets, beside no taxiway, runway or the airport's edge, is paved like what is round it
    open_side = prep(unary_union([C.buffer(24), rwy.buffer(45), ground.boundary.buffer(6)])); open_g = unary_union([C.buffer(24), rwy.buffer(45), ground.boundary.buffer(6)])
    keepG, toA, toL = [], [], []
    for p in polys(grass):
        touch = p.exterior.intersection(open_g).length if open_side.intersects(p) else 0
        if p.area > 150000 or touch > 0.22 * p.exterior.length: keepG.append(p); continue
        ring = p.buffer(8); (toA if ring.intersection(A0).area > ring.intersection(landside).area else toL).append(p.buffer(6))
    print('puddles paved:', len(toA), 'as apron,', len(toL), 'as streets')
    grass = unary_union(keepG)
    if toL: landside = unary_union([landside] + toL).buffer(1).buffer(-1).intersection(ground).difference(A0).difference(grass)
    if toA: A = unary_union([A] + toA).buffer(1).buffer(-1).intersection(ground).difference(K).difference(landside).difference(grass)
# roads: width by class; heights: bridges by layer, the ways joining them ramp down at 5 %
WID = dict(motorway=10, motorway_link=6.5, trunk=10.5, trunk_link=6.5, primary=10, primary_link=6.5, secondary=9, tertiary=8, tertiary_link=6, unclassified=7, residential=6, service=5)
near = prep(ground.buffer(30)); roads = [w for w in W.values() if tag(w, 'highway') in WID and len(pts(w)) > 1 and near.intersects(LineString(pts(w)))]
under = lambda w: tag(w, 'tunnel') == 'yes' and float(tag(w, 'layer') or -1) < 0
hgt, adj = {}, collections.defaultdict(list)
for w in roads:
    if under(w): continue
    up = tag(w, 'bridge') and tag(w, 'bridge') != 'no'; h = 6.5 * max(1, float(tag(w, 'layer') or 1)) if up else 0
    ns = [n for n in w['nodes'] if n in N]
    for a, b in zip(ns, ns[1:]):
        pa, pb = xy(N[a]['lon'], N[a]['lat']), xy(N[b]['lon'], N[b]['lat']); d = math.hypot(pa[0] - pb[0], pa[1] - pb[1]); adj[a].append((b, d)); adj[b].append((a, d))
    if up:
        for n in ns: hgt[n] = max(hgt.get(n, 0), h)
q = [(-h, n) for n, h in hgt.items()]; heapq.heapify(q); done = set()
while q:
    h, n = heapq.heappop(q); h = -h
    if n in done: continue
    done.add(n)
    for m, d in adj[n]:
        k = h - d * 0.05
        if k > hgt.get(m, 0) + 0.01: hgt[m] = k; heapq.heappush(q, (-k, m))
out_roads, mouths = [], []; slabG = A0.buffer(6); slab = prep(slabG)
open_nodes = collections.defaultdict(list)
for w in roads:
    if not under(w):
        for n in (w['nodes'][0], w['nodes'][-1]): open_nodes[n].append(w)
wideG = ground.buffer(3).simplify(1)
parts = lambda g: [] if g.is_empty else [g] if g.geom_type == 'LineString' else [l for q in getattr(g, 'geoms', []) for l in parts(q)]
def cum(P):
    o = [0]
    for a, b in zip(P, P[1:]): o.append(o[-1] + max(1e-6, math.hypot(b[0] - a[0], b[1] - a[1])))
    return o
inner = prep(landside.buffer(15).simplify(1)); wide = prep(ground.buffer(8).simplify(1))
for w in roads:
    wid = WID[tag(w, 'highway')]
    if tag(w, 'lanes') and tag(w, 'lanes').isdigit(): wid = max(wid * 0.7, int(tag(w, 'lanes')) * 3.4 + 1.2)
    if under(w):
        if NO_HWY or ICAO == 'OMDB': continue
        ns = [n for n in w['nodes'] if n in N]
        if tag(w, 'highway') == 'service' or LineString(P0 if (P0 := pts(w)) else []).length < 60: continue
        for a, b in ((0, 1), (-1, -2)):
            if len(ns) > 1 and ns[a] in open_nodes:
                p, t = xy(N[ns[a]]['lon'], N[ns[a]]['lat']), xy(N[ns[b]]['lon'], N[ns[b]]['lat']); d = math.hypot(t[0] - p[0], t[1] - p[1])
                if d > 0.5 and ground.contains(Point(p)) and not slab.contains(Point(p)): mouths.append([*ll(*p), round(math.degrees(math.atan2(t[0] - p[0], t[1] - p[1])), 1), round(wid, 1)])
        continue
    ns = [n for n in w['nodes'] if n in N]; P = [xy(N[n]['lon'], N[n]['lat']) for n in ns]
    # on the airside only on the ground: under the pavement's own order it shows on the grass alone
    L = LineString(P)
    air_side = not inner.contains(L.interpolate(0.5, normalized=True))
    if not wide.intersects(L): continue
    if NO_HWY and air_side and tag(w, 'highway') != 'service': continue      # (what is left between two tunnels)
    # cut at the airport's edge (the map draws its own roads beyond)
    H = [0 if air_side and tag(w, 'highway') == 'service' else hgt.get(n, 0) for n in ns]
    for part in parts(L.intersection(wideG)):
        if part.length < 4: continue
        c = [(x, y, round(float(np.interp(L.project(Point(x, y)), cum(P), H)), 1)) for x, y in part.coords]
        out_roads.append(dict(p=[v for x, y, h in c for v in (*ll(x, y), h)], w=round(wid, 1), a=1 if air_side else 0, b=1 if (tag(w, 'bridge') or 'no') != 'no' else 0))
mono = [dict(p=[c for p in q.coords for c in (*ll(*p), 7.5 if tag(w, 'bridge') else 1.2)]) for w in W.values() if tag(w, 'railway') in ('monorail', 'light_rail', 'subway') and not tag(w, 'tunnel') and len(pts(w)) > 1 for q in parts(LineString(pts(w)).intersection(wideG) if tag(w, 'bridge') else LineString(pts(w)).intersection(wideG).difference(slabG)) if q.length > 25]
parking = unary_union([poly(w) for w in W.values() if closed(w) and tag(w, 'amenity') == 'parking' and tag(w, 'building') is None and tag(w, 'parking') in (None, 'surface')]).intersection(landside)
lights = [poly(w) for w in W.values() if closed(w) and tag(w, 'man_made') == 'pier' and poly(w).distance(ground) < 30 and poly(w).length ** 2 / max(1, poly(w).area) > 250]
def rings(g, tol=0.6):
    o = []
    for p in polys(g.simplify(tol)):
        if p.area < 40: continue
        o.append([[c for x, y in r.coords[:-1] for c in ll(x, y)] for r in [p.exterior, *[i for i in p.interiors if Polygon(i).area > 60]]])
    return o
sea = unary_union([c.buffer(14) for c in coast] + ([] if pier.is_empty else [pier.boundary.buffer(6)]))       # the wall is drawn where there is water, not along a fence
joined = lambda g: parts(linemerge(g)) if g.geom_type == 'MultiLineString' else parts(g)
parts = lambda g: [] if g.is_empty else [g] if g.geom_type == 'LineString' else [l for q in getattr(g, 'geoms', []) for l in parts(q)]
shore = [[c for x, y in l.simplify(0.8).coords for c in ll(x, y)] for p in polys(ground) for l in joined(p.exterior.intersection(sea)) if l.length > 60]
out = dict(site=rings(ground), grass=rings(grass), landside=rings(landside), apron=rings(A, 0.3), parking=rings(parking), roads=out_roads, mouths=mouths, mono=mono, piers=rings(unary_union(lights), 0.4), shore=shore, deck=rings(pier))
f = f'/root/atc/public/maps/ground/{ICAO}.json'; json.dump(out, open(f, 'w'), separators=(',', ':'))
print({k: len(v) for k, v in out.items()}, len(open(f).read()) // 1024, 'KB')
