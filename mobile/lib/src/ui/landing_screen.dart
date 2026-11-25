// The landing page, in portrait, as the web's (src/app/landing/Landing.tsx): the SFO film scrubbed by your finger,
// ten chapters (radar -> approach -> landing -> taxi in -> an A380 pushing back -> its route, spoken -> take-off ->
// the two seats -> play), the data blocks and labels riding on the film, the chapter copy, and at the end the ways
// in: the tutorial, a shift at SFO in any seat, your own set-up, the speech model.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/services.dart';

import '../audio/film_sound.dart';
import '../audio/sfx.dart';
import '../game/airports.dart';
import '../game/game_controller.dart';
import 'landing_film.dart';
import 'logo_mark.dart';
import 'theme.dart';

const _radar = Color(0xFF5CFFB0), _amber = Color(0xFFFFB35C), _cyan = Color(0xFF74D6FF), _ink = Color(0xFFE9EDF2), _ink2 = Color(0xBDE9EDF2), _ink3 = Color(0x80E9EDF2);
const _mono = TextStyle(fontFamily: 'DMMono', fontFeatures: [FontFeature.tabularFigures()]);

// the site (Landing.tsx SITE)
const _icao = 'KSFO', _iata = 'SFO', _arr = '28R', _dep = '1R', _clock0 = 3 * 3600 + 41 * 60 + 12;
const _atis = 'ATIS B · WIND 280/16 · ILS 28R · DEP 1R';
const _stats = [(4, 'runways'), (246, 'taxiways'), (295, 'stands'), (177, 'hold-short points')];
const _approach = ['ASA331 HDG 250 THEN DESCEND 3000', 'DAL40 CLEARED ILS 28R', 'DAL40 CONTACT TOWER'];
const _land = ['Delta four-zero, wind two-eight-zero at one-six, runway two-eight right, cleared to land.', 'Cleared to land two-eight right, Delta four-zero.'];
const _push = 'ETD24 PUSHBACK APPROVED', _voice = 'ETD24 RWY 1R TAXI VIA M4 M1', _gnd = 'GND 121.80';
const _takeoff = ['Etihad two-four, wind two-eight-zero at one-six, runway one right, cleared for take-off.', 'Cleared for take-off one right, Etihad two-four.'];
const _strips = [('hero', 'DAL40', 'A359'), ('dep', 'ETD24', 'A388'), ('a1', 'ASA331', 'A320')];
const _txOn = {'hero': (201.0, 262.0), 'dep': (304.0, 352.0)};
const _chapters = [
  ('scope', 'Radar', 0, 44), ('field', 'The airport', 44, 96), ('approach', 'Approach', 96, 146), ('final', 'Landing', 146, 212), ('taxiin', 'Taxi in', 212, 262),
  ('push', 'Pushback', 262, 304), ('route', 'Taxi out', 304, 352), ('takeoff', 'Take-off', 352, 404), ('ai', 'AI seat', 404, 448), ('outro', 'Play', 448, 480),
];
const _anchorLabels = {'ARR': 'RWY $_arr', 'DEP': 'RWY $_dep', 'TWR': '$_iata TOWER', 'CITY': 'SAN FRANCISCO', 'JFK': _icao, '5NM': 'TOWER · 5 NM', '13NM': 'APPROACH · 13 NM', '10NM': '10 NM'};

String _pad(num n, [int w = 2]) => n.floor().toString().padLeft(w, '0');
String _ft(num n) {
  final s = n.round().toString();
  return s.replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
}

class LandingScreen extends StatefulWidget {
  const LandingScreen({super.key, required this.config, required this.speechInstalled, required this.speechLabel, required this.onStart, required this.onSpeechModel, required this.onLearn, this.onAbout, this.startFrame = 0});
  final ShiftConfig config;
  final bool speechInstalled;
  final String speechLabel;
  final void Function(ShiftConfig) onStart;
  final VoidCallback onSpeechModel;
  final VoidCallback onLearn;
  final VoidCallback? onAbout;

  /// Story frame to open on (tests render chapters with it).
  final int startFrame;

  @override
  State<LandingScreen> createState() => _LandingScreenState();
}

class _LandingScreenState extends State<LandingScreen> with SingleTickerProviderStateMixin {
  final _cache = FrameCache();
  Tracks? _tracks;
  late final AnimationController _fling = AnimationController.unbounded(vsync: this)..addListener(_onFling);
  late double _u = kWarpCum(widget.startFrame);   // swipe position in warped units (wraps)
  double _lastFling = 0;
  int _dir = 1;
  late ShiftConfig _cfg = widget.config;
  final Map<String, double> _signAt = {};

  @override
  void initState() {
    super.initState();
    _cache.want(widget.startFrame, 1);
    Tracks.load().then((t) {
      for (final I in t.instr) {
        for (final w in I.words) {
          if (w.twy) _signAt['${I.who == 'hero' ? 'H' : 'D'}:${w.w}'] = w.f;
        }
      }
      if (mounted) setState(() => _tracks = t);
    }).catchError((Object _) {});
    _sound = Timer.periodic(const Duration(milliseconds: 100), (_) => mounted ? _hear() : null);
    // a slow drift on its own until the first touch, so the film is alive on arrival
    _drift = Timer.periodic(const Duration(milliseconds: 33), (_) {
      if (!_touched && mounted && _fr < 40) _move(0.035);
    });
  }

  // the film's sound follows the swipe (film_sound.dart)
  Timer? _sound;
  double _energy = 0, _heard = -1;
  int _chap = 0;

  void _hear() {
    _energy *= 0.9;
    final fr = _fr, c = math.max(0, _chapters.indexWhere((c) => fr >= c.$3 && fr < c.$4));
    if (ModalRoute.of(context)?.isCurrent == false) {
      Sfx.I.world(const {}, const []);   // the setup sheet is up
    } else {
      Sfx.I.world(filmLoops(fr, _energy), _heard >= 0 && _touched ? filmShots(_heard, fr) : const []);
      if (c != _chap && _touched) Sfx.I.ui('swipe');
    }
    _chap = c;
    _heard = fr;
  }

  Timer? _drift;
  bool _touched = false;

  @override
  void dispose() {
    _drift?.cancel();
    _sound?.cancel();
    Sfx.I.world(const {}, const []);
    _fling.dispose();
    _cache.dispose();
    super.dispose();
  }

  double get _fr => unwarp(_u % kWarpTotal);
  double _unitPx(BuildContext c) => MediaQuery.sizeOf(c).height * 0.034;   // one story frame per 3.4 % of the screen (3.4vh)

  void _move(double du) {
    if (du == 0) return;
    _dir = du > 0 ? 1 : -1;
    _energy = math.min(1, _energy + du.abs() * 0.25);
    setState(() => _u = (_u + du) % kWarpTotal);
    _cache.want(_fr.floor(), _dir);
  }

  void _onFling() {
    final v = _fling.value;
    _move(v - _lastFling);
    _lastFling = v;
  }

  void _dragStart(DragStartDetails _) {
    _touched = true;
    _fling.stop();
  }

  void _dragUpdate(DragUpdateDetails d) => _move(-d.delta.dy / _unitPx(context));

  void _dragEnd(DragEndDetails d) {
    final v = -d.velocity.pixelsPerSecond.dy / _unitPx(context);
    _lastFling = 0;
    _fling.value = 0;
    _fling.animateWith(FrictionSimulation(0.12, 0, v));
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final pad = MediaQuery.paddingOf(context);
    final fr = _fr;
    final ff = (fr * kSub).clamp(0.0, kFilm - 1.0);
    final ci = math.max(0, _chapters.indexWhere((c) => fr >= c.$3 && fr < c.$4));
    final T = _tracks;
    final fw = T?.w ?? 1080, fh = T?.h ?? 1920;
    final scale = math.max(size.width / fw, size.height / fh);
    final ox = (size.width - fw * scale) / 2, oy = (size.height - fh * scale) / 2;
    Offset sxy(double x, double y) => Offset(ox + x * scale, oy + y * scale);
    final copyTop = size.height * 0.56;   // the chapter copy holds the bottom of the screen: labels fade above it
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: const Color(0xFF04050A),
        body: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onVerticalDragStart: _dragStart,
          onVerticalDragUpdate: _dragUpdate,
          onVerticalDragEnd: _dragEnd,
          child: Stack(children: [
            Positioned.fill(child: RepaintBoundary(child: CustomPaint(painter: FilmPainter(_cache, fr)))),
            const Positioned.fill(
              child: IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, stops: [0, 0.18, 0.5, 0.78, 1], colors: [Color(0xB304050A), Color(0x0004050A), Color(0x0004050A), Color(0xA604050A), Color(0xF204050A)])),
                ),
              ),
            ),
            if (T != null) ..._tags(T, fr, ff, sxy, size, copyTop),
            if (T != null) ..._anchors(T, fr, ff, sxy, size, copyTop),
            // the HUD: clock and ATIS, the camera's altitude
            Positioned(left: 16, top: pad.top + 62, child: IgnorePointer(child: _hudLeft(T, ff))),
            Positioned(right: 14, top: pad.top + 62, child: IgnorePointer(child: _altBox(T, ff))),
            // nav
            Positioned(left: 0, right: 0, top: 0, child: _nav(pad, ci)),
            Positioned(left: 14, right: 14, top: pad.top + 50, child: IgnorePointer(child: _progress(fr, ci))),
            // the chapter copy
            Positioned(left: 18, right: 18, bottom: pad.bottom + 18, child: _copy(T, fr, ff)),
            // swipe cue
            Positioned(
              left: 0, right: 0, top: size.height * 0.42,
              child: IgnorePointer(
                child: Opacity(
                  opacity: (1 - smooth(2, 14, fr)) * (fr < 240 ? 1 : 0),
                  child: Column(children: [
                    Text('SWIPE UP TO FLY', style: _mono.copyWith(fontSize: 11, letterSpacing: 2.4, color: _ink2)),
                    const SizedBox(height: 6),
                    const Icon(Icons.keyboard_arrow_up_rounded, color: _ink2),
                  ]),
                ),
              ),
            ),
          ]),
        ),
      ),
    );
  }

  // ── on the film ──

  List<Widget> _tags(Tracks T, double fr, double ff, Offset Function(double, double) sxy, Size size, double copyTop) {
    final i0 = ff.floor().clamp(0, kFilm - 1), i1 = (i0 + 1) % kFilm, t = ff - ff.floor();
    final key = _chapters[math.max(0, _chapters.indexWhere((c) => fr >= c.$3 && fr < c.$4))].$1;
    double edge(double a, double b) => smooth(a, a + 5, fr) * (1 - smooth(b - 5, b, fr));
    final mode = key == 'scope' || key == 'outro' || (key == 'field' && fr < 70) ? 'radar' : key;
    final ch = _chapters.firstWhere((c) => c.$1 == key);
    final fade = key == 'scope' ? 1 - smooth(39, 44, fr) : key == 'outro' ? smooth(452, 460, fr) : edge(ch.$3.toDouble(), ch.$4.toDouble());
    final out = <Widget>[];
    if (fade <= 0.001) return out;
    for (final r in T.f[i0]) {
      final ac = T.ac[r[0].toInt()];
      final ok = switch (mode) {
        'radar' => r[3] > 0,
        'approach' => ac.kind == 'arr' && r[3] > 0,
        'final' || 'taxiin' => ac.id == 'hero',
        'push' => (ac.id == 'dep' || ac.id == 'hero' || ac.id == 'a1') && r[6] > 8,
        'route' || 'takeoff' => ac.id == 'dep',
        _ => false,
      };
      if (!ok || out.length >= 12) continue;
      final q = T.f[i1].where((b) => b[0] == r[0]).firstOrNull;
      final x = q != null ? r[1] + (q[1] - r[1]) * t : r[1], y = q != null ? r[2] + (q[2] - r[2]) * t : r[2];
      final p = sxy(x, y);
      if (p.dx < -40 || p.dx > size.width + 40 || p.dy < -40 || p.dy > size.height + 40) continue;
      final ph = T.phases[r[5].toInt()];
      final c = ac.kind == 'dep' ? _amber : _radar;
      final o = fade * (1 - smooth(copyTop - 70, copyTop - 20, p.dy));
      if (o <= 0.01) continue;
      final flip = p.dx > size.width - (mode == 'radar' ? 90 : 150);
      final lines = <Widget>[];
      Text b(String s) => Text(s, style: _mono.copyWith(fontSize: 11, fontWeight: FontWeight.w700, color: mode == 'radar' ? c : Colors.white, letterSpacing: 0.6));
      Text e(String s) => Text(s, style: _mono.copyWith(fontSize: 10, color: _ink3));
      Text sp(String s) => Text(s, style: _mono.copyWith(fontSize: 10.5, color: c));
      if (mode == 'radar') {
        lines.addAll([b(ac.cs), sp('${_pad((r[3] / 100).round(), 3)} ${_pad((r[4] / 10).round(), 2)}')]);
      } else if (mode == 'approach') {
        lines.addAll([b(ac.cs), e(ac.type), sp('${_ft((r[3] / 10).round() * 10)} ft · ${r[4].round()} kt'), sp(ph)]);
      } else if (mode == 'final') {
        lines.addAll([b(ac.cs), e('${ac.type} · ${ac.airline}'), sp(fr < 200 ? 'CLEARED TO LAND $_arr' : 'LANDED $_arr')]);
      } else {
        lines.addAll([b(ac.cs), e(ac.type), sp(ph)]);
      }
      out.add(Positioned(
        left: flip ? null : p.dx - 4,
        right: flip ? size.width - p.dx - 4 : null,
        top: p.dy - (mode == 'radar' ? 38 : 50),
        child: IgnorePointer(
          child: Opacity(
            opacity: o.clamp(0.0, 1.0),
            child: Column(crossAxisAlignment: flip ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
              Container(
                padding: mode == 'radar' ? EdgeInsets.zero : const EdgeInsets.fromLTRB(7, 4, 8, 5),
                margin: EdgeInsets.only(left: flip ? 0 : 18, right: flip ? 18 : 0),
                decoration: mode == 'radar' ? null : BoxDecoration(color: const Color(0xB304050A), border: Border(left: flip ? BorderSide.none : BorderSide(color: c, width: 2), right: flip ? BorderSide(color: c, width: 2) : BorderSide.none)),
                child: Column(crossAxisAlignment: flip ? CrossAxisAlignment.end : CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: lines),
              ),
              Padding(
                padding: EdgeInsets.only(top: mode == 'radar' ? 14 : 22),
                child: Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: c, boxShadow: [BoxShadow(color: c.withValues(alpha: 0.6), blurRadius: 8)])),
              ),
            ]),
          ),
        ),
      ));
    }
    return out;
  }

  List<Widget> _anchors(Tracks T, double fr, double ff, Offset Function(double, double) sxy, Size size, double copyTop) {
    final i0 = ff.floor().clamp(0, kFilm - 1), i1 = (i0 + 1) % kFilm, t = ff - ff.floor();
    double edge(double a, double b) => smooth(a, a + 5, fr) * (1 - smooth(b - 5, b, fr));
    final radarMode = fr < 44 || fr >= 448 || (fr >= 44 && fr < 70);
    final radarFade = fr < 44 ? 1 - smooth(39, 44, fr) : fr >= 448 ? smooth(452, 460, fr) : 1.0;
    double show(String k) {
      if (k.startsWith('H:')) {
        final a = _signAt[k] ?? 212;
        return smooth(a, a + 1.2, fr) * (1 - smooth(256, 262, fr));
      }
      if (k.startsWith('D:')) {
        final a = _signAt[k] ?? 310;
        return smooth(a, a + 1.2, fr) * (1 - smooth(346, 352, fr));
      }
      if (k.startsWith('G')) return edge(128, 196);
      return switch (k) {
        'ARR' => edge(96, 212), 'CITY' => edge(100, 212), 'TWR' => edge(262, 352), 'DEP' => edge(304, 404),
        'JFK' => radarMode ? radarFade : 0, '5NM' => edge(406, 446), '13NM' => edge(406, 446), '10NM' => edge(0, 44) + smooth(452, 462, fr),
        _ => 0,
      };
    }

    final out = <Widget>[];
    for (var ix = 0; ix < T.anchors.length; ix++) {
      final k = T.anchors[ix];
      final o0 = show(k);
      final p = T.an[i0][ix], q = T.an[i1][ix];
      if (p == null || o0 <= 0.001) continue;
      final x = q != null ? p.x + (q.x - p.x) * t : p.x, y = q != null ? p.y + (q.y - p.y) * t : p.y;
      final s = sxy(x, y);
      final o = (o0 * (1 - smooth(copyTop - 50, copyTop - 10, s.dy))).clamp(0.0, 1.0);
      if (o <= 0.01) continue;
      final twy = k.startsWith('H:') || k.startsWith('D:');
      final gate = k.startsWith('G');
      final label = twy ? k.substring(2) : gate ? '${k.substring(1)} NM · ${_ft(((int.parse(k.substring(1)) * 318 + 50) / 10).round() * 10)} FT' : _anchorLabels[k] ?? k;
      final color = k == '5NM' ? _amber : k == '13NM' ? _cyan : gate ? _radar : _ink;
      out.add(Positioned(
        left: s.dx,
        top: s.dy,
        child: IgnorePointer(
          child: FractionalTranslation(
            translation: const Offset(-0.5, -0.5),
            child: Opacity(
              opacity: o,
              child: twy
                  ? Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(color: const Color(0xFF111111), border: Border.all(color: const Color(0xFFF2C230), width: 1.5), borderRadius: BorderRadius.circular(3)),
                      child: Text(label, style: _mono.copyWith(fontSize: 12, fontWeight: FontWeight.w800, color: const Color(0xFFF2C230))),
                    )
                  : Container(
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                      decoration: BoxDecoration(color: const Color(0x9904050A), border: Border.all(color: color.withValues(alpha: 0.55)), borderRadius: BorderRadius.circular(3)),
                      child: Text(label, style: _mono.copyWith(fontSize: 10, letterSpacing: 1.2, color: color)),
                    ),
            ),
          ),
        ),
      ));
    }
    return out;
  }

  // ── chrome ──

  Widget _nav(EdgeInsets pad, int ci) => Container(
        padding: EdgeInsets.fromLTRB(16, pad.top + 8, 10, 8),
        child: Row(children: [
          const LogoMark(size: 18),
          const SizedBox(width: 6),
          const Text('OpenATC', style: TextStyle(letterSpacing: 0.4, fontWeight: FontWeight.w800, fontSize: 13.5)),
          const SizedBox(width: 10),
          Container(width: 6, height: 6, decoration: const BoxDecoration(color: _radar, shape: BoxShape.circle)),
          const SizedBox(width: 4),
          Text(_icao, style: _mono.copyWith(fontSize: 11, color: _ink2)),
          const Spacer(),
          Text('${_pad(ci + 1)} / ${_pad(_chapters.length)}', style: _mono.copyWith(fontSize: 11, color: _ink3)),
          const SizedBox(width: 6),
          Text(_chapters[ci].$2, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: () => widget.onStart(_cfg),
            style: FilledButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 14)),
            child: Text(_cfg.icao == _icao ? 'Play' : 'Play ${airportOf(_cfg.icao).iata}'),
          ),
        ]),
      );

  Widget _progress(double fr, int ci) => Row(children: [
        for (final (i, c) in _chapters.indexed)
          Expanded(
            child: Container(
              height: 2.5,
              margin: const EdgeInsets.symmetric(horizontal: 1.5),
              decoration: BoxDecoration(color: _ink.withValues(alpha: i == ci ? 0.25 : 0.12), borderRadius: BorderRadius.circular(2)),
              child: FractionallySizedBox(alignment: Alignment.centerLeft, widthFactor: clamp01((fr - c.$3) / (c.$4 - c.$3)), child: Container(color: i == ci ? AtcColors.accent : _ink2)),
            ),
          ),
      ]);

  Widget _hudLeft(Tracks? T, double ff) {
    var secs = 0.0;
    if (T != null) {
      final i0 = ff.floor().clamp(0, kFilm - 1), i1 = (i0 + 1) % kFilm;
      secs = T.t[i0] + (T.t[i1] - T.t[i0]) * (ff - ff.floor());
    }
    final b = _clock0 + secs;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('${_pad((b / 3600) % 24)}:${_pad((b / 60) % 60)}:${_pad(b % 60)}Z', style: _mono.copyWith(fontSize: 12, color: _ink)),
      Text(_atis, style: _mono.copyWith(fontSize: 9, color: _ink3)),
    ]);
  }

  Widget _altBox(Tracks? T, double ff) {
    var alt = 0.0;
    if (T != null) {
      final i0 = ff.floor().clamp(0, kFilm - 1), i1 = (i0 + 1) % kFilm;
      alt = T.cam[i0] + (T.cam[i1] - T.cam[i0]) * (ff - ff.floor());
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
      Text.rich(TextSpan(children: [TextSpan(text: _ft((alt / 10).round() * 10), style: const TextStyle(fontWeight: FontWeight.w700, color: _ink)), const TextSpan(text: ' FT')]), style: _mono.copyWith(fontSize: 12, color: _ink3)),
      Text('CAMERA', style: _mono.copyWith(fontSize: 9, letterSpacing: 1.6, color: _ink3)),
    ]);
  }

  // ── the chapter copy ──

  Widget _copy(Tracks? T, double fr, double ff) {
    final arts = <Widget>[];
    // [a, b, c, d]: in from a to b, out from c to d (a == b: shown from the start)
    void art(double a, double b, double c, double d, List<Widget> Function(double lp) lines) {
      final p = a == b ? 1 - smooth(c, d, fr) : smooth(a, b, fr) * (1 - smooth(c, d, fr));
      if (p <= 0.002) return;
      final lp = smooth(a, b + (c - b) * 0.5, fr);
      final ls = lines(a == b ? 1 : lp);
      final tin = a == b ? 1.0 : clamp01((fr - a) / (b - a));   // the lines come in one after another over the in-ramp
      arts.add(IgnorePointer(
        ignoring: p < 0.6,
        child: Opacity(
          opacity: p.clamp(0.0, 1.0),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            for (final (i, w) in ls.indexed)
              Builder(builder: (_) {
                final k = clamp01(tin * 2.2 - i * 0.25);
                return Opacity(opacity: k, child: Transform.translate(offset: Offset(0, (1 - k) * 14), child: Padding(padding: const EdgeInsets.only(bottom: 8), child: w)));
              }),
          ]),
        ),
      ));
    }

    Widget eyebrow(String s) => Text(s.toUpperCase(), style: _mono.copyWith(fontSize: 11, letterSpacing: 1.8, color: AtcColors.accent));
    Widget h1(String s) => Text(s, style: const TextStyle(fontSize: 36, height: 1.05, fontWeight: FontWeight.w800, letterSpacing: -0.5));
    Widget h2(String s) => Text(s, style: const TextStyle(fontSize: 27, height: 1.1, fontWeight: FontWeight.w800, letterSpacing: -0.3));
    Widget body(String s) => Text(s, style: const TextStyle(fontSize: 14.5, height: 1.45, color: _ink2));
    Widget code(String s) => Container(
          margin: const EdgeInsets.only(right: 6, bottom: 6),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
          decoration: BoxDecoration(color: const Color(0x2E5CFFB0), borderRadius: BorderRadius.circular(6), border: Border.all(color: const Color(0x555CFFB0))),
          child: Text(s, style: _mono.copyWith(fontSize: 11.5, color: _radar, fontWeight: FontWeight.w700)),
        );
    String typed(String full, double a, double b) => full.substring(0, (clamp01((fr - a) / (b - a)) * full.length).round());
    Widget radio(String who, String text, double a, double b, {bool pilot = false}) => Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 56, child: Text(who, style: _mono.copyWith(fontSize: 11, fontWeight: FontWeight.w800, color: pilot ? _amber : _radar))),
            Expanded(child: Text(typed(text, a, b), style: const TextStyle(fontSize: 14, height: 1.4))),
          ]),
        );
    Widget hud(List<(String, String, String)> xs) => Row(children: [
          for (final x in xs)
            Padding(
              padding: const EdgeInsets.only(right: 18),
              child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                Text('${x.$1} ', style: _mono.copyWith(fontSize: 10, color: _ink3)),
                Text(x.$2, style: _mono.copyWith(fontSize: 20, fontWeight: FontWeight.w700)),
                Text(' ${x.$3}', style: _mono.copyWith(fontSize: 10, color: _ink3)),
              ]),
            ),
        ]);
    Widget cta(String label, VoidCallback on, {bool primary = true}) => Padding(
          padding: const EdgeInsets.only(right: 8, bottom: 8),
          child: primary
              ? FilledButton(onPressed: on, style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14)), child: Text(label))
              : OutlinedButton(onPressed: on, style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14), foregroundColor: _ink), child: Text(label)),
        );

    // live numbers from the tracks
    List<double>? row(String id) {
      if (T == null) return null;
      final ix = T.ac.indexWhere((a) => a.id == id);
      return T.f[ff.floor().clamp(0, kFilm - 1)].where((r) => r[0] == ix).firstOrNull;
    }

    final hero = row('hero'), dep = row('dep');

    art(0, 0, 26, 42, (_) => [
          eyebrow('Air traffic control simulator · $_icao'),
          h1('Take the frequency at $_iata.'),
          Text.rich(TextSpan(children: [
            const TextSpan(text: 'Vector it, sequence it, land it. Push it, taxi it, launch it. Real traffic into San Francisco International, on your phone, '),
            TextSpan(text: 'with your voice', style: TextStyle(color: AtcColors.accent.withValues(alpha: 1), fontStyle: FontStyle.italic, fontWeight: FontWeight.w700)),
            const TextSpan(text: '.'),
          ]), style: const TextStyle(fontSize: 15.5, height: 1.45, color: _ink2)),
          Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [cta('Play now', () => widget.onStart(_cfg)), Text('Free · works offline · swipe, it loops', style: _mono.copyWith(fontSize: 10.5, color: _ink3))]),
        ]);
    art(50, 64, 84, 95, (lp) => [
          eyebrow('01 · The airport'),
          h2('The real $_iata, every line of it.'),
          body('Built from OpenStreetMap: the runways, every taxiway, every stand and hold-short line. Taxi routes are found on the real network, with turns a 747 can actually make.'),
          Wrap(spacing: 16, runSpacing: 6, children: [
            for (final (n, l) in _stats)
              Text.rich(TextSpan(children: [TextSpan(text: '${(n * (1 - math.pow(1 - lp, 3))).round()} ', style: _mono.copyWith(fontSize: 20, fontWeight: FontWeight.w800, color: _ink)), TextSpan(text: l, style: const TextStyle(fontSize: 12, color: _ink3))])),
          ]),
        ]);
    art(100, 112, 136, 145, (_) => [
          eyebrow('02 · Approach'),
          h2('Build the line into 28 Right.'),
          body('Turn arrivals off the downwind, descend them through each other, slot them onto the ILS at 30° or less. Three miles or a thousand feet, more behind a heavy.'),
          Wrap(children: [for (final c in _approach) code(c)]),
        ]);
    art(152, 164, 204, 211, (_) => [
          eyebrow('03 · Tower'),
          h2('Cleared to land.'),
          Column(children: [radio('TWR', _land[0], 160, 184), radio('DAL40', _land[1], 186, 198, pilot: true)]),
          hud([
            ('ALT', _ft(math.max(0, ((hero?[3] ?? 1200) / 10).round() * 10)), 'FT'),
            ('IAS', '${(hero?[4] ?? 140).round()}', 'KT'),
            ('THR', hero == null || hero[3] <= 0 ? '0.0' : (math.max(0, hero[3] - 50) / 318).toStringAsFixed(1), 'NM'),
          ]),
        ]);
    art(216, 226, 252, 261, (_) => [
          eyebrow('04 · Ground'),
          h2('The way in, decided.'),
          body('Ground picks the route on the real taxiway network. Each taxiway’s centreline lights come on as the controller names it, and the aircraft follows the greens: off the runway, across the parallel, onto the stand.'),
        ]);
    art(268, 278, 294, 303, (_) => [
          eyebrow('05 · Pushback'),
          h2('Across the apron, an A380 wants out.'),
          Wrap(children: [code(_push)]),
          Wrap(spacing: 6, runSpacing: 6, children: [for (final s in _strips) _strip(T, ff, s.$1, s.$2, s.$3)]),
        ]);
    art(305, 312, 344, 351, (_) => [
          eyebrow('06 · Voice'),
          h2('Say it. It lights up.'),
          body('Hold the mic and give the taxi instruction the way a controller would. It is read while you speak, the taxiway lights come on along the route, and the pilot reads it back.'),
          _voiceDemo(fr),
        ]);
    art(356, 364, 396, 403, (_) => [
          eyebrow('07 · Tower'),
          h2('Cleared for take-off.'),
          Column(children: [radio('TWR', _takeoff[0], 357, 372), radio('ETD24', _takeoff[1], 374, 384, pilot: true)]),
          hud([('ALT', _ft(math.max(0, ((dep?[3] ?? 0) / 10).round() * 10)), 'FT'), ('IAS', '${(dep?[4] ?? 0).round()}', 'KT')]),
        ]);
    art(408, 416, 440, 447, (_) => [
          eyebrow('08 · Two seats'),
          h2('Work one seat. Hand the AI the other.'),
          body('Tower runs the ground and the runways, Approach runs the sky. Either can be you or the AI, and you can swap mid-session.'),
          Row(children: [_seat('Tower', fr < 418), const SizedBox(width: 8), _seat('Approach', fr >= 428 && fr < 436)]),
          Text('Tested over 4,500 whole shifts before launch: more than 22,000 landings.', style: _mono.copyWith(fontSize: 10.5, color: _ink3)),
        ]);
    art(452, 462, 600, 601, (_) => [
          eyebrow('Free · on your phone · works offline'),
          h1('Your scope. Your sky.'),
          Wrap(children: [cta('New here? Learn the ropes', widget.onLearn), cta('Choose an airport', _setup, primary: false)]),
          Row(children: [
            for (final (pos, name, what) in const [('tower', 'Tower', 'Ground, pushbacks, runways'), ('approach', 'Approach', 'Vector and sequence the arrivals')])
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: InkWell(
                    onTap: () => widget.onStart(_cfg.copyWith(position: pos)),
                    borderRadius: BorderRadius.circular(12),
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: const Color(0x8C0E1014), borderRadius: BorderRadius.circular(12), border: Border.all(color: _ink.withValues(alpha: 0.15))),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(name, style: const TextStyle(fontWeight: FontWeight.w800)), Text(what, style: const TextStyle(fontSize: 12, color: _ink3))]),
                    ),
                  ),
                ),
              ),
          ]),
          Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            TextButton(onPressed: () => widget.onStart(_cfg.copyWith(icao: _icao)), child: const Text('Jump in at $_iata')),
            TextButton(onPressed: widget.onSpeechModel, child: Text(widget.speechInstalled ? 'Speech model ✓' : 'Download the speech model')),
            TextButton(onPressed: widget.onAbout, child: const Text('About, privacy, credits')),
            Text('keep swiping and it loops', style: _mono.copyWith(fontSize: 10.5, color: _ink3)),
          ]),
        ]);

    // the radio altimeter's callouts and the touchdown, over the landing
    final overlays = <Widget>[];
    if (hero != null && fr > 150 && fr < 202 && hero[3] > 0) {
      const calls = [(1000, '1000'), (500, '500'), (400, '400'), (300, '300'), (200, 'MINIMUMS'), (100, '100'), (50, '50'), (40, '40'), (30, '30'), (20, '20'), (10, 'RETARD'), (0, '')];
      for (var i = 0; i < calls.length - 1; i++) {
        final (hi, txt) = calls[i];
        final lo = calls[i + 1].$1;
        if (hero[3] <= hi && hero[3] > lo) {
          final q = (hi - hero[3]) / (hi - lo);
          overlays.add(Opacity(
            opacity: (1 - smooth(0.75, 1, q)).clamp(0.0, 1.0),
            child: Transform.scale(scale: 1.22 - 0.22 * smooth(0, 0.3, q), child: Text(txt, style: _mono.copyWith(fontSize: 34, fontWeight: FontWeight.w800, color: txt == 'MINIMUMS' || txt == 'RETARD' ? _amber : _radar))),
          ));
          break;
        }
      }
    }
    final touch = smooth(197, 200, fr) * (1 - smooth(210, 216, fr));
    if (touch > 0.01) {
      overlays.add(Opacity(opacity: touch, child: Text('TOUCHDOWN · RWY $_arr', style: _mono.copyWith(fontSize: 16, fontWeight: FontWeight.w800, letterSpacing: 2, color: _radar))));
    }
    final tx = _txBox(T, fr, ff);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (final o in overlays) Padding(padding: const EdgeInsets.only(bottom: 14), child: Center(child: o)),
      ?tx,
      Stack(children: arts),
    ]);
  }

  Widget _strip(Tracks? T, double ff, String id, String cs, String ty) {
    var st = 'AT GATE';
    if (T != null) {
      final ix = T.ac.indexWhere((a) => a.id == id);
      final r = T.f[ff.floor().clamp(0, kFilm - 1)].where((q) => q[0] == ix).firstOrNull;
      if (r != null) st = T.phases[r[5].toInt()];
    }
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
      decoration: BoxDecoration(color: const Color(0xB30E1014), border: const Border(left: BorderSide(color: _amber, width: 3)), borderRadius: BorderRadius.circular(4)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Text(cs, style: _mono.copyWith(fontSize: 11, fontWeight: FontWeight.w800)),
        const SizedBox(width: 6),
        Text(ty, style: _mono.copyWith(fontSize: 10, color: _ink3)),
        const SizedBox(width: 6),
        Text(st, style: _mono.copyWith(fontSize: 10, color: _amber)),
      ]),
    );
  }

  Widget _seat(String name, bool you) => Expanded(
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: const Color(0x8C0E1014), borderRadius: BorderRadius.circular(10), border: Border.all(color: _ink.withValues(alpha: 0.15))),
          child: Row(children: [
            Text(name, style: const TextStyle(fontWeight: FontWeight.w800)),
            const Spacer(),
            AnimatedContainer(
              duration: const Duration(milliseconds: 250),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: you ? AtcColors.accent : _cyan.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(10)),
              child: Text(you ? 'You' : 'AI', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: you ? Colors.black : _cyan)),
            ),
          ]),
        ),
      );

  /// The mic held while the taxi instruction is spoken: the waveform, the parsed line typed out, the time to readback.
  Widget _voiceDemo(double fr) {
    final vp = clamp01((fr - 305) / 8.5);
    final talk = vp > 0 && vp < 1 ? math.sin(vp * math.pi) : 0.0;
    final l = smooth(316, 325, fr);
    final parsed = _voice.substring(0, (clamp01((fr - 313) / 3) * _voice.length).round());
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(color: talk > 0 ? AtcColors.bad : const Color(0x33FFFFFF), borderRadius: BorderRadius.circular(6)),
          child: const Icon(Icons.mic_rounded, size: 16),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: SizedBox(
            height: 26,
            child: Row(children: [
              for (var i = 0; i < 36; i++)
                Expanded(
                  child: Align(
                    child: Container(
                      margin: const EdgeInsets.symmetric(horizontal: 0.8),
                      height: 26 * (0.06 + talk * (0.25 + 0.75 * (math.sin(i * 1.7 + fr * 1.9) * math.cos(i * 0.6 + fr * 0.77)).abs())),
                      decoration: BoxDecoration(color: _radar, borderRadius: BorderRadius.circular(1)),
                    ),
                  ),
                ),
            ]),
          ),
        ),
      ]),
      const SizedBox(height: 8),
      if (parsed.isNotEmpty) Text(parsed, style: _mono.copyWith(fontSize: 12, color: _radar, fontWeight: FontWeight.w700)),
      const SizedBox(height: 6),
      Opacity(
        opacity: l,
        child: Row(children: [
          for (final (w, name) in const [(0.3, 'speech'), (0.3, 'command'), (0.4, 'pilot voice')])
            Expanded(
              flex: (w * 10).round(),
              child: Padding(
                padding: const EdgeInsets.only(right: 3),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Container(height: 4, color: _cyan.withValues(alpha: 0.8)),
                  Text(name, style: _mono.copyWith(fontSize: 9, color: _ink3)),
                ]),
              ),
            ),
        ]),
      ),
      Opacity(opacity: l, child: Text('≈ 1.1 s from release to readback', style: _mono.copyWith(fontSize: 11, color: _ink))),
    ]);
  }

  /// The controller's taxi instruction, a word at a time; the taxiways as yellow-on-black signs, the one the aircraft
  /// is on now lit (Landing.tsx makeTx / overlay).
  Widget? _txBox(Tracks? T, double fr, double ff) {
    if (T == null || T.instr.isEmpty) return null;
    final ipr = T.ip.isEmpty ? const <double>[] : T.ip[ff.round().clamp(0, T.ip.length - 1)];
    for (final (ix, I) in T.instr.indexed) {
      final on = _txOn[I.who];
      if (on == null) continue;
      final o = smooth(on.$1, on.$1 + 1.5, fr) * (1 - smooth(on.$2 - 4, on.$2, fr));
      if (o <= 0.001) continue;
      final sa = ix < ipr.length ? ipr[ix] : -1;
      var lit = -1;
      if (sa >= 0) {
        for (final (j, g) in I.segs.indexed) {
          if (sa >= g.s0 - 0.5 && sa < g.s1 - 0.5 && fr >= g.f) lit = j;
        }
      }
      var seg = 0;
      final words = <Widget>[];
      for (final w in I.words) {
        final k = smooth(w.f - 0.05, w.f + 0.55, fr);
        final back = 1 + 2.4 * math.pow(k - 1, 3) + 1.4 * math.pow(k - 1, 2);
        final s = w.twy ? seg++ : -1;
        final litNow = s >= 0 && s == lit, past = s >= 0 && lit >= 0 && s < lit;
        words.add(Opacity(
          opacity: k,
          child: Transform.translate(
            offset: Offset(0, (1 - k) * 10),
            child: Transform.scale(
              scale: 0.72 + 0.28 * back,
              child: w.twy
                  ? Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                      decoration: BoxDecoration(color: litNow ? const Color(0xFFF2C230) : const Color(0xFF111111), border: Border.all(color: const Color(0xFFF2C230), width: 1.5), borderRadius: BorderRadius.circular(3)),
                      child: Text(w.w, style: _mono.copyWith(fontSize: 13, fontWeight: FontWeight.w800, color: litNow ? const Color(0xFF111111) : const Color(0xFFF2C230).withValues(alpha: past ? 0.5 : 1))),
                    )
                  : Text(w.w, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
            ),
          ),
        ));
      }
      return Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Opacity(
          opacity: o,
          child: Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: const Color(0xB304050A), borderRadius: BorderRadius.circular(10), border: Border.all(color: _radar.withValues(alpha: 0.3))),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [Container(width: 6, height: 6, decoration: const BoxDecoration(color: _radar, shape: BoxShape.circle)), const SizedBox(width: 6), Text(_gnd, style: _mono.copyWith(fontSize: 10.5, color: _radar))]),
              const SizedBox(height: 6),
              Wrap(spacing: 5, runSpacing: 5, crossAxisAlignment: WrapCrossAlignment.center, children: words),
            ]),
          ),
        ),
      );
    }
    return null;
  }

  // ── your own shift ──

  Future<void> _setup() async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AtcColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) {
          Widget seg(String label, List<(String, String)> opts, String value, void Function(String) on) => Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(label.toUpperCase(), style: const TextStyle(fontSize: 11, letterSpacing: 1.2, fontWeight: FontWeight.w700, color: AtcColors.muted)),
                  const SizedBox(height: 8),
                  SegmentedButton<String>(
                    segments: [for (final o in opts) ButtonSegment(value: o.$1, label: Text(o.$2))],
                    selected: {value},
                    showSelectedIcon: false,
                    onSelectionChanged: (s) => set(() => on(s.first)),
                  ),
                ]),
              );
          return SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Your shift at ${airportOf(_cfg.icao).iata}', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                const SizedBox(height: 4),
                const Text('The AI works the other seat. Swap any time.', style: TextStyle(color: AtcColors.muted, fontSize: 13)),
                const SizedBox(height: 14),
                AirportGrid(value: _cfg.icao, onPick: (i) => set(() => _cfg = _cfg.copyWith(icao: i))),
                const SizedBox(height: 16),
                seg('Your seat', const [('tower', 'Tower'), ('approach', 'Approach')], _cfg.position, (v) => _cfg = _cfg.copyWith(position: v)),
                seg('Traffic', const [('low', 'Quiet'), ('normal', 'Normal'), ('high', 'Busy')], _cfg.difficulty, (v) => _cfg = _cfg.copyWith(difficulty: v)),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(widget.speechInstalled ? Icons.mic_rounded : Icons.download_rounded, color: widget.speechInstalled ? AtcColors.good : AtcColors.accent),
                  title: Text(widget.speechInstalled ? 'Voice ready' : 'Download the speech model'),
                  subtitle: Text(widget.speechInstalled ? '${widget.speechLabel} · runs on this phone' : 'Talk to your traffic. Runs on the phone, once downloaded.', style: const TextStyle(color: AtcColors.muted, fontSize: 12)),
                  onTap: () {
                    Navigator.pop(ctx);
                    widget.onSpeechModel();
                  },
                ),
                const SizedBox(height: 8),
                FilledButton(
                  onPressed: () {
                    Navigator.pop(ctx);
                    widget.onStart(_cfg);
                  },
                  style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
                  child: const Text('Start your shift'),
                ),
              ]),
            ),
          );
        },
      ),
    );
    if (mounted) setState(() {});
  }
}

