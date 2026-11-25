// What the airfield sounds like from where the camera is: pure bookkeeping (no audio engine), so it can be tested.
//
// Each aircraft has engines (idle whine, jet roar, a far-away rumble), its airframe in the air, its wheels on the ground,
// reverse thrust on the roll-out, the tug at pushback; its size picks the recordings, how loud they are and how far they
// carry. Ten times a second update() turns the traffic and the listener into the loops that should be playing (sample,
// gain, speed, pan) and the one-shots to fire (touchdown, engines winding up and down).

import 'dart:math' as math;

import '../core/models.dart';

/// Where the ear is: what the camera looks at, from how far, how tilted, which way up the screen points.
class Ear {
  const Ear({required this.lng, required this.lat, required this.bearing, required this.pitch, required this.distanceM});
  final double lng, lat, bearing, pitch;

  /// Camera to the point it looks at, metres.
  final double distanceM;

  /// Mapbox: the camera sits 1.5 screen heights (in pixels at that zoom) from the point it looks at.
  factory Ear.fromCamera({required double lng, required double lat, required double zoom, required double bearing, required double pitch, required double heightPx}) {
    final mpp = 40075016.7 * math.cos(lat * math.pi / 180) / (512 * math.pow(2, zoom));
    return Ear(lng: lng, lat: lat, bearing: bearing, pitch: pitch, distanceM: 1.5 * heightPx * mpp);
  }
}

class LoopWant {
  LoopWant(this.sample, this.gain, this.speed, this.pan);
  final String sample;
  final double gain, speed, pan;
}

class Shot {
  const Shot(this.sample, this.gain, this.speed, this.pan);
  final String sample;
  final double gain, speed, pan;
}

/// The size class's sounds, how loud they are, how far they carry, and the length its recordings are pitched for.
enum EngineClass {
  prop('prop', 0.60, 0.65, 27),
  small('s', 0.62, 0.72, 31),
  medium('m', 0.80, 1.0, 39),
  heavy('h', 1.0, 1.35, 64);

  const EngineClass(this.key, this.loud, this.carry, this.refLen);
  final String key;
  final double loud, carry, refLen;

  static EngineClass of(String type, double lengthM) {
    final t = type.toUpperCase();
    if (t.startsWith('AT4') || t.startsWith('AT7') || t.startsWith('DH8') || t.startsWith('C208') || t.startsWith('PC12') || t.startsWith('BE')) return prop;
    return lengthM < 36.6 ? small : lengthM < 50 ? medium : heavy;
  }
}

class _Ac {
  double thrust = 0;
  bool? ground;
  String phase = '';
  double kt = 0;
}

class Soundscape {
  final Map<int, _Ac> _ac = {};
  double _t = -1;

  /// Nothing is further down than this; the most loops at once.
  static const _floor = 0.006, _maxLoops = 20;

  void reset() {
    _ac.clear();
    _t = -1;
  }

  /// What an engine is asked for, 0..1.
  static double thrustFor(SimAircraft a, double prevKt) => switch (a.phase) {
        'parked' || 'arrived' => 0,
        'startup' => 0.13,
        'pushback' => 0.14,
        'taxi' => a.knots > 1 && a.knots < 9 && a.knots > prevKt ? 0.34 : 0.18,   // breaking away takes a push
        'hold_short' || 'lineup' => 0.15,
        'takeoff' || 'go_around' => 1,
        'climb' => a.altM < 900 ? 0.9 : 0.75,
        'descent' || 'cruise' => 0.30,
        'approach' => 0.42,
        'landing' => a.onGround ? 0.16 : 0.34,
        'rollout' => 0.16,
        _ => a.onGround ? 0.15 : 0.35,
      };

  ({Map<String, LoopWant> loops, List<Shot> shots}) update(SimFrame f, Ear l, double dt, {bool paused = false}) {
    final shots = <Shot>[];
    if (f.time < _t - 1) reset();   // a new shift
    _t = f.time;
    final all = <(double, String, LoopWant)>[];
    final seen = <int>{};
    // the ear sits a quarter of the way back along the view: close enough to hear what the picture shows
    final d0 = l.distanceM * 0.25, pr = l.pitch * math.pi / 180, br = l.bearing * math.pi / 180;
    final up = d0 * math.cos(pr), back = d0 * math.sin(pr);
    final ex = -math.sin(br) * back, ey = -math.cos(br) * back;
    final mLat = 111320.0, mLng = 111320.0 * math.cos(l.lat * math.pi / 180);

    for (final a in f.aircraft) {
      seen.add(a.id);
      final fresh = !_ac.containsKey(a.id);
      final s = _ac[a.id] ??= _Ac();
      final c = EngineClass.of(a.type, a.lengthM);
      final huge = c == EngineClass.heavy && (a.type.startsWith('A38') || a.type.startsWith('B74'));
      final loud = c.loud * (huge ? 1.12 : 1) * (a.selected ? 1.2 : 1), carry = c.carry * (huge ? 1.2 : 1);
      // engines spool: up in about three seconds, down a little slower
      final want = thrustFor(a, s.kt);
      if (fresh) s.thrust = want;
      s.thrust += (want - s.thrust) * (1 - math.exp(-dt / (want > s.thrust ? 1.3 : 2.0)));

      final dx = (a.lng - l.lng) * mLng - ex, dy = (a.lat - l.lat) * mLat - ey, dz = a.altM - up;
      final d = math.max(8.0, math.sqrt(dx * dx + dy * dy + dz * dz));
      final az = math.atan2(dx, dy) - br, side = math.sin(az) * math.sqrt(dx * dx + dy * dy) / d;
      final pan = (side * 0.8).clamp(-0.8, 0.8);
      double near(double ref) => 1 / (1 + math.pow(d / (ref * carry), 1.5));
      // Doppler: the aircraft's own speed toward the ear
      final hr = a.heading * math.pi / 180, v = a.knots * 0.514;
      final closing = -(math.sin(hr) * v * dx + math.cos(hr) * v * dy) / d;
      final dop = (340 / (340 - closing.clamp(-60.0, 60.0))).clamp(0.85, 1.18);
      final size = math.pow(c.refLen / math.max(12, a.lengthM), 0.35).toDouble().clamp(0.8, 1.2) * (huge ? 0.92 : 1);
      // a quarter-tone apart, so two of a kind do not phase
      final own = 1 + ((a.id * 37) % 11 - 5) * 0.004;

      if (!fresh && !paused) {
        if (s.ground == false && a.onGround && a.knots > 50) shots.add(Shot('touch_${c == EngineClass.prop ? 's' : c.key}', (near(420) * loud * 1.25).clamp(0, 1), size * own, pan));
        if (s.phase == 'parked' && a.phase == 'startup' && c != EngineClass.prop) shots.add(Shot('spool_up', near(150) * loud * 0.8, size * own, pan));
        if (s.phase != a.phase && (a.phase == 'arrived' || a.phase == 'parked') && c != EngineClass.prop) shots.add(Shot('spool_down', near(150) * loud * 0.8, size * own, pan));
      }

      void add(String layer, String sample, double gain, double speed) {
        final g = paused ? 0.0 : gain * loud;
        if (g > _floor) all.add((g, '${a.id}:$layer', LoopWant(sample, g.clamp(0, 1), (speed * own * dop).clamp(0.5, 1.8), pan)));
      }

      final th = s.thrust;
      if (th > 0.02) {
        if (c == EngineClass.prop) {
          final p = th.clamp(0.0, 1.0);
          add('idle', 'prop_idle', near(150) * 0.75 * (1 - p * 0.7), size * (0.95 + 0.15 * p));
          add('roar', 'prop_power', near(620) * 0.95 * math.pow(p, 1.1), size * (0.9 + 0.15 * p));
        } else {
          add('idle', 'idle_${c.key}', near(150) * 0.72 * math.min(1, th / 0.15) * (1 - th * 0.45), size * (0.88 + 0.55 * th));
          add('roar', 'roar_${c.key}', near(760) * 1.05 * math.pow(th, 1.5), size * (0.82 + 0.26 * th));
        }
        // only the low end arrives from far away
        final far = d / (d + 1400);
        add('rumble', 'rumble', near(1500) * 0.6 * far * math.pow(th, 1.2), size * (0.9 + 0.1 * th));
      }
      if (!a.onGround) {
        add('air', 'air', near(380) * 0.42 * math.pow((a.knots / 160).clamp(0, 1.3), 2), 0.9 + 0.2 * (a.knots / 200).clamp(0, 1.2));
      } else if (a.knots > 3 && a.phase != 'pushback') {
        add('roll', 'roll', near(130) * 0.5 * math.min(1, a.knots / 40), 0.75 + a.knots / 160);
      }
      // reverse thrust from touchdown to about 60 kt
      if (a.onGround && (a.phase == 'rollout' || a.phase == 'landing') && a.knots > 55) {
        add('rev', c == EngineClass.prop ? 'prop_power' : 'rev_${c.key}', near(700) * 0.95 * ((a.knots - 55) / 55).clamp(0, 1), size);
      }
      if (a.phase == 'pushback') add('tug', 'tug', near(110) * 0.55 / loud, 1);
      if (a.phase == 'parked' || a.phase == 'startup') add('apu', 'apu', near(75) * 0.35, size);

      s
        ..ground = a.onGround
        ..phase = a.phase
        ..kt = a.knots.toDouble();
    }
    _ac.removeWhere((id, _) => !seen.contains(id));
    all.sort((a, b) => b.$1.compareTo(a.$1));
    return (loops: {for (final w in all.take(_maxLoops)) w.$2: w.$3}, shots: shots);
  }
}
