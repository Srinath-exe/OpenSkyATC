// The airports the app offers (the web's LAUNCH_AIRPORTS, src/app/_lib/airports.ts), and the little map of each one
// (assets/airports/ICAO.pick.json, the same file the web's airport list draws).

import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../ui/theme.dart';

class AirportInfo {
  const AirportInfo(this.icao, this.iata, this.city, this.name);
  final String icao, iata, city, name;
}

const kAirports = [
  AirportInfo('KSFO', 'SFO', 'San Francisco', 'San Francisco International'),
  AirportInfo('KJFK', 'JFK', 'New York', 'John F. Kennedy International'),
  AirportInfo('LFPG', 'CDG', 'Paris', 'Charles de Gaulle'),
  AirportInfo('OMDB', 'DXB', 'Dubai', 'Dubai International'),
  AirportInfo('WSSS', 'SIN', 'Singapore', 'Changi'),
  AirportInfo('RJTT', 'HND', 'Tokyo', 'Haneda'),
];

/// The airport of a code; SFO for one this build does not have (an older or newer saved shift).
AirportInfo airportOf(String icao) => kAirports.firstWhere((a) => a.icao == icao, orElse: () => kAirports.first);

class PickMap {
  PickMap.fromJson(Map<String, dynamic> j) : taxi = _l(j['taxi']), apron = _l(j['apron']), bldg = _l(j['bldg']), rw = _l(j['rw']);
  static List<List<double>> _l(Object? v) => [for (final a in (v as List? ?? const [])) [for (final n in a as List) (n as num).toDouble()]];

  /// Flat x, y lists in metres (x east, y south) round the field's middle.
  final List<List<double>> taxi, apron, bldg, rw;

  static final Map<String, Future<PickMap?>> _cache = {};
  static Future<PickMap?> load(String icao) => _cache[icao] ??= () async {
        try {
          return PickMap.fromJson(jsonDecode(await rootBundle.loadString('assets/airports/$icao.pick.json')) as Map<String, dynamic>);
        } catch (_) {
          return null;
        }
      }();
}

/// The airport seen from above: aprons, taxiways, buildings.
class AirportThumb extends StatelessWidget {
  const AirportThumb({super.key, required this.icao});
  final String icao;
  @override
  Widget build(BuildContext context) => FutureBuilder<PickMap?>(
        future: PickMap.load(icao),
        builder: (_, s) => CustomPaint(painter: _ThumbPainter(s.data), size: Size.infinite),
      );
}

class _ThumbPainter extends CustomPainter {
  _ThumbPainter(this.map);
  final PickMap? map;

  @override
  void paint(Canvas c, Size size) {
    final m = map;
    if (m == null) return;
    var x0 = double.infinity, y0 = double.infinity, x1 = -double.infinity, y1 = -double.infinity;
    for (final a in [...m.taxi, ...m.rw]) {
      for (var i = 0; i + 1 < a.length; i += 2) {
        x0 = math.min(x0, a[i]);
        x1 = math.max(x1, a[i]);
        y0 = math.min(y0, a[i + 1]);
        y1 = math.max(y1, a[i + 1]);
      }
    }
    if (!x0.isFinite) return;
    final k = math.min((size.width - 16) / (x1 - x0), (size.height - 16) / (y1 - y0));
    Offset p(double x, double y) => Offset(size.width / 2 + (x - (x0 + x1) / 2) * k, size.height / 2 + (y - (y0 + y1) / 2) * k);
    Path trace(List<double> a, bool close) {
      final out = Path();
      for (var i = 0; i + 1 < a.length; i += 2) {
        final q = p(a[i], a[i + 1]);
        i == 0 ? out.moveTo(q.dx, q.dy) : out.lineTo(q.dx, q.dy);
      }
      if (close) out.close();
      return out;
    }

    c.clipRect(Offset.zero & size);
    for (final a in m.apron) {
      c.drawPath(trace(a, true), Paint()..color = const Color(0xFF232B34));
    }
    final line = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = const Color(0xFF5F9C7B);
    for (final a in m.taxi) {
      c.drawPath(trace(a, false), line);
    }
    for (final a in m.bldg) {
      c.drawPath(trace(a, true), Paint()..color = const Color(0xFFE08A48));
    }
    for (final a in m.rw) {
      c.drawPath(trace(a, false), Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = math.max(2, 60 * k)
        ..color = const Color(0xFFEEF1F5));
    }
  }

  @override
  bool shouldRepaint(_ThumbPainter o) => o.map != map;
}

/// Pick an airport: the six in two columns, each with its map.
class AirportGrid extends StatelessWidget {
  const AirportGrid({super.key, required this.value, required this.onPick});
  final String value;
  final void Function(String icao) onPick;

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, box) {
        final w = (box.maxWidth - 10) / 2;
        return Wrap(spacing: 10, runSpacing: 10, children: [
          for (final a in kAirports)
            Semantics(
              button: true,
              selected: a.icao == value,
              label: '${a.city}, ${a.name}',
              excludeSemantics: true,
              child: GestureDetector(
                onTap: () => onPick(a.icao),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  width: w,
                  height: 112,
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    color: const Color(0xFF10151B),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: a.icao == value ? AtcColors.accent : AtcColors.line, width: a.icao == value ? 2 : 1),
                  ),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Expanded(child: RepaintBoundary(child: AirportThumb(icao: a.icao))),
                    Container(
                      color: AtcColors.raise,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                      child: Row(children: [
                        Expanded(child: Text(a.city, maxLines: 1, overflow: TextOverflow.ellipsis, style: AtcType.body.copyWith(fontSize: 13.5, fontWeight: FontWeight.w700))),
                        Text(a.iata, style: AtcType.data.copyWith(fontSize: 12.5, color: AtcColors.muted)),
                      ]),
                    ),
                  ]),
                ),
              ),
            ),
        ]);
      });
}
