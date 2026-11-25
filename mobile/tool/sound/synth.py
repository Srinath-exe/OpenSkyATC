#!/usr/bin/env python3
"""Every sound of the phone game, synthesised (numpy only, no samples): mobile/assets/sound/*.wav, 16-bit mono.

  python3 mobile/tool/sound/synth.py            all of them, then the checks (levels, seams, big darker than small)

Loops are exactly periodic: noise is shaped in the frequency domain (inverse FFT), tones and wobbles have a whole number
of cycles, so a loop joins itself without a click. Aircraft come in three jet sizes and a propeller:

  s  regional jets        m  single-aisle        h  wide-body (the A380 / 747 are 'h' played lower)        prop

  idle_*  fan whine at idle (taxi)     roar_*  jet noise at power (take-off)    rev_*  reverse thrust (roll-out)
  touch_* tyres meeting the runway     rumble  any jet far away                 air    airframe noise on approach

Phone speakers play little under 250 Hz, so the low end of the big engines is driven (tanh) into harmonics they can play.
"""
import os, sys, wave
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '../../assets/sound')
LSR, SSR = 24000, 32000      # loops, one-shots
TAU = 2 * np.pi


# ── building blocks ─────────────────────────────────────────────────────────
def rng(seed): return np.random.default_rng(seed)

def unit(x):
    return x / (np.sqrt(np.mean(x * x)) + 1e-12)

def pnoise(n, sr, shape, seed):
    """Periodic noise with the magnitude shape(f)."""
    r = rng(seed); f = np.fft.rfftfreq(n, 1 / sr)
    mag = np.where(f > 0, shape(np.maximum(f, 1e-6)), 0) * np.sqrt(-np.log(r.random(len(f)) + 1e-12))
    return unit(np.fft.irfft(mag * np.exp(1j * TAU * r.random(len(f))), n))

def hump(fc, lo=1.0, hi=1.5):
    """Rises as f^lo to fc, falls as f^-hi past it."""
    return lambda f: 1 / ((fc / f) ** lo + (f / fc) ** hi)

def band(a, b, k=4):
    return lambda f: 1 / np.sqrt((1 + (a / f) ** (2 * k)) * (1 + (f / b) ** (2 * k)))

def wob(n, sr, lo, hi, seed):
    """Slow periodic noise (rms 1) between lo and hi Hz."""
    return pnoise(n, sr, band(lo, hi, 3), seed)

def ptone(n, sr, freq, seed=0, jit=0.0, wobble=None):
    """A periodic sine near freq (whole cycles), its phase wandering by jit radians."""
    k = max(1, round(freq * n / sr)); p = TAU * k * np.arange(n) / n + rng(seed).random() * TAU
    if jit: p = p + jit * (wobble if wobble is not None else wob(n, sr, 0.3, 3, seed + 900))
    return np.sin(p)

def drive(x, g): return np.tanh(unit(x) * g)

def env(n, a, d, sr, curve=4.0):
    t = np.arange(n) / sr
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-curve * np.maximum(0, t - a) / d)

def white(n, seed): return rng(seed).standard_normal(n)

def filt(x, sr, shape):
    n = len(x); X = np.fft.rfft(x, 2 * n); f = np.maximum(np.fft.rfftfreq(2 * n, 1 / sr), 1e-6)
    return np.fft.irfft(X * shape(f), 2 * n)[:n]

def sweep(f0, f1, n, sr, curve=1.0):
    f = f0 + (f1 - f0) * (np.arange(n) / n) ** curve
    return np.sin(TAU * np.cumsum(f) / sr)

def place(dst, x, at, sr, g=1.0):
    i = int(at * sr); m = min(len(x), len(dst) - i)
    if m > 0: dst[i:i + m] += g * x[:m]

def fade(x, sr, a=0.002, b=0.01):
    na, nb = int(a * sr), int(b * sr)
    x = x.copy(); x[:na] *= np.linspace(0, 1, na); x[-nb:] *= np.linspace(1, 0, nb)
    return x


SOUNDS = {}
def save(name, x, sr, rms=None, peak=None):
    x = x - np.mean(x) if rms else x
    if rms: x = x / (np.sqrt(np.mean(x * x)) + 1e-12) * rms
    if peak: x = x / (np.max(np.abs(x)) + 1e-12) * peak
    m = np.max(np.abs(x))
    if m > 0.97: x = np.tanh(x / m * 1.2) / np.tanh(1.2) * 0.97
    SOUNDS[name] = (x, sr)
    os.makedirs(OUT, exist_ok=True)
    with wave.open(os.path.join(OUT, name + '.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())


# ── aircraft ────────────────────────────────────────────────────────────────
#        fan tone at idle, shaft rate, jet-noise hump, low-end drive
JETS = {'s': dict(bpf=2300, shaft=150, hump=430, g=1.1), 'm': dict(bpf=1500, shaft=98, hump=270, g=1.4), 'h': dict(bpf=880, shaft=60, hump=165, g=2.0)}

def jets():
    n = LSR * 5
    for i, (k, j) in enumerate(JETS.items()):
        s = 100 * (i + 1)
        # idle: two engines a hair apart (they beat), the fan tone and its harmonics over a soft broadband bed
        w1, w2 = wob(n, LSR, 0.2, 1.5, s), wob(n, LSR, 0.2, 1.5, s + 1)
        fan = sum(a * (ptone(n, LSR, j['bpf'] * h, s + h, 0.5 * h, w1) + ptone(n, LSR, j['bpf'] * h * 1.006, s + h + 9, 0.5 * h, w2)) for h, a in ((1, 1.0), (2, 0.45), (3, 0.16)))
        core = ptone(n, LSR, j['bpf'] * 2.63, s + 31, 0.8, w2) * 0.22          # the compressor, up high
        hum = sum(ptone(n, LSR, j['shaft'] * h, s + 40 + h, 0.2) / h for h in range(1, 6))
        bed = pnoise(n, LSR, hump(j['bpf'] * 0.45, 1.2, 1.3), s + 2)
        low = pnoise(n, LSR, hump(j['hump'], 1.0, 2.0), s + 3)
        am = 1 + 0.10 * wob(n, LSR, 0.3, 4, s + 4)
        save(f'idle_{k}', (0.30 * fan + core * 0.3 + 0.16 * hum + 0.75 * bed + 0.55 * drive(low, j['g'])) * am, LSR, rms=0.15)
        # power: jet mixing noise, its crackle, and the fan's buzz-saw
        mix = pnoise(n, LSR, hump(j['hump'], 0.9, 1.15), s + 5)
        crk = np.maximum(0, wob(n, LSR, 12, 70, s + 6)) ** 2 * pnoise(n, LSR, band(j['hump'] * 1.5, 5200, 2), s + 7)
        r = rng(s + 8); buzz = sum((0.4 + r.random()) / (1 + 0.1 * h) * ptone(n, LSR, j['shaft'] * 1.7 * h, s + 60 + h, 0.15) for h in range(3, 20))
        am = 1 + 0.13 * wob(n, LSR, 0.5, 9, s + 9)
        save(f'roar_{k}', drive((mix + 0.30 * unit(crk) + 0.13 * unit(buzz)) * am, 0.9 * j['g']), LSR, rms=0.19)
        # reverse: the same jet thrown forward: harsher, hollow, buzzier
        rv = pnoise(n, LSR, lambda f, c=j['hump']: hump(c * 2.1, 1.0, 1.0)(f) * (1 + 0.6 * np.cos(f / (c * 0.55))), s + 10)
        am = 1 + 0.22 * wob(n, LSR, 3, 16, s + 11)
        save(f'rev_{k}', drive((rv + 0.32 * unit(buzz) + 0.35 * unit(crk)) * am, 1.5), LSR, rms=0.18)

def prop():
    n = LSR * 5
    for name, blade, p in (('prop_idle', 88, 0.6), ('prop_power', 120, 1.0)):
        w = wob(n, LSR, 0.2, 1.2, 701)
        bl = sum((1 / h ** 0.75) * (ptone(n, LSR, blade * h, 710 + h, 0.12 * h, w) + ptone(n, LSR, blade * 1.011 * h, 730 + h, 0.12 * h, w)) for h in range(1, 15))
        wash = pnoise(n, LSR, hump(520, 1, 1.2), 702) * (1 + 0.45 * ptone(n, LSR, blade, 703))
        tur = ptone(n, LSR, 2950 * (0.8 + 0.2 * p), 704, 0.8) + 0.5 * ptone(n, LSR, 4100, 705, 0.8)
        save(name, drive(0.8 * unit(bl) + 0.6 * p * unit(wash) + 0.12 * unit(tur), 1.2), LSR, rms=0.15 + 0.03 * p)

def shared_loops():
    n = LSR * 6
    save('rumble', drive(pnoise(n, LSR, hump(150, 1, 1.7), 800) * (1 + 0.3 * wob(n, LSR, 0.4, 5, 801)), 1.6), LSR, rms=0.17)
    save('air', pnoise(n, LSR, hump(750, 1.3, 1.4), 810) * (1 + 0.18 * wob(n, LSR, 0.5, 6, 811)), LSR, rms=0.14)
    # wheels rolling on concrete: a low drone with the slab joints ticking by
    roll = pnoise(n, LSR, hump(210, 1, 1.5), 815); t = np.arange(n) / LSR
    joints = sum(np.exp(-((t * 4 - i - 0.5) ** 2) * 900) for i in range(24)) * pnoise(n, LSR, band(120, 900, 2), 816)
    save('roll', 0.9 * roll + 0.9 * joints, LSR, rms=0.12)
    # pushback tug: diesel knock, gears, and its reversing beep
    f = 27; ph = TAU * round(f * n / LSR) * np.arange(n) / n
    knock = np.maximum(0, np.sin(ph)) ** 6 * (1 + 0.35 * np.sin(ph / 2)) 
    die = unit(knock * pnoise(n, LSR, hump(330, 1, 1.4), 820)) + 0.5 * sum(ptone(n, LSR, f * h, 821 + h, 0.1) / h for h in range(2, 9))
    beep = np.zeros(n); b = int(0.42 * LSR); tone = np.sin(TAU * 1180 * np.arange(b) / LSR) * np.minimum(1, np.minimum(np.arange(b), b - np.arange(b)) / 200)
    for i in range(6): beep[int(i * LSR):int(i * LSR) + b] += tone
    save('tug', 0.8 * unit(die) + 0.16 * beep, LSR, rms=0.13)
    # APU: a steady small turbine behind a gate
    save('apu', 0.9 * pnoise(n, LSR, hump(620, 1.2, 1.3), 830) + 0.35 * ptone(n, LSR, 780, 831, 0.5) + 0.18 * ptone(n, LSR, 1570, 832, 0.5), LSR, rms=0.11)

def ambience():
    n = LSR * 14
    # the field at night: wind off the bay with slow gusts, the airport's far hum, the highway, crickets in the grass
    g = wob(n, LSR, 0.07, 0.4, 840)
    wind = pnoise(n, LSR, hump(330, 1.0, 1.5), 841) * (1 + 0.45 * g) + 0.25 * pnoise(n, LSR, band(700, 1900, 2), 842) * np.maximum(0, g) ** 1.5
    hum = pnoise(n, LSR, hump(140, 1, 2), 843) + 0.2 * sum(ptone(n, LSR, h, 844 + i, 0.1) for i, h in enumerate((120, 240, 360)))
    road = pnoise(n, LSR, hump(520, 1, 1.6), 850) * (1 + 0.3 * wob(n, LSR, 0.1, 0.6, 851))
    t = np.arange(n) / LSR; crick = np.zeros(n)
    for i, (f, rate, sh) in enumerate(((4350, 3, 0.0), (4710, 2.5, 0.4), (4020, 3.5, 0.7))):
        rate = round(rate * 14) / 14; ph = (t * rate + sh) % 1
        crick += ptone(n, LSR, f, 860 + i) * (ph < 0.32) * np.maximum(0, np.sin(TAU * ph / 0.32 * 1.5)) ** 2 * (0.5 + 0.5 * np.clip(wob(n, LSR, 0.07, 0.3, 870 + i), 0, 2))
    save('amb_field', unit(wind) + 0.55 * unit(hum) + 0.35 * unit(road) + 0.09 * unit(crick), LSR, rms=0.10)
    n = LSR * 8
    # the radar room: air conditioning, equipment fans, mains
    room = unit(pnoise(n, LSR, hump(260, 1, 1.8), 880)) + 0.22 * sum(ptone(n, LSR, f, 881 + i, 0.1) for i, f in enumerate((120, 240, 396))) + 0.05 * ptone(n, LSR, 3150, 890, 0.4)
    save('amb_scope', room, LSR, rms=0.08)
    n = LSR * 8
    save('amb_home', unit(pnoise(n, LSR, hump(290, 1, 1.6), 895)) * (1 + 0.35 * wob(n, LSR, 0.12, 0.5, 896)) + 0.12 * (ptone(n, LSR, 110, 897, .2) + ptone(n, LSR, 165, 898, .2) + ptone(n, LSR, 220, 899, .2)), LSR, rms=0.09)
    n = LSR * 3
    save('static', pnoise(n, LSR, band(500, 2900, 3), 905) * (1 + 0.25 * wob(n, LSR, 2, 20, 906)), LSR, rms=0.08)

def touchdowns():
    for i, (k, f, thump, dur, gap) in enumerate((('s', 2500, 95, 0.9, 0.05), ('m', 2050, 76, 1.15, 0.065), ('h', 1550, 58, 1.6, 0.085))):
        n = int(dur * SSR); x = np.zeros(n); s = 1000 + 50 * i
        for c in range(2 if k != 'h' else 4):                                # each bogie's chirp
            m = int((0.10 + 0.03 * i) * SSR); t = np.arange(m) / SSR
            sq = filt(white(m, s + c), SSR, band(f * 0.75, f * 1.35, 3)); sq = unit(sq) * (1 + 0.5 * np.sin(TAU * f * 0.9 * t))
            place(x, sq * env(m, 0.004, 0.07 + 0.03 * i, SSR, 3.5), 0.012 + c * gap, SSR, 0.5)
            th = sweep(thump * 2.2, thump, int(0.28 * SSR), SSR, 0.5) * env(int(0.28 * SSR), 0.003, 0.2, SSR, 4)
            place(x, np.tanh(2.2 * th), 0.012 + c * gap, SSR, 0.55)
        ru = unit(filt(white(n, s + 20), SSR, hump(thump * 3.2, 1, 1.5))) * env(n, 0.06, dur * 0.8, SSR, 3)
        place(x, ru, 0, SSR, 0.35)
        save(f'touch_{k}', fade(x, SSR, 0.001, 0.08), SSR, peak=0.9)


# ── interface ───────────────────────────────────────────────────────────────
def click(f=2600, d=0.022, seed=1, body=340):
    n = int((d + 0.02) * SSR)
    x = unit(filt(white(n, seed), SSR, band(f * 0.6, f * 1.6, 2))) * env(n, 0.0006, d * 0.5, SSR, 4)
    return x * 0.5 + 0.5 * sweep(body * 1.3, body, n, SSR) * env(n, 0.001, d, SSR, 4)

def bell(f, d, g=1.0, bright=0.22):
    n = int(d * SSR); t = np.arange(n) / SSR
    x = np.sin(TAU * f * t) + bright * np.sin(TAU * 2 * f * t) * np.exp(-9 * t) + 0.10 * np.sin(TAU * 3.01 * f * t) * np.exp(-16 * t)
    return g * fade(x * env(n, 0.004, d * 0.7, SSR, 4), SSR, 0.002, 0.012)

def seq(total, *items):
    x = np.zeros(int(total * SSR))
    for at, s in items: place(x, s, at, SSR)
    return x

def radio_burst(d, seed, lo=700, hi=3000):
    n = int(d * SSR)
    return unit(filt(white(n, seed), SSR, band(lo, hi, 3)))

def interface():
    P = lambda name, x, peak: save(name, fade(x, SSR, 0.0008, 0.008), SSR, peak=peak)
    P('tap', click(2500, 0.016, 1, 420), 0.34)
    P('key', click(3600, 0.010, 2, 700), 0.26)
    P('select', seq(0.16, (0, click(3000, 0.012, 3, 620) * 0.6), (0.012, bell(1174, 0.13, 0.45))), 0.36)
    P('swipe', unit(filt(white(int(0.17 * SSR), 4), SSR, band(600, 3200, 2))) * np.sin(np.pi * np.linspace(0, 1, int(0.17 * SSR))) ** 2, 0.22)
    P('open', seq(0.24, (0, unit(filt(white(int(.16 * SSR), 5), SSR, band(400, 2200, 2))) * np.linspace(0, 1, int(.16 * SSR)) ** 1.5 * 0.25 * np.linspace(1, 0, int(.16 * SSR)) ** 0.4), (0.06, bell(784, 0.16, 0.35))), 0.32)
    P('close', seq(0.22, (0, unit(filt(white(int(.14 * SSR), 6), SSR, band(300, 1500, 2))) * np.linspace(1, 0, int(.14 * SSR)) ** 2 * 0.22), (0.01, bell(523, 0.15, 0.32))), 0.28)
    P('view', seq(0.22, (0, click(2100, 0.018, 7, 300)), (0.05, click(2900, 0.014, 8, 460) * 0.8)), 0.36)
    P('toggle_on', seq(0.2, (0, click(2400, 0.016, 9, 420) * 0.7), (0.03, bell(988, 0.15, 0.4))), 0.36)
    P('toggle_off', seq(0.2, (0, click(2000, 0.016, 10, 330) * 0.7), (0.03, bell(587, 0.15, 0.4))), 0.34)
    P('ai_on', seq(0.5, (0, bell(587, .16, .4)), (.09, bell(880, .16, .4)), (.18, bell(1319, .28, .45))), 0.42)
    P('ai_off', seq(0.45, (0, bell(1175, .16, .4)), (.09, bell(784, .16, .4)), (.18, bell(523, .24, .4))), 0.38)
    P('start', seq(1.1, (0, click(1800, .02, 11, 260)), (.04, bell(392, .7, .35)), (.14, bell(587, .7, .35)), (.24, bell(784, .8, .4)), (.36, bell(1175, .7, .3))), 0.5)
    P('done', seq(0.9, (0, bell(659, .3, .4)), (.11, bell(880, .3, .4)), (.22, bell(1319, .6, .45))), 0.45)
    # radio
    P('ptt_on', seq(.12, (0, click(1900, .02, 12, 240)), (.02, radio_burst(.06, 13) * np.linspace(1, 0, int(.06 * SSR)) * .35)), 0.4)
    P('ptt_off', seq(.22, (0, radio_burst(.09, 14) * np.linspace(1, .2, int(.09 * SSR)) * .4), (.09, click(1500, .02, 15, 210))), 0.4)
    P('squelch_open', radio_burst(.055, 16) * np.linspace(1, .4, int(.055 * SSR)), 0.26)
    P('squelch_close', radio_burst(.13, 17) * np.linspace(1, 0, int(.13 * SSR)) ** 1.6, 0.3)
    P('transmit', seq(.16, (0, click(2200, .016, 18, 380)), (.025, radio_burst(.05, 19) * np.linspace(1, 0, int(.05 * SSR)) * .3), (.05, bell(1568, .09, .25))), 0.4)
    P('readback', seq(.32, (0, bell(659, .14, .4)), (.09, bell(831, .2, .4))), 0.34)
    P('request', seq(.5, (0, bell(1047, .22, .45)), (.16, bell(1047, .3, .35))), 0.42)
    P('handoff', seq(.3, (0, sweep(880, 1320, int(.09 * SSR), SSR) * env(int(.09 * SSR), .004, .09, SSR, 2) * .5), (.08, bell(1319, .2, .4))), 0.36)
    P('resolve', seq(.5, (0, bell(523, .16, .4)), (.08, bell(659, .16, .4)), (.16, bell(784, .32, .45))), 0.4)
    P('score_up', seq(.4, (0, bell(784, .14, .4)), (.08, bell(1175, .3, .4))), 0.34)
    P('score_down', seq(.45, (0, bell(220, .2, .6, .5)), (.12, bell(165, .3, .6, .5))), 0.5)
    P('error', seq(.34, (0, np.tanh(3 * bell(196, .12, .8, .6))), (.15, np.tanh(3 * bell(165, .17, .8, .6)))), 0.42)
    P('undo', sweep(760, 320, int(.13 * SSR), SSR) * env(int(.13 * SSR), .004, .12, SSR, 3), 0.3)
    P('pause', seq(.26, (0, bell(659, .12, .4)), (.09, bell(440, .16, .4))), 0.34)
    P('resume', seq(.26, (0, bell(440, .12, .4)), (.09, bell(659, .16, .4))), 0.34)
    P('alert_info', bell(880, .25, .5), 0.4)
    P('alert_warning', seq(.6, (0, bell(622, .2, .6, .5)), (.2, bell(622, .3, .6, .5))), 0.6)
    sq = lambda f, d: fade(np.tanh(2.5 * np.sin(TAU * f * np.arange(int(d * SSR)) / SSR)), SSR, .003, .006)
    P('alert_critical', seq(1.0, *[(i * .12, sq(1000 if i % 2 else 800, .115)) for i in range(8)]), 0.6)
    P('emergency', seq(1.9, *[(i * .16, sq(740, .09)) for i in range(3)], (.6, np.tanh(1.8 * sweep(600, 920, int(.6 * SSR), SSR)) * .8), (1.22, np.tanh(1.8 * sweep(920, 600, int(.6 * SSR), SSR)) * .8)), 0.62)


# ── checks: numbers, since nobody is listening while this runs ───────────────
LOOPS = [f'{a}_{k}' for a in ('idle', 'roar', 'rev') for k in JETS] + ['prop_idle', 'prop_power', 'rumble', 'air', 'roll', 'tug', 'apu', 'amb_field', 'amb_scope', 'amb_home', 'static']
def centroid(x, sr):
    X = np.abs(np.fft.rfft(x)) ** 2; f = np.fft.rfftfreq(len(x), 1 / sr); return float((X * f).sum() / X.sum())
def check():
    bad = []
    for k, (x, sr) in SOUNDS.items():
        if np.max(np.abs(x)) > 0.98: bad.append(f'{k} clips')
        if k in LOOPS:
            d = np.abs(np.diff(x)); j = abs(x[0] - x[-1])                     # the seam's step against the loop's own steps
            if j > np.quantile(d, 0.9995): bad.append(f'{k} seam {j:.3f}')
    for a in ('idle', 'roar', 'rev'):
        c = [centroid(*SOUNDS[f'{a}_{k}']) for k in 'smh']; print(f'{a:5} brightness s/m/h (Hz):', *(round(v) for v in c))
        if not c[0] > c[1] > c[2]: bad.append(f'{a}: bigger is not darker')
    for k in 'smh':                                                          # what a phone speaker can play of the roar
        x, sr = SOUNDS[f'roar_{k}']; X = np.abs(np.fft.rfft(x)) ** 2; f = np.fft.rfftfreq(len(x), 1 / sr); print(f'roar_{k}: {100 * X[f > 250].sum() / X.sum():.0f}% of its energy above 250 Hz')
    tot = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)); print(f'{len(SOUNDS)} sounds, {tot / 1e6:.1f} MB;', 'problems: ' + '; '.join(bad) if bad else 'all checks pass')
    return not bad

if __name__ == '__main__':
    jets(); prop(); shared_loops(); ambience(); touchdowns(); interface()
    sys.exit(0 if check() else 1)
