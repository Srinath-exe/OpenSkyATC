// The phone core (assets/core/core.js) in flutter_js's QuickJS, on the host: boots SFO (baked graph), runs ten sim minutes,
// sends a spoken line. Needs flutter_js's Linux library (LIBQUICKJSC_TEST_PATH=.../flutter_js-*/linux/shared/libquickjs_c_bridge_plugin.so).
//   flutter test test/core_quickjs_test.dart
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/core/atc_core.dart';

String? _lib() {
  final cache = Platform.environment['PUB_CACHE'] ?? '${Platform.environment['HOME']}/.pub-cache';
  final d = Directory('$cache/hosted/pub.dev');
  if (!d.existsSync()) return null;
  for (final e in d.listSync()) {
    final f = File('${e.path}/linux/shared/libquickjs_c_bridge_plugin.so');
    if (e.path.contains('flutter_js-') && f.existsSync()) return f.path;
  }
  return null;
}

void main() {
  final lib = Platform.environment['LIBQUICKJSC_TEST_PATH'] ?? _lib();
  test('core boots KSFO, runs, understands a spoken call', () async {
    final core = AtcCore.create(
      coreJs: File('assets/core/core.js').readAsStringSync(),
      files: {
        '/maps/osm/KSFO.geojson': File('assets/airports/KSFO.geojson').readAsStringSync(),
        '/airspace/KSFO.txt': File('assets/airports/KSFO.txt').readAsStringSync(),
        '/maps/baked/KSFO.json': File('assets/airports/KSFO.baked.json').readAsStringSync(),
      },
    );
    final boot = Stopwatch()..start();
    await core.boot(seed: 7);
    // ignore: avoid_print
    print('boot ${boot.elapsedMilliseconds} ms');
    final ap = core.airport();
    expect((ap['stands'] as Map)['features'], isNotEmpty);
    final sw = Stopwatch()..start();
    var frames = 0;
    for (var i = 0; i < 6000; i++) {
      core.tick(0.1);
      if (i % 3 == 0) {
        core.frame();
        frames++;
      }
      if (i % 10 == 0) core.ui();
    }
    // ignore: avoid_print
    print('600 sim s in ${sw.elapsedMilliseconds} ms (${(sw.elapsedMicroseconds / 6000 / 1000).toStringAsFixed(2)} ms per tick, $frames frames)');
    final f = core.frame();
    expect(f.aircraft, isNotEmpty);
    final ui = core.ui();
    expect(ui.score, isNotNull);
    final p = core.practice();
    expect(p, isNotEmpty);
    final say = (p.firstWhere((x) => x['say'] != null)['say'] as String).toLowerCase().replaceAll(RegExp(r'[,.]'), '');
    final r = await core.heard([say]);
    // ignore: avoid_print
    print('heard "$say" -> ${r.line} ok=${r.ok} ${r.error ?? ''}');
    expect(r.sent, isTrue);
    expect(core.hints(), isNotEmpty);
    core.dispose();
  }, skip: lib == null ? 'flutter_js Linux library not found' : null, timeout: const Timeout(Duration(minutes: 3)));

  test('the tutorial runs: tour steps with map cues, then pushback and taxi missions with the calls on the card', () async {
    final core = AtcCore.create(
      coreJs: File('assets/core/core.js').readAsStringSync(),
      files: {
        '/maps/osm/KSFO.geojson': File('assets/airports/KSFO.geojson').readAsStringSync(),
        '/airspace/KSFO.txt': File('assets/airports/KSFO.txt').readAsStringSync(),
        '/maps/baked/KSFO.json': File('assets/airports/KSFO.baked.json').readAsStringSync(),
      },
    );
    await core.boot(position: 'ground', spawn: 'none', ends: ['28L', '28R', '01L', '01R']);
    core.courseStart(fromStart: true);
    var cues = 0;
    final seen = <String>[];
    String sent = '';
    for (var k = 0; k < 20 * 240 && !seen.contains('m-stop'); k++) {
      core.tick(0.05);
      if (k % 5 != 0) continue;
      final st = core.courseState();
      cues += (st['cues'] as List).length;
      final step = st['step'] as Map;
      if (seen.isEmpty || seen.last != step['id']) seen.add(step['id'] as String);
      if (step['mission'] == null) {
        if (k % 40 == 0) core.courseNext();
        continue;
      }
      final ph = (((st['mission'] as Map?)?['cur']) as Map?)?['phrase'] as String?;
      if (ph != null && ph != sent) {
        expect(core.courseSend(ph).ok, isTrue, reason: ph);
        sent = ph;
      }
    }
    // ignore: avoid_print
    print('course steps: ${seen.join(' > ')} ($cues cues)');
    expect(seen, containsAllInOrder(['welcome', 'runways', 'controls', 'm-push', 'm-taxi', 'm-stop']));
    expect(cues, greaterThan(20));
    core.dispose();
  }, skip: lib == null ? 'flutter_js Linux library not found' : null, timeout: const Timeout(Duration(minutes: 5)));
}
