// The approach scope, native: what the web's ApproachView paints (src/components/atc/ApproachView/render.ts), from
// the core's radar scene and frame (mobile/core/radar.ts), in the engine's metres (x east, y north), north up.
//
// Touch: one finger pans, two pinch to zoom (the point under the fingers stays put), double-tap zooms in there,
// tap a target to select it. The scope opens framing the airspace above the flight board.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../ui/theme.dart';

const _bg = Color(0xFF0A0D11);
Color _w(double a) => Color.fromRGBO(255, 255, 255, a);
const _lime = Color(0xFFB8F25C), _orange = Color(0xFFF5933F), _red = Color(0xFFFF5A4E), _green = Color(0xFF57CD50);
const _nm = 1852.0;

class RadarView extends StatefulWidget {
  const RadarView({super.key, required this.scene, required this.frame, required this.onSelect, this.bottomInset = 0});
  final Map<String, dynamic> scene;
  final ValueNotifier<Map<String, dynamic>?> frame;
  final void Function(int? id) onSelect;

  /// Screen height covered by the flight board at the bottom (the scope frames the area above it).
  final double bottomInset;

  @override
  State<RadarView> createState() => _RadarViewState();
}

class _RadarViewState extends State<RadarView> {
  Offset _centre = Offset.zero;   // metres, at the middle of the visible area
  double _k = 0;                  // px per metre
  double _k0 = 0;
  Offset _c0 = Offset.zero, _focal0 = Offset.zero;
  Size _size = Size.zero;
  final Map<int, List<Offset>> _hist = {};
  DateTime _histAt = DateTime(2000);
  Offset? _tapAt;

  /// The scope as last drawn: a tap goes to where a target is drawn.
  _ScopePainter? _painter;

  Map<String, dynamic> get _scene => widget.scene;

  @override
  void initState() {
    super.initState();
    widget.frame.addListener(_onFrame);
  }

  @override
  void dispose() {
    widget.frame.removeListener(_onFrame);
    super.dispose();
  }

  void _onFrame() {
    final f = widget.frame.value;
    if (f == null) return;
    // history dots: one every 4 s, the last six (as the web's PositionHistory)
    final now = DateTime.now();
    if (now.difference(_histAt).inMilliseconds >= 4000) {
      _histAt = now;
      final live = <int>{};
      for (final a in (f['ac'] as List).cast<Map<String, dynamic>>()) {
        final id = a['id'] as int;
        live.add(id);
        final p = a['p'] as List;
        final h = _hist.putIfAbsent(id, () => []);
        h.add(Offset((p[0] as num).toDouble(), (p[1] as num).toDouble()));
        if (h.length > 6) h.removeAt(0);
      }
      _hist.removeWhere((id, _) => !live.contains(id));
    }
    if (mounted) setState(() {});
  }

  /// Visible-area height (above the board).
  double get _viewH => math.max(200, _size.height - widget.bottomInset);
  Offset _toScreen(Offset m) => Offset(_size.width / 2 + (m.dx - _centre.dx) * _k, _viewH / 2 - (m.dy - _centre.dy) * _k);
  Offset _toWorld(Offset s) => Offset(_centre.dx + (s.dx - _size.width / 2) / _k, _centre.dy - (s.dy - _viewH / 2) / _k);

  void _frameAirspace() {
    final c = _scene['centre'] as List;
    _centre = Offset((c[0] as num).toDouble(), (c[1] as num).toDouble());
    final r = (_scene['radiusM'] as num).toDouble();
    _k = math.min(_size.width, _viewH) / (2 * r * 0.72);   // the busy inner part of the airspace fills the view
  }

  void _zoomAt(Offset focal, double factor) {
    final before = _toWorld(focal);
    _k = (_k * factor).clamp(0.0004, 0.08);
    final after = _toWorld(focal);
    _centre += before - after;
  }

  void _tap(Offset at) {
    final f = widget.frame.value;
    if (f == null) return;
    int? best;
    var bestD = 30.0;
    for (final a in (f['ac'] as List).cast<Map<String, dynamic>>()) {
      final d = ((_painter?._shown(a) ?? Offset.infinite) - at).distance;
      if (d < bestD) {
        bestD = d;
        best = a['id'] as int;
      }
    }
    if (best != null) HapticFeedback.selectionClick();
    widget.onSelect(best);
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      final first = _k == 0;
      _size = box.biggest;
      if (first) _frameAirspace();
      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapUp: (d) => _tap(d.localPosition),
        onDoubleTapDown: (d) => _tapAt = d.localPosition,
        onDoubleTap: () => setState(() => _zoomAt(_tapAt ?? Offset(_size.width / 2, _viewH / 2), 2)),
        onScaleStart: (d) {
          _k0 = _k;
          _c0 = _centre;
          _focal0 = d.localFocalPoint;
        },
        onScaleUpdate: (d) => setState(() {
          // keep the world point that was under the fingers under them, at the new scale
          _k = (_k0 * d.scale).clamp(0.0004, 0.08);
          final w0 = Offset(_c0.dx + (_focal0.dx - _size.width / 2) / _k0, _c0.dy - (_focal0.dy - _viewH / 2) / _k0);
          _centre = Offset(w0.dx - (d.localFocalPoint.dx - _size.width / 2) / _k, w0.dy + (d.localFocalPoint.dy - _viewH / 2) / _k);
        }),
        child: Stack(children: [
          Positioned.fill(child: CustomPaint(painter: _painter = _ScopePainter(this, widget.frame.value))),
          Positioned(
            right: 12, bottom: widget.bottomInset + 12,
            child: Material(
              color: AtcColors.surface,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: const BorderSide(color: AtcColors.line)),
              child: IconButton(tooltip: 'Whole airspace', icon: const Icon(Icons.zoom_out_map_rounded, size: 22, color: AtcColors.text), onPressed: () => setState(_frameAirspace)),
            ),
          ),
        ]),
      );
    });
  }
}

const _limeBright = Color(0xFFD9FF8A);

/// Parallel approach lines are drawn at least this far apart.
const _gapPx = 38.0;

/// How far apart they have come, `d` NM out (all of it by 5.6 NM).
double _spread(double d) {
  final u = (d / 5.6).clamp(0.0, 1.0);
  return u * (2 - u);
}

class _ScopePainter extends CustomPainter {
  _ScopePainter(this.v, this.frame);
  final _RadarViewState v;
  final Map<String, dynamic>? frame;

  Offset _p(Object? xy) {
    final l = xy as List;
    return v._toScreen(Offset((l[0] as num).toDouble(), (l[1] as num).toDouble()));
  }

  /// This frame's spread of parallel approach lines (metres), with each runway's threshold and course.
  final Map<String, (Offset, Offset, double)> _shift = {};
  Offset _xy(Object? xy) => Offset(((xy as List)[0] as num).toDouble(), (xy[1] as num).toDouble());

  /// Where a target is drawn: on its approach line as it is drawn (it slides over as it closes on its localizer).
  Offset _shown(Map<String, dynamic> a) {
    final w = _xy(a['p']), s = a['ils'] == null ? null : _shift[a['ils']];
    if (s == null) return v._toScreen(w);
    final c = s.$3 * math.pi / 180, e = w - s.$2;
    final lat = (e.dx * math.cos(c) - e.dy * math.sin(c)).abs() / _nm, out = -(e.dx * math.sin(c) + e.dy * math.cos(c)) / _nm;
    final u = ((1.5 - lat) / 1.1).clamp(0.0, 1.0);
    return v._toScreen(w + s.$1 * (u * u * (3 - 2 * u) * _spread(out)));
  }

  void _text(Canvas c, String s, Offset at, {double size = 11, Color? color, FontWeight weight = FontWeight.w400, TextAlign align = TextAlign.left}) {
    final tp = TextPainter(text: TextSpan(text: s, style: TextStyle(fontFamily: AtcFonts.mono, fontSize: size, color: color ?? _w(0.55), fontWeight: weight, fontFeatures: const [FontFeature.tabularFigures()])), textDirection: TextDirection.ltr)..layout();
    final dx = align == TextAlign.center ? -tp.width / 2 : 0.0;
    tp.paint(c, at + Offset(dx, -tp.height / 2));
  }

  void _dashLine(Canvas c, Offset a, Offset b, Paint p, double on, double off) {
    final d = (b - a).distance;
    if (d < 1) return;
    final u = (b - a) / d;
    for (var t = 0.0; t < d; t += on + off) {
      c.drawLine(a + u * t, a + u * math.min(t + on, d), p);
    }
  }

  void _dashCircle(Canvas c, Offset o, double r, Paint p, double on, double off) {
    final n = math.max(8, (2 * math.pi * r / (on + off)).floor());
    final sweep = 2 * math.pi / n * on / (on + off);
    for (var i = 0; i < n; i++) {
      c.drawArc(Rect.fromCircle(center: o, radius: r), 2 * math.pi * i / n, sweep, false, p);
    }
  }

  @override
  void paint(Canvas c, Size size) {
    c.drawRect(Offset.zero & size, Paint()..color = _bg);
    final s = v._scene;
    final pxPerNm = v._k * _nm;
    final line = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;

    // range rings every 5 NM (10 when zoomed out), labelled at 45 degrees
    final centre = _p(s['centre']);
    final step = pxPerNm < 6 ? 10 : 5;
    final maxNm = math.max((s['radiusM'] as num) / _nm, size.longestSide / pxPerNm);
    for (var nm = step; nm <= maxNm + step; nm += step) {
      final r = nm * pxPerNm;
      if (r < 12) continue;
      c.drawCircle(centre, r, line..color = _w(0.07));
      final lp = centre + Offset(r * math.sqrt1_2 + 4, -r * math.sqrt1_2 - 4);
      if (lp.dx > 0 && lp.dx < size.width && lp.dy > 0 && lp.dy < size.height) _text(c, '$nm nm', lp, size: 10, color: _w(0.3));
    }
    // airspace boundary
    _dashCircle(c, centre, (s['radiusM'] as num) * v._k, line..color = _w(0.16), 2, 6);
    // restricted areas
    for (final a in (s['areas'] as List).cast<Map<String, dynamic>>()) {
      final path = Path();
      if (a['shape'] == 'circle' && a['c'] != null && a['r'] != null) {
        path.addOval(Rect.fromCircle(center: _p(a['c']), radius: (a['r'] as num) * v._k));
      } else {
        final pts = (a['pts'] as List).map(_p).toList();
        if (pts.length < 3) continue;
        path.addPolygon(pts, true);
      }
      c.drawPath(path, Paint()..color = const Color(0x0FFF5A4E));
      c.drawPath(path, line..color = const Color(0x40FF5A4E));
    }
    // Approach lines (render.ts drawChart): on the runways taking arrivals. Parallel ones are a few hundred metres apart,
    // one line when zoomed out: the LINES ease apart over the first miles (the runways keep their true places), and an
    // aircraft on one is drawn on it.
    final active = ((frame?['activeArr'] as List?) ?? const []).cast<String>().toSet();
    final all = (s['runways'] as List).cast<Map<String, dynamic>>();
    final boxes = <Rect>[];
    _shift.clear();
    final mates = <String, (double side, double gap)>{};
    for (final r in all) {
      if (!active.contains(r['name'])) continue;
      final t = _xy(r['thr']), course = (r['course'] as num).toDouble(), cr = course * math.pi / 180, n = Offset(math.cos(cr), -math.sin(cr));
      double? cross;
      for (final q in all) {
        if (identical(q, r) || !active.contains(q['name'])) continue;
        final d = (((q['course'] as num) - course + 540) % 360 - 180).abs();
        if (d >= 5) continue;
        final o = t - _xy(q['thr']), x = o.dx * n.dx + o.dy * n.dy;
        if (x.abs() < 2000 && (cross == null || x.abs() < cross.abs())) cross = x;
      }
      if (cross == null || cross.abs() < 1) continue;
      final gapPx = cross.abs() * v._k;
      mates[r['name'] as String] = (-cross.sign, math.max(gapPx, _gapPx) / v._k);
      if (gapPx < _gapPx) _shift[(r['name'] as String).toUpperCase()] = (n * ((_gapPx - gapPx) / 2 / v._k * cross.sign), t, course);
    }
    final range = (s['gsRangeNM'] as num? ?? 18).toDouble(), tanC = math.tan((s['captureDeg'] as num? ?? 2.5) * math.pi / 180);
    for (final r in all) {
      final name = r['name'] as String;
      if (!active.contains(name)) continue;
      final t = _xy(r['thr']), cr = (r['course'] as num) * math.pi / 180, sh = _shift[name.toUpperCase()], mate = mates[name];
      final out = Offset(-math.sin(cr), -math.cos(cr)), right = Offset(math.cos(cr), -math.sin(cr));
      // a point d NM out on the approach as drawn, off metres to its right
      Offset at(double d, [double off = 0]) => v._toScreen(t + out * (d * _nm) + (sh == null ? Offset.zero : sh.$1 * _spread(d)) + right * off);
      const steps = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.6, 8.0, 10.0];
      // the localizer wedge; beside a parallel one it stops half way to it
      List<Offset> edge(double side) => [
            for (final d in [...steps, range])
              at(d, side * math.min(mate != null && mate.$1 == side ? math.max(0.0, mate.$2 / 2 * math.max(_spread(d), 0.1) - 2 / v._k) : double.infinity, d * _nm * tanC)),
          ];
      c.drawPath(Path()..addPolygon([...edge(-1), ...edge(1).reversed], true), Paint()..color = _lime.withValues(alpha: 0.10));
      final centreLine = Paint()
        ..color = _lime.withValues(alpha: 0.9)
        ..strokeWidth = 2;
      for (var i = 1; i < steps.length; i++) {
        _dashLine(c, at(steps[i - 1]), at(steps[i]), centreLine, 10, 6);
      }
      final side = mate == null ? 1.0 : -mate.$1, o = Offset(math.cos(cr) * side, math.sin(cr) * side);   // outward on screen (y down)
      void note(Offset p, String txt, double px, Color colour) {
        final tp = TextPainter(text: TextSpan(text: txt, style: TextStyle(fontFamily: AtcFonts.mono, fontSize: px, fontWeight: FontWeight.w500, color: colour)), textDirection: TextDirection.ltr)..layout();
        final w = tp.width + 10, h = px + 7;
        final box = Rect.fromCenter(center: p + Offset(o.dx * (12 + o.dx.abs() * w / 2), o.dy * (12 + o.dy.abs() * h / 2)), width: w, height: h);
        c.drawRRect(RRect.fromRectAndRadius(box, const Radius.circular(5)), Paint()..color = _bg);
        tp.paint(c, box.center - Offset(tp.width / 2, tp.height / 2));
        boxes.add(box);
      }

      if (pxPerNm > 9) note(at(math.max(3.4, 60 / pxPerNm)), name, 14, Colors.white);
      if (pxPerNm > 8) {
        for (final g in (r['gs'] as List).cast<Map<String, dynamic>>()) {
          final p = at((g['nm'] as num).toDouble());
          c.drawLine(p - o * 7, p + o * 7, Paint()
            ..color = _limeBright
            ..strokeWidth = 2);
          if (pxPerNm > 13) note(p, '${g['ft']}', 13, _limeBright);
        }
      }
    }
    // the runways in their true places; the other names only close up, each where it has room
    for (final r in all) {
      c.drawLine(_p(r['thr']), _p(r['end']), Paint()
        ..color = _w(0.7)
        ..strokeWidth = 2);
    }
    if (pxPerNm > 32) {
      for (final r in all) {
        if (active.contains(r['name'])) continue;
        final p = _p(r['label']), b = Rect.fromCenter(center: p, width: 34, height: 16);
        if (boxes.any((q) => q.overlaps(b))) continue;
        boxes.add(b);
        _text(c, r['name'] as String, p, size: 12, color: _w(0.55), align: TextAlign.center);
      }
    }
    if (pxPerNm <= 20) c.drawCircle(_p(s['field']), 7, line..color = _w(0.55));
    // entry points and fixes
    for (final e in (s['entries'] as List).cast<Map<String, dynamic>>()) {
      final p = _p(e['at']);
      if (!(Offset.zero & size).inflate(40).contains(p)) continue;
      c.save();
      c.translate(p.dx, p.dy);
      c.rotate((e['hdg'] as num) * math.pi / 180);
      c.drawPath(Path()..moveTo(-4, 4)..lineTo(0, -4)..lineTo(4, 4), line..color = _w(0.35));
      c.restore();
      if (e['beacon'] != null && pxPerNm > 4) _text(c, e['beacon'] as String, _p(e['label']), size: 10.5, color: _w(0.4), align: TextAlign.center);
    }
    for (final f in (s['fixes'] as List).cast<Map<String, dynamic>>()) {
      final p = _p(f['at']);
      if (!(Offset.zero & size).inflate(20).contains(p)) continue;
      c.drawPath(Path()..moveTo(p.dx, p.dy - 4)..lineTo(p.dx + 4, p.dy)..lineTo(p.dx, p.dy + 4)..lineTo(p.dx - 4, p.dy)..close(), line..color = _w(0.55));
      if (pxPerNm > 3.5) _text(c, f['id'] as String, p + const Offset(8, 0), size: 11, color: _w(0.6));
    }

    final fr = frame;
    if (fr == null) return;
    final ac = (fr['ac'] as List).cast<Map<String, dynamic>>();
    final byId = {for (final a in ac) a['id'] as int: a};
    // conflict pairs: a red line between them
    for (final pr in (fr['pairs'] as List)) {
      final a = byId[(pr as List)[0]], b = byId[pr[1]];
      if (a != null && b != null) _dashLine(c, _shown(a), _shown(b), Paint()..color = _red..strokeWidth = 1.2, 5, 4);
    }
    for (final a in ac) {
      final p = _shown(a), moved = p - _p(a['p']);   // (its trail moves with it)
      final sel = a['sel'] == 1, mine = a['mine'] == 1, conf = a['conf'] == 1, emg = a['emg'] == 1;
      final col = emg ? _red : conf ? _red : sel ? _orange : mine ? Colors.white : _w(0.5);
      // history dots
      final h = v._hist[a['id']] ?? const [];
      for (final (i, q) in h.indexed) {
        c.drawCircle(v._toScreen(q) + moved, 1.6, Paint()..color = col.withValues(alpha: 0.12 + 0.07 * i));
      }
      // one-minute vector
      final hdg = (a['hdg'] as num) * math.pi / 180, vm = (a['kt'] as num) * _nm / 60 * v._k;
      c.drawLine(p, p + Offset(math.sin(hdg) * vm, -math.cos(hdg) * vm), Paint()..color = col.withValues(alpha: 0.55)..strokeWidth = 1);
      if (sel) {
        _dashCircle(c, p, 3 * pxPerNm, line..color = conf ? _red : _w(0.25), 4, 4);
        final turn = a['turn'] as List?;
        if (turn != null && turn.length > 1) {
          final path = Path()..moveTo(_p(turn.first).dx, _p(turn.first).dy);
          for (final q in turn.skip(1)) {
            final s2 = _p(q);
            path.lineTo(s2.dx, s2.dy);
          }
          c.drawPath(path, line..color = _orange.withValues(alpha: 0.85));
          c.drawCircle(_p(turn.last), 2, Paint()..color = _orange);
        }
        if (a['direct'] != null) _dashLine(c, p, _p(a['direct']), line..color = _orange.withValues(alpha: 0.4), 4, 4);
        if (a['ilsFoot'] != null) _dashLine(c, p, _p(a['ilsFoot']), line..color = _lime.withValues(alpha: 0.5), 3, 5);
      }
      // the target: filled for yours, hollow for the others
      if (mine || sel) {
        c.drawCircle(p, 4.5, Paint()..color = col);
      } else {
        c.drawCircle(p, 4, Paint()
          ..color = col
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5);
      }
      _block(c, a, p, col, size);
    }
  }

  /// The data block (render.ts blockLines): callsign + handoff tag + REQ / EM, altitude -> cleared, speed · wake · mode,
  /// runway or destination. Others' traffic: callsign and altitude only.
  void _block(Canvas c, Map<String, dynamic> a, Offset p, Color col, Size size) {
    final sel = a['sel'] == 1, mine = a['mine'] == 1, emg = a['emg'] == 1;
    final dim = !mine && !sel;
    TextSpan t(String s, Color color, {bool bold = false}) => TextSpan(text: s, style: TextStyle(color: color, fontWeight: bold ? FontWeight.w700 : FontWeight.w500));
    final c1 = emg ? Colors.white : a['conf'] == 1 ? _red : dim ? _w(0.55) : Colors.white;
    final c2 = dim ? _w(0.45) : _w(0.8), c3 = dim ? _w(0.4) : _w(0.6);
    final l1 = <InlineSpan>[t(a['cs'] as String, c1, bold: true)];
    if (a['tag'] != null) l1.add(t('  → ${a['tag']}', _green, bold: true));
    if (!dim && a['req'] == 1) l1.add(t('  REQ', _orange, bold: true));
    if (emg) l1.add(t('  EM', _red, bold: true));
    final lines = <List<InlineSpan>>[l1];
    final to = a['to'] as Map?;
    final l2 = <InlineSpan>[t(a['alt'] as String, c2)];
    if (to != null && !dim) l2.add(t(' ${to['up'] == true ? '↑' : '↓'}${to['v']}', to['pend'] == true ? _orange : c2));
    if (a['expd'] == 1 && !dim) l2.add(t(' EXPD', _orange));
    lines.add(l2);
    if (!dim) {
      final st = a['spdTo'] as Map?;
      final l3 = <InlineSpan>[t(a['spd'] as String, c2)];
      if (st != null) l3.add(t('${st['up'] == true ? '↑' : '↓'}${st['v']}', st['pend'] == true ? _orange : c2));
      l3.add(t(' · ${a['wake']}', c2));
      if ((a['mode'] as String).isNotEmpty) l3.add(t(' · ${a['mode']}', a['modePend'] == 1 ? _orange : c3));
      lines.add(l3);
      if (a['l4'] != null) lines.add([t(a['l4'] as String, c3)]);
    }
    final tp = TextPainter(
      text: TextSpan(style: const TextStyle(fontFamily: AtcFonts.mono, fontSize: 11.5, height: 1.25, fontFeatures: [FontFeature.tabularFigures()]), children: [
        for (final (i, l) in lines.indexed) ...[if (i > 0) const TextSpan(text: '\n'), ...l],
      ]),
      textDirection: TextDirection.ltr,
    )..layout();
    // up and to the right of the target; flipped left near the right edge
    final left = p.dx + 14 + tp.width + 10 > size.width;
    final o = Offset(left ? p.dx - 14 - tp.width - 10 : p.dx + 14, p.dy - 14 - tp.height);
    final box = Rect.fromLTWH(o.dx, o.dy, tp.width + 10, tp.height + 6);
    c.drawLine(p, Offset(left ? box.right : box.left, box.bottom), Paint()..color = col.withValues(alpha: 0.5));
    if (!dim) {
      c.drawRRect(RRect.fromRectAndRadius(box, const Radius.circular(3)), Paint()..color = sel ? const Color(0xE6241A0F) : const Color(0xCC0E1116));
      if (sel) c.drawRRect(RRect.fromRectAndRadius(box, const Radius.circular(3)), Paint()..color = AtcColors.accent..style = PaintingStyle.stroke..strokeWidth = 1);
    }
    tp.paint(c, o + const Offset(5, 3));
  }

  @override
  bool shouldRepaint(covariant _ScopePainter old) => true;
}
