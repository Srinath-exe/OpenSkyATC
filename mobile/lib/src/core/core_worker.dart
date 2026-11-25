// The core on its own thread: the game (AtcCore, QuickJS) runs in a background isolate with its own clock, so the UI
// thread only draws. The phone's 120 Hz screen has ~8 ms a frame; a sim step, the map frame and the panels cost a few
// ms each, which on the UI thread showed as stutter.
//
//   worker -> app   frames (30 Hz), panels (8 Hz), course state, radar frames (15 Hz while the scope shows)
//   app -> worker   calls by name (select, command, heard, course..., debugAdvance), answered with their result;
//                   a call that changes the game is followed at once by fresh panels.

import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

import '../s1/s1_worker.dart';
import 'atc_core.dart';
import 'models.dart';

sealed class CoreEvent {}

class FrameEvent extends CoreEvent {
  FrameEvent(this.frame);
  final SimFrame frame;
}

class UiEvent extends CoreEvent {
  UiEvent(this.ui);
  final UiState ui;
}

class CourseEvent extends CoreEvent {
  CourseEvent(this.state);
  final Map<String, dynamic> state;
}

class RadarEvent extends CoreEvent {
  RadarEvent(this.frame);
  final Map<String, dynamic> frame;
}

class StorageEvent extends CoreEvent {
  StorageEvent(this.json);
  final String json;
}

/// What the app needs before the first frame.
class CoreBoot {
  const CoreBoot({required this.airport, required this.radarScene, required this.settings});
  final Map<String, dynamic> airport;
  final Map<String, dynamic>? radarScene;
  final Map<String, dynamic> settings;
}

class CoreWorker {
  CoreWorker._(this._isolate, this._send, this._rx, this.boot);

  Isolate? _s1;
  final Isolate _isolate;
  final SendPort _send;
  final ReceivePort _rx;
  final CoreBoot boot;
  final _events = StreamController<CoreEvent>.broadcast();
  final Map<int, Completer<Object?>> _pending = {};
  int _seq = 0;

  Stream<CoreEvent> get events => _events.stream;

  /// Start the isolate, load the core and boot the session (course: the tutorial scene).
  static Future<CoreWorker> start({
    required String coreJs,
    required Map<String, String> files,
    String? storage,
    required Map<String, Object?> bootArgs,
    S1Files? s1,
    bool course = false,
  }) async {
    final rx = ReceivePort();
    final iso = await Isolate.spawn(_main, rx.sendPort, debugName: 'atc-core');
    final first = Completer<SendPort>();
    final booted = Completer<Object?>();
    late CoreWorker w;
    rx.listen((m) {
      if (m is SendPort) {
        first.complete(m);
      } else if (m is List && m.first == 'booted') {
        booted.complete(m[1]);
      } else if (m is List && m.first == 'error' && !booted.isCompleted) {
        booted.completeError(m[1] as String);
      } else if (booted.isCompleted) {
        w._onMessage(m);
      }
    });
    final send = await first.future;
    send.send(['init', coreJs, files, storage, bootArgs, course, if (s1 != null) ...[s1.url, s1.meta, s1.bin, s1.gate]]);
    final b = await booted.future as Map;
    w = CoreWorker._(iso, send, rx, CoreBoot(airport: (b['airport'] as Map).cast<String, dynamic>(), radarScene: (b['radar'] as Map?)?.cast<String, dynamic>(), settings: (b['settings'] as Map).cast<String, dynamic>()));
    return w;
  }

  bool _closed = false;

  void _onMessage(Object? m) {
    if (m is! List || _closed) return;   // the isolate may still be sending after dispose
    switch (m.first) {
      case 'frame':
        _events.add(FrameEvent(m[1] as SimFrame));
      case 'ui':
        _events.add(UiEvent(m[1] as UiState));
      case 'course':
        _events.add(CourseEvent((m[1] as Map).cast<String, dynamic>()));
      case 'radar':
        _events.add(RadarEvent((m[1] as Map).cast<String, dynamic>()));
      case 'storage':
        _events.add(StorageEvent(m[1] as String));
      case 's1':
        _s1 = Isolate(m[1] as SendPort, terminateCapability: m[2] as Capability);
      case 'ret':
        _pending.remove(m[1] as int)?.complete(m[2]);
      case 'err':
        _pending.remove(m[1] as int)?.completeError(m[2] as String);
    }
  }

  /// Call the core by name (see _call in the isolate).
  Future<T?> call<T>(String method, [List<Object?> args = const []]) {
    final id = ++_seq;
    final c = Completer<Object?>();
    _pending[id] = c;
    _send.send(['call', id, method, args]);
    return c.future.then((v) => v as T?);
  }

  void setRadar(bool on) => _send.send(['radar', on]);
  void setRunning(bool on) => _send.send(['run', on]);

  /// Stop the isolate (the game's storage was saved on its last periodic save or when the app went to the background).
  void dispose() {
    if (_closed) return;
    _closed = true;
    for (final c in _pending.values) {
      c.completeError('core stopped');
    }
    _pending.clear();
    _isolate.kill(priority: Isolate.immediate);
    _s1?.kill(priority: Isolate.immediate);
    _rx.close();
    unawaited(_events.close());
  }
}

// ── the isolate ──────────────────────────────────────────────────────────────

Future<void> _main(SendPort out) async {
  final rx = ReceivePort();
  out.send(rx.sendPort);
  AtcCore? core;
  var course = false, radar = false, running = true;
  S1Worker? s1;
  Timer? loop;
  final clock = Stopwatch();
  var n = 0;

  void panels() {
    final c = core;
    if (c == null) return;
    out.send(['ui', c.ui()]);
    if (course) out.send(['course', c.courseState()]);
    if (radar) out.send(['radar', c.radarFrame()]);
  }

  void step() {
    final c = core;
    if (c == null || !running) return;
    final dt = clock.elapsedMicroseconds / 1e6;
    clock
      ..reset()
      ..start();
    try {
      c.tick(dt.clamp(0, 0.25));
      out.send(['frame', c.frame()]);
      n++;
      if (radar && n % 2 == 0) out.send(['radar', c.radarFrame()]);
      if (n % 4 == 0) {
        out.send(['ui', c.ui()]);
        if (course) out.send(['course', c.courseState()]);
      }
      if (n % 900 == 0) out.send(['storage', c.storage()]);
    } catch (e) {
      out.send(['log', 'core: $e']);
    }
  }

  void startLoop() {
    loop?.cancel();
    clock
      ..reset()
      ..start();
    loop = Timer.periodic(const Duration(microseconds: 33333), (_) => step());
  }

  Object? callCore(AtcCore c, String method, List<Object?> a) {
    switch (method) {
      case 'select':
        c.select(a[0] as int?);
      case 'command':
        return c.command(a[0] as String);
      case 'l1Prefill':
        s1?.prefill(c.l1Ctx());
      case 'hints':
        return c.hints();
      case 'setPosition':
        c.setPosition(a[0] as String);
      case 'setPaused':
        c.setPaused(a[0] as bool);
      case 'setRate':
        c.setRate(a[0] as int);
      case 'setSectorAi':
        c.setSectorAi(a[0] as bool);
      case 'settings':
        return c.settings((a.isEmpty ? null : a[0] as Map?)?.cast<String, Object?>());
      case 'radio':
        return c.radio();
      case 'airport':
        return c.airport();
      case 'runways':
        return c.runways();
      case 'toggleRunway':
        return c.toggleRunway(a[0] as String, a[1] as String);
      case 'runwaysIntoWind':
        return c.runwaysIntoWind();
      case 'storage':
        return c.storage();
      case 'courseNext':
        c.courseNext();
      case 'courseBack':
        c.courseBack();
      case 'courseGoSection':
        c.courseGoSection(a[0] as String);
      case 'courseRestart':
        c.courseRestart();
      case 'courseFreePlay':
        c.courseFreePlay();
      case 'courseDismissNote':
        c.courseDismissNote(a[0] as int);
      case 'courseSend':
        return c.courseSend(a[0] as String);
      case 'debugAdvance':
        final s = (a[0] as num).toDouble();
        for (var t = 0.0; t < s; t += 0.25) {
          c.tick(0.25);
        }
        out.send(['frame', c.frame()]);
      case 'stopLoop':
        loop?.cancel();
      default:
        throw ArgumentError('no core call $method');
    }
    if (method.startsWith('course')) c.tick(0);   // the step's timers (its camera cue) run now
    return null;
  }

  rx.listen((m) async {
    if (m is! List) return;
    switch (m.first) {
      case 'init':
        try {
          final c = AtcCore.create(coreJs: m[1] as String, files: (m[2] as Map).cast<String, String>(), storage: m[3] as String?);
          final b = (m[4] as Map).cast<String, Object?>();
          course = m[5] as bool;
          await c.boot(
            icao: b['icao'] as String? ?? 'KSFO',
            position: b['position'] as String? ?? 'tower',
            difficulty: b['difficulty'] as String?,
            spawn: b['spawn'] as String?,
            ends: (b['ends'] as List?)?.cast<String>(),
            naming: b['naming'] as String?,
            settings: (b['settings'] as Map?)?.cast<String, Object?>(),
          );
          if (course) c.courseStart();
          core = c;
          if (m.length > 6) {
            final f = S1Files(url: m[6] as String, meta: m[7] as String, bin: m[8] as Uint8List, gate: m[9] as String?);
            unawaited(S1Worker.start(f).then((w) {
              if (core == null) return w.dispose();
              s1 = w;
              out.send(['s1', w.control, w.terminate]);   // ends with this worker (a killed isolate takes nothing down with it)
              core!.l1Enable(f.url, f.gate);
            }).catchError((Object e) => out.send(['log', 'command model: $e'])));
          }
          out.send(['booted', {'airport': c.airport(), 'radar': c.radarScene(), 'settings': c.settings()}]);
          out.send(['frame', c.frame()]);
          panels();
          startLoop();
        } catch (e) {
          out.send(['error', '$e']);
        }
      case 'call':
        final id = m[1] as int;
        final c = core;
        if (c == null) {
          out.send(['err', id, 'core not ready']);
          return;
        }
        if (m[2] == 'heard') {
          // the rules answer at once; a call they do not know waits for the command model (the sim runs on meanwhile)
          try {
            final w = s1;
            out.send(['ret', id, await c.heard(((m[3] as List)[0] as List).cast<String>(), model: w == null ? null : w.complete)]);
            if (core != null) panels();
          } catch (e) {
            out.send(['err', id, '$e']);
          }
          return;
        }
        if (m[2] == 'restart') {
          // a new shift: the clock stops while the airport reloads, then runs again from the new session
          loop?.cancel();
          try {
            await c.restart();
            out.send(['ret', id, null]);
          } catch (e) {
            out.send(['err', id, '$e']);
          }
          if (core != null) {
            panels();
            startLoop();
          }
          return;
        }
        try {
          final r = callCore(c, m[2] as String, (m[3] as List).cast<Object?>());
          out.send(['ret', id, r]);
          if (m[2] != 'hints' && m[2] != 'radio' && m[2] != 'airport' && m[2] != 'runways' && m[2] != 'storage' && m[2] != 'settings') panels();   // a change shows at once
        } catch (e) {
          out.send(['err', id, '$e']);
        }
      case 'radar':
        radar = m[1] as bool;
        if (radar) panels();
      case 'run':
        running = m[1] as bool;
        clock
          ..reset()
          ..start();
      case 'stop':
        loop?.cancel();
        final c = core;
        if (c != null) out.send(['storage', c.storage()]);
        c?.dispose();
        core = null;
        s1?.dispose();
        rx.close();
    }
  });
}
