#!/usr/bin/env python3
"""The game's sounds: real recordings (CC0) for the body, synth.py for what the recordings cannot give (a modern
high-bypass fan tone per size, radio, alarms), Kenney's interface sounds (CC0) for buttons.

  SRC=dir python3 mobile/tool/sound/fetch_sources.py      once
  SRC=dir python3 mobile/tool/sound/build.py              writes mobile/assets/sound/*.wav and runs the checks
"""
import os, sys, subprocess
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as S

SRC = os.environ['SRC']
L = S.LSR

def load(name, sr=L):
    b = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(SRC, name + '.wav'), '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(b, '<f4').astype(float)

def clip(name, at, dur, rate=1.0, sr=L):
    """`dur` seconds of the recording from `at`, played at `rate` (lower = a bigger engine), rumble and tape hum cut."""
    x = load(name, sr)[int(at * sr):int((at + dur * rate) * sr)]
    n = int(dur * sr)
    x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    return S.filt(x, sr, lambda f: 1 / np.sqrt(1 + (55 / f) ** 6))

def loop(name, at, dur=5.0, rate=1.0, xf=0.8):
    """A seamless loop: the slow level drift evened out, the tail cross-faded (equal power) under the head."""
    n, m = int(dur * L), int(xf * L)
    x = clip(name, at, dur + xf, rate)
    k = int(0.35 * L); e = np.sqrt(np.convolve(np.pad(x, (k, k), 'reflect') ** 2, np.ones(k) / k, 'same')[k:-k]) + 1e-6
    x = x * (np.mean(e) / e) ** 0.8
    a = np.sin(np.linspace(0, np.pi / 2, m))
    y = x[:n].copy(); y[:m] = y[:m] * a + x[n:n + m] * a[::-1]
    return S.unit(y)

def synth_of(name): return S.unit(S.SOUNDS[name][0])

def jets():
    #       idle recording       roar recording          reverse
    real = {'s': (('taxi_tarmac', 70, 1.0), ('whine', 49.5, 1.12), ('taxi_in', 53.5, 1.15)),
            'm': (('wait_to', 34, 1.0), ('large_takeoff', 33.8, 1.0), ('taxi_in', 53.5, 0.92)),
            'h': (('idle26', 52, 0.85), ('const10', 13.5, 1.0), ('taxi_in', 53.5, 0.68))}
    for k, (i, r, v) in real.items():
        S.save(f'idle_{k}', 0.72 * loop(i[0], i[1], rate=i[2]) + 0.62 * synth_of(f'idle_{k}'), L, rms=0.15)
        S.save(f'roar_{k}', np.tanh(1.15 * (0.85 * loop(r[0], r[1], rate=r[2]) + 0.5 * synth_of(f'roar_{k}'))), L, rms=0.19)
        S.save(f'rev_{k}', np.tanh(1.2 * (0.8 * loop(v[0], v[1], rate=v[2]) + 0.55 * synth_of(f'rev_{k}'))), L, rms=0.18)
    S.save('prop_idle', 0.45 * loop('prop_idle', 9.8) + 0.8 * synth_of('prop_idle'), L, rms=0.15)
    S.save('prop_power', 0.5 * loop('prop_steady', 51, rate=1.15) + 0.8 * synth_of('prop_power'), L, rms=0.18)
    S.save('rumble', np.tanh(1.3 * (0.9 * loop('const19', 9.5, 6) + 0.5 * synth_of('rumble'))), L, rms=0.17)
    S.save('air', 0.8 * loop('const20', 15, 6) + 0.6 * synth_of('air'), L, rms=0.14)

def spools():
    """Engines winding down at the gate ('Jet Engine Starts and Stops'), and the same backwards: winding up."""
    d = clip('starts', 92, 8.0); d = S.unit(d) * np.linspace(1, 0, len(d)) ** 0.6
    S.save('spool_down', S.fade(d, L, 0.4, 0.6), L, peak=0.6)
    S.save('spool_up', S.fade(d[::-1].copy(), L, 1.2, 0.5), L, peak=0.6)

def touch():
    sk = load('skid', S.SSR); a = int(0.10 * S.SSR); sk = sk[a:a + int(0.5 * S.SSR)]
    for k, rate in (('s', 1.15), ('m', 1.0), ('h', 0.78)):
        n = int(len(sk) / rate); y = np.interp(np.linspace(0, len(sk) - 1, n), np.arange(len(sk)), sk)
        base = S.SOUNDS[f'touch_{k}'][0].copy()
        S.place(base, S.fade(y / np.max(np.abs(y)), S.SSR, 0.003, 0.1), 0.01, S.SSR, 0.75)
        if k == 'h': S.place(base, S.fade(y / np.max(np.abs(y)), S.SSR, 0.003, 0.1), 0.19, S.SSR, 0.55)
        S.save(f'touch_{k}', S.fade(base, S.SSR, 0.001, 0.08), S.SSR, peak=0.9)

def field():
    n = 14.0
    wind, air, cr = loop('wind_dull', 12, n, xf=1.5), loop('airport_out', 5.5, n, xf=1.5), loop('crickets', 93, n, xf=1.5)
    cr = S.unit(S.filt(np.tile(cr, 3), L, lambda f: 1 / np.sqrt(1 + (1800 / f) ** 8))[len(cr):2 * len(cr)])
    S.save('amb_field', 0.55 * wind + 0.5 * air + 0.16 * cr + 0.5 * synth_of('amb_field'), L, rms=0.10)

KENNEY = {'tap': ('click_002', .30), 'key': ('tick_002', .22), 'select': ('select_007', .32), 'swipe': ('scratch_001', .16), 'open': ('maximize_009', .30), 'close': ('minimize_009', .26),
          'view': ('switch_004', .34), 'toggle_on': ('toggle_002', .32), 'toggle_off': ('toggle_001', .30), 'ai_on': ('confirmation_002', .40), 'ai_off': ('minimize_008', .34),
          'score_up': ('confirmation_001', .32), 'error': ('error_008', .42), 'resolve': ('confirmation_003', .34), 'undo': ('back_003', .30), 'pause': ('minimize_007', .30), 'resume': ('maximize_007', .30), 'done': ('confirmation_004', .42)}
def buttons():
    for k, (f, peak) in KENNEY.items():
        x = load('kenney/' + f, S.SSR); e = np.where(np.abs(x) > 0.004 * np.abs(x).max())[0]
        S.save(k, S.fade(x[:e[-1] + 1], S.SSR, 0.0005, 0.006), S.SSR, peak=peak)

if __name__ == '__main__':
    S.jets(); S.prop(); S.shared_loops(); S.ambience(); S.touchdowns(); S.interface()
    jets(); spools(); touch(); field(); buttons()
    sys.exit(0 if S.check() else 1)
