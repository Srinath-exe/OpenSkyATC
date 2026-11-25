// The fleet lookup (assets/fleet/map.json) and the map's light preset.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/game/fleet.dart';
import 'package:openatc/src/game/sun.dart';

void main() {
  final fleet = Fleet.fromJson(jsonDecode(File('assets/fleet/map.json').readAsStringSync()) as Map<String, dynamic>);

  test('an airline on its type gets its livery, a bundled file, scaled to the real length', () {
    final f = fleet.fileFor('B738', 'UAL', 39.5);
    expect(f, contains('__'));
    expect(File('assets/fleet/$f').existsSync(), isTrue);
    expect(fleet.scaleFor(f, 39.5), closeTo(1, 0.1));
  });

  test('unknown airline -> plain type; unknown type -> a stand-in of about the size', () {
    expect(fleet.fileFor('A320', 'ZZZ', 37.6), isNot(contains('__')));
    for (final len in [25.0, 40.0, 58.0, 74.0]) {
      expect(File('assets/fleet/${fleet.fileFor('XXXX', 'ZZZ', len)}').existsSync(), isTrue);
    }
  });

  test('every file map.json names is bundled', () {
    final j = jsonDecode(File('assets/fleet/map.json').readAsStringSync()) as Map<String, dynamic>;
    for (final f in (j['files'] as Map).keys) {
      expect(File('assets/fleet/$f').existsSync(), isTrue, reason: f as String);
    }
  });

  test('light preset at SFO follows the sun', () {
    // 2026-06-21: noon PDT = 19:00 UTC (day), 05:00 UTC = 22:00 PDT (night), 03:40 UTC ~ sunset (dusk)
    expect(lightPresetFor(DateTime.utc(2026, 6, 21, 19), 37.62, -122.38), 'day');
    expect(lightPresetFor(DateTime.utc(2026, 6, 22, 5), 37.62, -122.38), 'night');
    expect(lightPresetFor(DateTime.utc(2026, 6, 22, 3, 40), 37.62, -122.38), 'dusk');
    expect(lightPresetFor(DateTime.utc(2026, 6, 21, 12, 50), 37.62, -122.38), 'dawn');
  });
}
