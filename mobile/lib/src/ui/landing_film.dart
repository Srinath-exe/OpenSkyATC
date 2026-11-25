// The web landing's film (src/app/landing/Landing.tsx), on the phone: one loop of SFO rendered offline from the game's
// airport data, the portrait cut (public/landing/sfo-p), scrubbed by your finger. Swipe up to fly; it loops. On top,
// as on the web: data blocks on the traffic and labels on places (tracks.json, the film's own camera), the HUD, the
// chapter copy with its typed radio lines, the radio altimeter's callouts, the spoken taxi instruction, the seats.
//
// Frames: 480 story frames (every 3rd film frame) at 720 x 1280 WebP in assets/landing/f; the film is drawn with a
// cross-fade to the next frame, the overlays follow the film frame on screen (film frame = story frame x 3).

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

const int kStory = 480, kSub = 3, kFilm = 1440;

/// Story frames that take more swipe (Landing.tsx WARP): the taxi-in a little quicker, the outro held longer.
const _warp = [(216, 260, 0.6), (452, 476, 2.6)];
final List<double> _cum = () {
  final c = List<double>.filled(kStory + 1, 0);
  for (var i = 0; i < kStory; i++) {
    final f = i + 0.5;
    var w = 1.0;
    for (final (a, b, k) in _warp) {
      if (f >= a && f < b) w = k;
    }
    c[i + 1] = c[i] + w;
  }
  return c;
}();
double get kWarpTotal => _cum[kStory];

/// Swipe units at the start of story frame [i].
double kWarpCum(int i) => _cum[i.clamp(0, kStory)];

/// Swipe units (0..kWarpTotal) -> story frame (0..480).
double unwarp(double u) {
  final x = u.clamp(0.0, kWarpTotal);
  var lo = 0, hi = kStory;
  while (hi - lo > 1) {
    final m = (lo + hi) >> 1;
    if (_cum[m] <= x) {
      lo = m;
    } else {
      hi = m;
    }
  }
  final d = _cum[lo + 1] - _cum[lo];
  return lo + (x - _cum[lo]) / (d == 0 ? 1 : d);
}

double clamp01(double v) => v.clamp(0.0, 1.0);
double smooth(double a, double b, double v) {
  final t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// ── tracks.json ──────────────────────────────────────────────────────────────

class TrackAc {
  TrackAc(Map<String, dynamic> j) : id = j['id'] as String, cs = j['cs'] as String, type = j['type'] as String, kind = j['kind'] as String, airline = j['airline'] as String? ?? '';
  final String id, cs, type, kind, airline;
}

class TrackInstr {
  TrackInstr(Map<String, dynamic> j)
      : who = j['who'] as String,
        words = [for (final w in j['words'] as List) (w: (w as Map)['w'] as String, f: (w['f'] as num).toDouble(), twy: w['twy'] == true)],
        segs = [for (final g in j['segs'] as List) (s0: ((g as Map)['s0'] as num).toDouble(), s1: (g['s1'] as num).toDouble(), f: (g['f'] as num).toDouble())];
  final String who;
  final List<({String w, double f, bool twy})> words;
  final List<({double s0, double s1, double f})> segs;
}

class Tracks {
  Tracks(Map<String, dynamic> j)
      : w = (j['w'] as num).toDouble(),
        h = (j['h'] as num).toDouble(),
        phases = (j['phases'] as List).cast<String>(),
        anchors = (j['anchors'] as List).cast<String>(),
        ac = [for (final a in j['ac'] as List) TrackAc(a as Map<String, dynamic>)],
        f = [for (final fr in j['f'] as List) [for (final r in fr as List) (r as List).map((v) => (v as num).toDouble()).toList()]],
        an = [for (final fr in j['an'] as List) [for (final p in fr as List) p is List ? (x: (p[0] as num).toDouble(), y: (p[1] as num).toDouble()) : null]],
        cam = (j['cam'] as List).map((v) => (v as num).toDouble()).toList(),
        t = (j['t'] as List).map((v) => (v as num).toDouble()).toList(),
        instr = [for (final i in (j['instr'] as List? ?? const [])) TrackInstr(i as Map<String, dynamic>)],
        ip = [for (final r in (j['ip'] as List? ?? const [])) (r as List).map((v) => (v as num).toDouble()).toList()];
  final double w, h;
  final List<String> phases, anchors;
  final List<TrackAc> ac;

  /// Per film frame: [ac index, x, y, ft, kt, phase, px length].
  final List<List<List<double>>> f;
  final List<List<({double x, double y})?>> an;
  final List<double> cam, t;
  final List<TrackInstr> instr;
  final List<List<double>> ip;

  static Future<Tracks> load() async => Tracks(jsonDecode(await rootBundle.loadString('assets/landing/tracks.json')) as Map<String, dynamic>);
}

// ── the frames ───────────────────────────────────────────────────────────────

/// Decoded story frames around the playhead (about 2 MB each decoded; ~40 kept), loaded ahead in the swipe direction.
class FrameCache extends ChangeNotifier {
  final Map<int, ui.Image> _img = {};
  final Set<int> _loading = {};
  int _want = 0, _dir = 1;
  bool _disposed = false;

  ui.Image? get(int i) => _img[i % kStory];

  /// The nearest decoded frame to [i] (the film never shows black while a fast swipe outruns the decoder).
  int nearest(int i) {
    for (var d = 0; d < kStory ~/ 2; d++) {
      if (_img.containsKey((i + d) % kStory)) return (i + d) % kStory;
      if (_img.containsKey((i - d + kStory) % kStory)) return (i - d + kStory) % kStory;
    }
    return -1;
  }

  void want(int i, int dir) {
    _want = i % kStory;
    _dir = dir == 0 ? _dir : dir;
    _pump();
  }

  void _pump() {
    if (_disposed) return;
    final order = <int>[];
    for (var d = 0; d < 22; d++) {
      order.add((_want + _dir * d + kStory) % kStory);
      if (d < 8) order.add((_want - _dir * d + kStory) % kStory);
    }
    for (final i in order) {
      if (_loading.length >= 3) break;
      if (_img.containsKey(i) || _loading.contains(i)) continue;
      _loading.add(i);
      unawaited(_load(i));
    }
    // drop what is far from the playhead
    if (_img.length > 44) {
      final far = _img.keys.where((k) {
        final d = (k - _want).abs();
        return math.min(d, kStory - d) > 24;
      }).toList();
      for (final k in far) {
        _img.remove(k)?.dispose();
      }
    }
  }

  Future<void> _load(int i) async {
    try {
      final data = await rootBundle.load('assets/landing/f/${i.toString().padLeft(3, '0')}.webp');
      final codec = await ui.instantiateImageCodec(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      final fr = await codec.getNextFrame();
      codec.dispose();
      if (_disposed) {
        fr.image.dispose();
        return;
      }
      _img[i]?.dispose();
      _img[i] = fr.image;
      notifyListeners();
    } catch (_) {
      // a missing frame: its neighbours stand in
    } finally {
      _loading.remove(i);
      _pump();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    for (final im in _img.values) {
      im.dispose();
    }
    _img.clear();
    super.dispose();
  }
}

/// The film, covering the screen: frame [i] with [t] of the next cross-faded over it.
class FilmPainter extends CustomPainter {
  FilmPainter(this.cache, this.fr) : super(repaint: cache);
  final FrameCache cache;
  final double fr;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF04050A));
    final i0 = fr.floor() % kStory, t = fr - fr.floor();
    final a = cache.nearest(i0);
    if (a < 0) return;
    void put(ui.Image im, double alpha) {
      final s = math.max(size.width / im.width, size.height / im.height);
      final w = im.width * s, h = im.height * s;
      final dst = Rect.fromLTWH((size.width - w) / 2, (size.height - h) / 2, w, h);
      canvas.drawImageRect(im, Rect.fromLTWH(0, 0, im.width.toDouble(), im.height.toDouble()), dst, Paint()
        ..filterQuality = FilterQuality.medium
        ..color = Color.fromRGBO(255, 255, 255, alpha));
    }

    put(cache.get(a)!, 1);
    final b = cache.get(i0 + 1);
    if (a == i0 && b != null && t > 0.02) put(b, t);
  }

  @override
  bool shouldRepaint(covariant FilmPainter old) => old.fr != fr;
}
