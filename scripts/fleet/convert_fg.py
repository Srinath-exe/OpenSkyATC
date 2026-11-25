#!/usr/bin/env python3
"""
Convert FlightGear's AI fleet (fgdata/AI/Aircraft, GNU GPL v2) into what the world map loads:

  public/models/fleet/index.json         every model, its authors and its liveries
  public/models/fleet/<model>.glb        geometry with UVs, one per AC3D model (no textures inside)
  public/models/fleet/tex/<hash>.webp    every livery texture, deduplicated by content, at most 1024 px

A livery XML includes the model's main XML and sets <texture-path>; the AC3D file names its textures, which each
livery folder overrides by file name (anything a livery does not repaint comes from the model's own folder). Gear
objects go into a node named "gear" (the map hides it in the air); shadow objects are dropped.

    python3 scripts/fleet/convert_fg.py /root/fgsrc/fgdata/AI/Aircraft public/models/fleet
"""
import hashlib, io, json, math, os, re, struct, sys, xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

SRC, OUT = Path(sys.argv[1]), Path(sys.argv[2])
MAX_TEX = 1024
GEAR = re.compile(r'gear|wheel|tyre|tire|strut|oleo|bogie|truck', re.I)
DROP = re.compile(r'shadow', re.I)


# ── XML: follow include chains to the model file and the texture folder ──────────────────────────────────────────
def load_props(path: Path, depth=0):
    """Top-level <path> and <texture-path> of a PropertyList, following include= (the including file wins)."""
    try:
        root = ET.parse(path).getroot()
    except Exception:
        return {}
    props = {}
    inc = root.get('include')
    if inc and depth < 6:
        base = load_props(path.parent / inc, depth + 1)
        props.update(base)
    for tag in ('path', 'texture-path', 'description', 'author'):
        el = root.find(tag)
        if el is not None and el.text and el.text.strip():
            props[tag] = el.text.strip()
            props[tag + '@'] = path.parent      # paths are relative to the file that set them
    return props


def resolve_model(xml: Path, depth=0):
    p = load_props(xml)
    if 'path' not in p or depth > 4:
        return None, p
    target = (p['path@'] / p['path']).resolve()
    if target.suffix.lower() == '.xml':
        ac, sub = resolve_model(target, depth + 1)
        for k in ('description', 'author'):
            if k not in p and k in sub:
                p[k] = sub[k]
        return ac, p
    return (target if target.exists() else None), p


# ── AC3D ──────────────────────────────────────────────────────────────────────────────────────────────────────────
class Obj:
    def __init__(self):
        self.name = ''; self.texture = None; self.texrep = (1.0, 1.0); self.texoff = (0.0, 0.0)
        self.loc = np.zeros(3); self.rot = np.eye(3); self.verts = None; self.surfs = []; self.kids = []


def parse_ac(path: Path):
    lines = path.read_text(errors='replace').splitlines()
    i = 1; mats = []

    def nxt():
        nonlocal i
        while i < len(lines) and not lines[i].strip():
            i += 1
        s = lines[i] if i < len(lines) else ''
        i += 1
        return s

    def read_obj():
        o = Obj()
        while i < len(lines):
            s = nxt().strip()
            if not s:
                continue
            tok = s.split()
            k = tok[0]
            if k == 'name':
                o.name = s[5:].strip().strip('"')
            elif k == 'data':
                nxt()
            elif k == 'texture':
                o.texture = s[8:].strip().strip('"') or None
            elif k == 'texrep':
                o.texrep = (float(tok[1]), float(tok[2]))
            elif k == 'texoff':
                o.texoff = (float(tok[1]), float(tok[2]))
            elif k == 'rot':
                o.rot = np.array([float(x) for x in tok[1:10]]).reshape(3, 3)
            elif k == 'loc':
                o.loc = np.array([float(x) for x in tok[1:4]])
            elif k == 'numvert':
                n = int(tok[1])
                o.verts = np.array([[float(x) for x in nxt().split()[:3]] for _ in range(n)], dtype=np.float64).reshape(-1, 3)
            elif k == 'numsurf':
                for _ in range(int(tok[1])):
                    flags = int(nxt().split()[1], 0)
                    s2 = nxt().split()
                    mat = 0
                    if s2[0] == 'mat':
                        mat = int(s2[1]); s2 = nxt().split()
                    refs = []
                    for _ in range(int(s2[1])):
                        r = nxt().split()
                        refs.append((int(r[0]), float(r[1]) if len(r) > 1 else 0.0, float(r[2]) if len(r) > 2 else 0.0))
                    o.surfs.append((flags, mat, refs))
            elif k == 'kids':
                for _ in range(int(tok[1])):
                    hdr = nxt()
                    if not hdr.startswith('OBJECT'):
                        break
                    o.kids.append(read_obj())
                return o
        return o

    while i < len(lines):
        s = lines[i].strip()
        if s.startswith('MATERIAL'):
            m = re.search(r'rgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)', s)
            t = re.search(r'trans\s+([\d.eE+-]+)', s)
            mats.append(((float(m.group(1)), float(m.group(2)), float(m.group(3))) if m else (0.8, 0.8, 0.8), float(t.group(1)) if t else 0.0))
            i += 1
        elif s.startswith('OBJECT'):
            i += 1
            return read_obj(), mats
        else:
            i += 1
    return None, mats


def collect(o, M, parent_gear, out):
    """Flatten the tree into primitives keyed by (texture, material, gear)."""
    T = np.eye(4); T[:3, :3] = o.rot; T[:3, 3] = o.loc
    W = M @ T
    gear = parent_gear or bool(GEAR.search(o.name or ''))
    if DROP.search(o.name or ''):
        return
    if o.verts is not None and len(o.surfs):
        v = (np.c_[o.verts, np.ones(len(o.verts))] @ W.T)[:, :3]
        # smooth normals per object vertex from the faces flagged smooth
        acc = np.zeros_like(v)
        tris = []
        for flags, mat, refs in o.surfs:
            if flags & 0xF or len(refs) < 3:
                continue                                   # lines
            idx = [r[0] for r in refs]
            for k in range(1, len(refs) - 1):
                a, b, c = refs[0], refs[k], refs[k + 1]
                if a[0] >= len(v) or b[0] >= len(v) or c[0] >= len(v):
                    continue
                n = np.cross(v[b[0]] - v[a[0]], v[c[0]] - v[a[0]])
                ln = np.linalg.norm(n)
                if ln < 1e-12:
                    continue
                n = n / ln
                smooth = bool(flags & 0x10)
                if smooth:
                    for r in (a, b, c):
                        acc[r[0]] += n
                tris.append((mat, smooth, flags & 0x20, (a, b, c), n))
        ln = np.linalg.norm(acc, axis=1, keepdims=True); acc = np.divide(acc, np.where(ln < 1e-12, 1, ln))
        ru, rv = o.texrep; ou, ov = o.texoff
        for mat, smooth, two, (a, b, c), n in tris:
            key = (o.texture if o.texture else None, mat, gear)
            p = out.setdefault(key, {'pos': [], 'nrm': [], 'uv': []})
            for r in (a, b, c):
                p['pos'].append(v[r[0]]); p['nrm'].append(acc[r[0]] if smooth else n)
                p['uv'].append((r[1] * ru + ou, 1.0 - (r[2] * rv + ov)))   # glTF UVs start at the top
    for k in o.kids:
        collect(k, W, gear, out)


def write_glb(prims, mats, path: Path):
    """Minimal glTF 2.0 binary: one mesh per (gear / body), one primitive per (texture, material)."""
    bin_ = bytearray(); views = []; accs = []; materials = []; mat_index = {}
    meshes = {False: [], True: []}

    def add_view(data: bytes, target):
        while len(bin_) % 4:
            bin_.append(0)
        views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(data), **({'target': target} if target else {})})
        bin_.extend(data)
        return len(views) - 1

    for (tex, mat, gear), p in prims.items():
        pos = np.asarray(p['pos'], np.float32); nrm = np.asarray(p['nrm'], np.float32); uv = np.asarray(p['uv'], np.float32)
        if not len(pos):
            continue
        # weld identical vertices so the GPU gets an index buffer
        key = np.c_[np.round(pos, 4), np.round(nrm, 3), np.round(uv, 4)]
        uniq, inv = np.unique(key, axis=0, return_inverse=True)
        first = np.zeros(len(uniq), np.int64); first[inv[::-1]] = np.arange(len(inv))[::-1]
        pos, nrm, uv = pos[first], nrm[first], uv[first]
        idx = inv.astype(np.uint32).ravel()
        a_pos = len(accs); accs.append({'bufferView': add_view(pos.tobytes(), 34962), 'componentType': 5126, 'count': len(pos), 'type': 'VEC3', 'min': pos.min(0).tolist(), 'max': pos.max(0).tolist()})
        a_nrm = len(accs); accs.append({'bufferView': add_view(nrm.tobytes(), 34962), 'componentType': 5126, 'count': len(nrm), 'type': 'VEC3'})
        a_uv = len(accs); accs.append({'bufferView': add_view(uv.tobytes(), 34962), 'componentType': 5126, 'count': len(uv), 'type': 'VEC2'})
        a_idx = len(accs); accs.append({'bufferView': add_view(idx.tobytes(), 34963), 'componentType': 5125, 'count': len(idx), 'type': 'SCALAR'})
        rgb, trans = mats[mat] if mat < len(mats) else ((0.8, 0.8, 0.8), 0.0)
        mk = (tex, mat)
        if mk not in mat_index:
            m = {'name': f'tex:{tex}' if tex else f'col:{mat}', 'doubleSided': True,
                 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1] if tex else [*rgb, 1 - trans], 'metallicFactor': 0.1, 'roughnessFactor': 0.7}}
            if trans > 0.05:
                m['alphaMode'] = 'BLEND'
            mat_index[mk] = len(materials); materials.append(m)
        meshes[gear].append({'attributes': {'POSITION': a_pos, 'NORMAL': a_nrm, 'TEXCOORD_0': a_uv}, 'indices': a_idx, 'material': mat_index[mk]})
    nodes, mesh_list = [], []
    for gear in (False, True):
        if meshes[gear]:
            mesh_list.append({'primitives': meshes[gear]})
            nodes.append({'name': 'gear' if gear else 'airframe', 'mesh': len(mesh_list) - 1})
    gltf = {'asset': {'version': '2.0', 'generator': 'openatc convert_fg.py'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}],
            'nodes': nodes, 'meshes': mesh_list, 'materials': materials, 'accessors': accs, 'bufferViews': views,
            'buffers': [{'byteLength': len(bin_)}]}
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    while len(bin_) % 4:
        bin_.append(0)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_)
    path.write_bytes(out)
    return len(materials)


# ── textures ──────────────────────────────────────────────────────────────────────────────────────────────────────
tex_done = {}


def find_tex(folder: Path, name: str):
    if not folder or not folder.is_dir():
        return None
    stem = Path(name).stem.lower()
    want = Path(name).name.lower()
    files = {f.name.lower(): f for f in folder.iterdir() if f.is_file()}
    if want in files:
        return files[want]
    for ext in ('.png', '.rgb', '.jpg', '.dds'):
        if stem + ext in files:
            return files[stem + ext]
    return None


def convert_tex(src: Path):
    if src in tex_done:
        return tex_done[src]
    try:
        im = Image.open(src); im.load()
    except Exception:
        tex_done[src] = None; return None
    alpha = im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info)
    im = im.convert('RGBA' if alpha else 'RGB')
    if alpha and im.getchannel('A').getextrema()[0] > 250:
        im = im.convert('RGB'); alpha = False
    if max(im.size) > MAX_TEX:
        s = MAX_TEX / max(im.size); im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, 'WEBP', quality=82, method=6)
    data = buf.getvalue(); h = hashlib.sha1(data).hexdigest()[:16]
    (OUT / 'tex').mkdir(parents=True, exist_ok=True)
    f = OUT / 'tex' / f'{h}.webp'
    if not f.exists():
        f.write_bytes(data)
    tex_done[src] = (h, alpha)
    return tex_done[src]


# ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    models = {}           # key -> {glb, ac, textures, liveries}
    ac_cache = {}
    for folder in sorted(p for p in SRC.iterdir() if p.is_dir()):
        for xml in sorted(folder.glob('*.xml')):
            ac, props = resolve_model(xml)
            if ac is None:
                continue
            key = f'{folder.name}/{ac.stem}'
            if ac not in ac_cache:
                try:
                    root, mats = parse_ac(ac)
                except Exception as e:
                    print('  parse failed', ac, e); ac_cache[ac] = None; continue
                if root is None:
                    ac_cache[ac] = None; continue
                prims = {}
                collect(root, np.eye(4), False, prims)
                if not prims:
                    ac_cache[ac] = None; continue
                slug = re.sub(r'[^A-Za-z0-9_-]+', '_', key)
                write_glb(prims, mats, OUT / f'{slug}.glb')
                texnames = sorted({k[0] for k in prims if k[0]})
                ac_cache[ac] = {'glb': f'{slug}.glb', 'textures': texnames, 'gear': any(k[2] for k in prims),
                                'tris': sum(len(p['pos']) // 3 for p in prims.values())}
                models[key] = {**ac_cache[ac], 'type': folder.name, 'description': props.get('description', ''),
                               'authors': props.get('author', ''), 'liveries': {}}
            if ac_cache[ac] is None:
                continue
            m = models[key]
            if not m['authors'] and props.get('author'):
                m['authors'] = props['author']
            # livery textures: the livery's folder first, the model's own folder for anything it does not repaint
            tfolder = (props['texture-path@'] / props['texture-path']).resolve() if 'texture-path' in props else None
            tex = {}
            for name in m['textures']:
                src = find_tex(tfolder, name) or find_tex(ac.parent, name) or find_tex(ac.parent / 'Textures', name)
                r = convert_tex(src) if src else None
                if r:
                    tex[name] = r[0] + ('a' if r[1] else '')
            if not tex:
                continue
            livery = xml.stem
            for pre in (folder.name + '-', ):
                if livery.startswith(pre):
                    livery = livery[len(pre):]
            if re.search(r'-main(-|$)|^main$', livery):
                livery = 'default' if 'default' not in m['liveries'] else livery
            m['liveries'][livery] = {'xml': xml.name, 'tex': tex}
        print(f'{folder.name}: {sum(1 for k in models if k.startswith(folder.name + "/"))} models', flush=True)
    models = {k: v for k, v in models.items() if v['liveries']}
    index = {'source': 'FlightGear fgdata AI/Aircraft (GNU GPL v2)', 'models': models}
    (OUT / 'index.json').write_text(json.dumps(index, separators=(',', ':')))
    nl = sum(len(m['liveries']) for m in models.values())
    print(f'done: {len(models)} models, {nl} liveries, {len({v for m in models.values() for l in m["liveries"].values() for v in l["tex"].values()})} textures')


main()
