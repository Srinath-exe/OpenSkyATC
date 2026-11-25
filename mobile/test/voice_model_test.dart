// A call the rules do not know, through the phone's whole path: QuickJS core -> command model -> the safety gate -> sent.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/core/atc_core.dart';
import 'package:openatc/src/s1/s1_worker.dart';

void main() {
  test('the command model answers what the rules cannot', () async {
    final core = AtcCore.create(coreJs: File('assets/core/core.js').readAsStringSync(), files: {
      '/maps/osm/KSFO.geojson': File('assets/airports/KSFO.geojson').readAsStringSync(),
      '/airspace/KSFO.txt': File('assets/airports/KSFO.txt').readAsStringSync(),
      '/maps/baked/KSFO.json': File('assets/airports/KSFO.baked.json').readAsStringSync(),
    });
    await core.boot(seed: 7, position: 'approach');
    for (var i = 0; i < 1500; i++) {
      core.tick(0.2);
    }
    final air = core.frame().aircraft.firstWhere((a) => a.altM > 1200 && a.runway != null && !a.callsign.startsWith('SKW'), orElse: () => core.frame().aircraft.firstWhere((a) => a.altM > 1200)), digits = air.callsign.replaceAll(RegExp(r'\D'), '');
    final hint = core.hints().firstWhere((h) => h.endsWith(digits), orElse: () => core.hints().first), cs = RegExp(r'^[a-z ]+').firstMatch(hint)![0]!.trim();
    final spoken = '$cs ${hint.substring(cs.length).trim().split('').join(' ')}';
    expect((await core.heard(['$spoken reduce altitude to four thousand feet'])).sent, isTrue, reason: 'rules, free wording');
    final w = await S1Worker.start(S1Files(url: '/models/s1/2m-free-v5', meta: File('assets/s1/model.json').readAsStringSync(), bin: File('assets/s1/model.bin').readAsBytesSync()));
    var gained = 0;
    for (final say in ['lower is available descend three thousand', 'lets get you down to three thousand', 'three thousand for you descend', 'start your descent now to three thousand', 'give me heading two four zero mate if able', 'keep it coming down to three thousand']) {
      final rules = await core.heard(['$spoken $say']);
      if (rules.sent) continue;
      core.l1Enable('/models/s1/2m-free-v5');
      w.prefill(core.l1Ctx());
      final m = await core.heard(['$spoken $say'], model: w.complete);
      core.l1Enable(null);
      // ignore: avoid_print
      print('$say | rules no | model ${m.sent ? 'sent' : 'held'} ${m.line} ${m.error ?? ''}');
      if (m.sent) gained++;
    }
    expect(gained, greaterThan(0), reason: 'the model sends calls the rules cannot');
    core.l1Enable('/models/s1/2m-free-v5');
    expect((await core.heard(['$spoken what are you having for lunch'], model: w.complete)).sent, isFalse);
    final none = await core.heard(['$spoken blorp the flurb'], model: (_, _, _) async => null);   // a model that fails: the rules' answer stands
    expect(none.sent, isFalse);
    w.dispose();
  }, timeout: const Timeout(Duration(minutes: 4)));
}
