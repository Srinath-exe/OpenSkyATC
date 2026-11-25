// The landing film's sound: the swipe scrubs it. An approach that grows, the touchdown, reverse thrust, the taxi in, the
// pushback and the taxi out, then a wide-body taking off. [energy] (0..1) follows the finger: hold still and it settles.

import 'soundscape.dart';

double _ramp(double a, double b, double x) => ((x - a) / (b - a)).clamp(0.0, 1.0);
double _hump(double a, double b, double c, double d, double x) => _ramp(a, b, x) * (1 - _ramp(c, d, x));

Map<String, LoopWant> filmLoops(double fr, double energy) {
  final e = 0.25 + 0.75 * energy, out = <String, LoopWant>{};
  void add(String key, String sample, double g, [double speed = 1]) {
    if (g * e > 0.01) out['film:$key'] = LoopWant(sample, (g * e).clamp(0, 1), speed, 0);
  }

  final app = _hump(96, 196, 198, 206, fr);
  add('air', 'air', 0.50 * app, 0.9 + 0.2 * app);
  add('app', 'roar_h', 0.22 * app * app, 0.85);
  add('rev', 'rev_h', 0.75 * _hump(199, 203, 210, 224, fr));
  add('roll', 'roll', 0.55 * _hump(198, 200, 214, 262, fr), 1.25 - 0.5 * _ramp(198, 240, fr));
  final taxi = _hump(206, 224, 252, 262, fr) + _hump(296, 308, 348, 356, fr);
  add('idle', 'idle_h', 0.5 * taxi, 0.95);
  add('tug', 'tug', 0.45 * _hump(264, 270, 292, 302, fr));
  final to = _hump(352, 372, 388, 410, fr);
  add('to', 'roar_h', 0.95 * to, 0.85 + 0.2 * _ramp(352, 385, fr));
  add('toFar', 'rumble', 0.6 * _hump(384, 398, 404, 430, fr));
  return out;
}

/// One-shots passed going forward from [from] to [to].
List<Shot> filmShots(double from, double to) => [
      if (from < 198 && to >= 198 && to - from < 40) const Shot('touch_h', 0.8, 1, 0),
      if (from < 296 && to >= 296 && to - from < 40) const Shot('spool_up', 0.5, 0.9, 0),
    ];
