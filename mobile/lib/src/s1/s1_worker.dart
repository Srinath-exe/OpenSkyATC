// The command model in its own isolate: the sim keeps its frame rate while the model reads the state (about half a second
// on a busy field, done while the player talks) and answers (a tenth of a second).

import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

import 's1.dart';

/// A command model ready to run: its name (the gate fitted for it goes by this), its files, and the gate itself when the
/// model came through the update channel (the bundled one's is in core.js).
class S1Files {
  const S1Files({required this.url, required this.meta, required this.bin, this.gate});
  final String url, meta;
  final Uint8List bin;
  final String? gate;
}

class S1Worker {
  S1Worker._(this._iso, this._send, this._rx);
  final Isolate _iso;
  final SendPort _send;
  final ReceivePort _rx;
  final Map<int, Completer<Map<String, Object?>?>> _wait = {};
  int _seq = 0;

  static Future<S1Worker> start(S1Files f) async {
    final rx = ReceivePort(), ready = Completer<SendPort>();
    late final S1Worker w;
    rx.listen((m) {
      if (m is SendPort) return ready.complete(m);
      if (m is String) return ready.isCompleted ? null : ready.completeError(StateError(m));
      final l = m as List;
      w._wait.remove(l[0])?.complete((l[1] as Map?)?.cast<String, Object?>());
    });
    final iso = await Isolate.spawn(_main, (rx.sendPort, f.meta, TransferableTypedData.fromList([f.bin])));
    try {
      w = S1Worker._(iso, await ready.future.timeout(const Duration(seconds: 20)), rx);
    } catch (_) {
      iso.kill(priority: Isolate.immediate);
      rx.close();
      rethrow;
    }
    return w;
  }

  SendPort get control => _iso.controlPort;
  Capability get terminate => _iso.terminateCapability!;

  void prefill(String ctx) => _send.send(['p', ctx]);

  Future<Map<String, Object?>?> complete(String said, List<String> callsigns, String ctx) {
    final id = ++_seq, c = _wait[id] = Completer();
    _send.send(['c', id, said, callsigns, ctx]);
    return c.future.timeout(const Duration(seconds: 6), onTimeout: () {
      _wait.remove(id);
      return null;
    });
  }

  void dispose() {
    _iso.kill(priority: Isolate.immediate);
    _rx.close();
    for (final c in _wait.values) {
      c.complete(null);
    }
    _wait.clear();
  }

  static void _main((SendPort, String, TransferableTypedData) a) {
    final rx = ReceivePort();
    try {
      final m = S1Model(a.$2, a.$3.materialize().asUint8List());
      a.$1.send(rx.sendPort);
      rx.listen((q) {
        final l = q as List;
        try {
          if (l[0] == 'p') return m.prefill(l[1] as String);
          m.prefill(l[4] as String);
          a.$1.send([l[1], m.complete(l[2] as String, (l[3] as List).cast<String>()).toJson()]);
        } catch (_) {
          if (l[0] == 'c') a.$1.send([l[1], null]);
        }
      });
    } catch (e) {
      a.$1.send('$e');
    }
  }
}
