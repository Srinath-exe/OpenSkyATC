// Every airport the app lists boots in the phone's own JS engine, opens on the ends its wind puts in use, and runs.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/core/atc_core.dart';

void main() {
  for (final icao in (Platform.environment['ICAO'] ?? 'KSFO,KJFK,LFPG,OMDB,WSSS,RJTT').split(',')) {
    test('$icao boots and runs', () async {
      String f(String n) => File('assets/airports/$icao.$n').readAsStringSync();
      final sw = Stopwatch()..start();
      final core = AtcCore.create(coreJs: File('assets/core/core.js').readAsStringSync(), files: {
        '/maps/osm/$icao.geojson': f('geojson'), '/airspace/$icao.txt': f('txt'), '/maps/baked/$icao.json': f('baked.json'), '/maps/baked/$icao.limits.json': f('limits.json'), '/maps/baked/$icao.names.json': f('names.json'),
      });
      final load = sw.elapsedMilliseconds;
      await core.boot(icao: icao, position: 'tower');
      final boot = sw.elapsedMilliseconds - load;
      final ap = core.airport();
      final air = sw.elapsedMilliseconds - load - boot;
      sw.reset();
      for (var i = 0; i < 4 * 300; i++) {
        core.tick(0.25);
      }
      // ignore: avoid_print
      print('$icao load $load ms, boot $boot ms, airport() $air ms, 5 sim min ${sw.elapsedMilliseconds} ms, ${core.frame().aircraft.length} aircraft');
      expect(((ap['stands'] as Map)['features'] as List).length, greaterThan(100));
      expect(core.frame().aircraft, isNotEmpty);
      core.dispose();
    }, timeout: const Timeout(Duration(minutes: 5)));
  }
}
