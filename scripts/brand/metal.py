import json, sys, os
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt as edt, gaussian_filter as G, map_coordinates
# adds what a vector can't: fine brushing along each facet, a hairline chamfer on every edge and fold, a soft light sweep
plan = json.load(open('m1/plan.json'))
os.makedirs('o1', exist_ok=True)

def brush(n, ang, rng):
    """1-D noise stretched along the brushing direction"""
    t = np.deg2rad(ang)
    yy, xx = np.mgrid[0:n, 0:n]
    across = -xx * np.sin(t) + yy * np.cos(t)
    along = xx * np.cos(t) + yy * np.sin(t)
    tex = rng.normal(size=(int(n * 3), 24))
    tex = G(tex, (.7, 2.2), mode='wrap')
    tex /= tex.std()
    return map_coordinates(tex, [across * 1.0 + n * 1.2, along / n * 9 + 10], order=1, mode='wrap')

def render(k, fin, size):
    base = np.asarray(Image.open(f'm1/{k}_c{fin}.png').convert('RGBA')).astype(float) / 255
    n = base.shape[0]
    u = n / 512
    alpha = base[..., 3]
    rgb = base[..., :3].copy()
    # fill the hairline seams between facets: colours come from the facet whose mask is strongest
    rng = np.random.default_rng(11)
    yy, xx = np.mgrid[0:n, 0:n] / u
    tot = np.zeros((n, n)); acc = np.zeros((n, n, 3))
    for L in plan[k]:
        m = np.asarray(Image.open(L['f']).convert('L')) / 255.
        c = rgb.copy()
        # colour just outside the facet = colour just inside it, so the edge stays clean
        inside = m > .95
        idx = edt(~inside, return_distances=False, return_indices=True)
        c = rgb[idx[0], idx[1]]
        lum = c.mean(-1, keepdims=True)
        b = brush(n, L['a'], rng)[..., None]
        c = c * (1 + .024 * b)
        # soft sheen crossing the facet
        sw = np.exp(-(((xx * .55 + yy * .84) - 300) / 46) ** 2)[..., None]
        c = c + sw * .10 * (.35 + lum)
        # chamfer: bright on edges facing up-left, dark on the opposite side
        d = edt(m > .5)
        ds = G(d, 1.0)
        gy, gx = np.gradient(ds)
        out = gx * .62 + gy * .78
        w = 1.25 * u
        band = np.clip(1 - d / w, 0, 1) ** .8
        c = c + (band * np.clip(out, -1, 1) * np.where(out > 0, .55, .22))[..., None] * (.55 + .45 * lum)
        rim = (band * np.clip(-out, 0, 1))[..., None] * np.clip(.62 - lum, 0, 1) * np.array([.62, .68, .76])
        c = c + rim * 1.15
        acc += c * m[..., None]; tot += m
    col = acc / np.maximum(tot, 1e-4)[..., None]
    a = np.clip(tot, 0, 1)
    im = Image.fromarray((np.dstack([np.clip(col, 0, 1), a]) * 255).astype('uint8'), 'RGBA')
    im.resize((size, size), Image.LANCZOS).save(f'o1/{k}{fin}.png')

if __name__ == '__main__':
    for job in sys.argv[2:]:
        render(job[0], job[1:], int(sys.argv[1]))
