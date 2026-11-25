// The phone's command model gives the same tokens, confidence and evidence as the web's (reference from src/lib/voice/s1.ts).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/s1/s1.dart';

void main() {
  test('token for token as the web engine', () {
    final m = S1Model(File('assets/s1/model.json').readAsStringSync(), File('assets/s1/model.bin').readAsBytesSync());
    final ref = (jsonDecode(File('test/fixtures/s1_ref.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();
    final pre = <int>[], run = <double>[];
    for (final r in ref) {
      final sw = Stopwatch()..start();
      m.prefill(r['ctx'] as String);
      pre.add(sw.elapsedMilliseconds);
      final c = m.complete(r['said'] as String, (r['callsigns'] as List).cast<String>());
      run.add(c.ms);
      expect(c.tokens, r['tokens'], reason: '${r['said']}: ${c.line} / ${r['line']}');
      expect(c.sayAgain, r['sayAgain']);
      expect(c.confidence, closeTo(r['confidence'] as num, 2e-3));
      final a = c.signals.toJson(), b = r['signals'] as Map<String, dynamic>;
      for (final k in b.keys) {
        if (b[k] == null) continue;
        expect(a[k] as num, closeTo(b[k] as num, 0.02 + (b[k] as num).abs() * 0.01), reason: '$k of ${r['said']}');
      }
    }
    pre.sort();
    run.sort();
    // ignore: avoid_print
    print('${ref.length} equal; prefill ${pre[pre.length ~/ 2]} ms, answer ${run[run.length ~/ 2].round()} ms (median)');
  });
}
