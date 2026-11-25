// The game's sound without an audio engine: the mixer (what should be heard from where) and the player (what it asks for).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/audio/film_sound.dart';
import 'package:openatc/src/audio/sfx.dart';
import 'package:openatc/src/audio/soundscape.dart';
import 'package:openatc/src/core/models.dart';
import 'package:shared_preferences/shared_preferences.dart';

const lat = 37.62, lng = -122.38;
Map<String, dynamic> ac({int id = 1, String type = 'A320', double len = 37.6, String ph = 'taxi', num kt = 15, num alt = 0, double dLat = 0, double dLng = 0, num hdg = 0}) =>
    {'id': id, 'cs': 'UAL$id', 'lng': lng + dLng, 'lat': lat + dLat, 'alt': alt, 'hdg': hdg, 'pitch': 0, 'bank': 0, 'type': type, 'al': 'UAL', 'len': len, 'gnd': alt < 2 ? 1 : 0, 'ph': ph, 'kt': kt, 'fl': 0, 'mine': 1, 'req': 0, 'emg': 0, 'sel': 0};
SimFrame fr(List<Map<String, dynamic>> a, [double t = 1]) => SimFrame.fromJson({'t': t, 'wall': 0, 'sel': null, 'ac': a, 'routes': []});
const near = Ear(lng: lng, lat: lat, bearing: 0, pitch: 0, distanceM: 600), far = Ear(lng: lng, lat: lat, bearing: 0, pitch: 0, distanceM: 12000);

class FakeOut implements AudioOut {
  final List<String> shots = [];
  final Map<int, (String, double)> loops = {};
  int _n = 0;
  @override
  Future<void> open(List<String> names) async {}
  @override
  Object? loop(String name, double gain, double speed, double pan) {
    loops[++_n] = (name, gain);
    return _n;
  }

  @override
  void tune(Object h, double gain, double speed, double pan, int ms) => loops[h as int] = (loops[h]!.$1, gain);
  @override
  void stop(Object h, int ms) => loops.remove(h);
  @override
  void shot(String name, double gain, double speed, double pan) => shots.add(name);
  @override
  void master(double gain) {}
  double gainOf(String name) => loops.values.where((l) => l.$1 == name).fold(0.0, (a, l) => a + l.$2);
}

void main() {
  double total(Map<String, dynamic> a, Ear e) => Soundscape().update(fr([a]), e, 0.1).loops.values.fold(0.0, (s, w) => s + w.gain);

  test('bigger aircraft are louder, carry further and play their own recordings', () {
    final s = ac(type: 'CRJ7', len: 32.5, ph: 'takeoff', kt: 120), m = ac(type: 'A320', ph: 'takeoff', kt: 120), h = ac(type: 'B77W', len: 73.9, ph: 'takeoff', kt: 120), j = ac(type: 'A388', len: 72.7, ph: 'takeoff', kt: 120);
    for (final e in [near, far]) {
      expect(total(m, e), greaterThan(total(s, e)));
      expect(total(h, e), greaterThan(total(m, e)));
      expect(total(j, e), greaterThanOrEqualTo(total(h, e)));
    }
    String roar(Map<String, dynamic> a) => Soundscape().update(fr([a]), near, 0.1).loops['1:roar']!.sample;
    expect([roar(s), roar(m), roar(h), roar(ac(type: 'AT76', len: 27.2, ph: 'takeoff', kt: 90))], ['roar_s', 'roar_m', 'roar_h', 'prop_power']);
    expect(total(h, far), lessThan(total(h, near) * 0.5));
  });

  test('take-off over taxi; parked engines off; engines spool rather than jump', () {
    expect(total(ac(ph: 'takeoff', kt: 60), near), greaterThan(total(ac(ph: 'taxi'), near) * 1.5));
    expect(Soundscape().update(fr([ac(ph: 'parked', kt: 0)]), near, 0.1).loops.keys.where((k) => k.contains('idle') || k.contains('roar')), isEmpty);
    final w = Soundscape();
    w.update(fr([ac(ph: 'lineup', kt: 0)]), near, 0.1);
    final g0 = w.update(fr([ac(ph: 'takeoff', kt: 1)], 1.1), near, 0.1).loops['1:roar']!.gain;
    late double g1;
    for (var i = 0; i < 40; i++) {
      g1 = w.update(fr([ac(ph: 'takeoff', kt: 20)], 1.2 + i * 0.1), near, 0.1).loops['1:roar']!.gain;
    }
    expect(g1, greaterThan(g0 * 3));
  });

  test('one touchdown per landing, by size, then reverse thrust that ends', () {
    final w = Soundscape();
    w.update(fr([ac(ph: 'landing', alt: 12, kt: 138, type: 'B77W', len: 73.9)]), near, 0.1);
    final t = w.update(fr([ac(ph: 'rollout', alt: 0, kt: 135, type: 'B77W', len: 73.9)], 2), near, 0.1);
    expect(t.shots.map((s) => s.sample), ['touch_h']);
    expect(t.loops['1:rev']!.sample, 'rev_h');
    final u = w.update(fr([ac(ph: 'rollout', alt: 0, kt: 40, type: 'B77W', len: 73.9)], 3), near, 0.1);
    expect(u.shots, isEmpty);
    expect(u.loops.containsKey('1:rev'), isFalse);
  });

  test('left is left, whichever way the map is turned; a crowd stays within the voice limit; paused is silent', () {
    final w = ac(dLng: -0.004, ph: 'takeoff', kt: 100);
    expect(Soundscape().update(fr([w]), near, 0.1).loops['1:roar']!.pan, lessThan(-0.3));
    expect(Soundscape().update(fr([w]), const Ear(lng: lng, lat: lat, bearing: 180, pitch: 0, distanceM: 600), 0.1).loops['1:roar']!.pan, greaterThan(0.3));
    final many = [for (var i = 1; i < 40; i++) ac(id: i, ph: 'taxi', dLat: i * 0.0002)];
    expect(Soundscape().update(fr(many), near, 0.1).loops.length, lessThanOrEqualTo(20));
    expect(Soundscape().update(fr(many), near, 0.1, paused: true).loops, isEmpty);
  });

  test('every sound the app can ask for is bundled', () {
    for (final n in Sfx.names) {
      expect(File('assets/sound/$n.wav').existsSync(), isTrue, reason: n);
    }
    for (var f = 0.0; f < 480; f += 2) {
      for (final l in filmLoops(f, 1).values) {
        expect(Sfx.names, contains(l.sample));
      }
    }
    expect(filmShots(190, 200).single.sample, 'touch_h');
    expect(filmShots(200, 190), isEmpty);
  });

  testWidgets('buttons click (once), dead areas do not; talking silences everything; voices push the airfield back', (t) async {
    SharedPreferences.setMockInitialValues({});
    final o = FakeOut();
    await Sfx.I.init(out: o);
    await t.pumpWidget(MaterialApp(
      builder: (c, child) => TapSounds(child: child!),
      home: Scaffold(
        body: Column(children: [
          FilledButton(onPressed: () {}, child: const Text('plain')),
          FilledButton(onPressed: () => Sfx.I.ui('start'), child: const Text('own')),
          const FilledButton(onPressed: null, child: Text('dead')),
          GestureDetector(onTap: () {}, child: const Text('gesture')),
          const Text('words'),
        ]),
      ),
    ));
    Future<List<String>> press(String s) async {
      o.shots.clear();
      await t.tap(find.text(s), warnIfMissed: false);
      await t.pump(const Duration(milliseconds: 60));
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 90)));
      return [...o.shots];
    }

    expect(await press('plain'), ['tap']);
    expect(await press('own'), ['start']);
    expect(await press('dead'), isEmpty);
    expect(await press('gesture'), ['tap']);
    expect(await press('words'), isEmpty);

    final s = Soundscape().update(fr([ac(ph: 'takeoff', kt: 100)]), near, 0.1);
    Sfx.I.bed(Bed.field);
    Sfx.I.world(s.loops, s.shots);
    final loud = o.gainOf('roar_m');
    expect(loud, greaterThan(0.2));
    expect(o.gainOf('amb_field'), greaterThan(0));
    Sfx.I.speaking(true);
    expect(o.gainOf('roar_m'), closeTo(loud * 0.38, 0.01));
    Sfx.I.speaking(false);
    o.shots.clear();
    Sfx.I.transmitting(true);
    Sfx.I.ui('alert_critical');
    Sfx.I.world(s.loops, const [Shot('touch_h', 1, 1, 0)]);
    expect(o.loops, isEmpty);
    expect(o.shots.where((x) => x != 'ptt_on'), isEmpty);
    Sfx.I.transmitting(false);
    expect(o.gainOf('roar_m'), closeTo(loud, 0.01));
    Sfx.I.setVolumes(airfield: 0);
    expect(o.loops, isEmpty);
    Sfx.I.setVolumes(airfield: 0.8);
  });
}
