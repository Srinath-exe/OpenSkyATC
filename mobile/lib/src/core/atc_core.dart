// The game itself, on the phone: the web game's simulation, parser and AI (mobile/core, bundled into
// assets/core/core.js) running in an embedded JS engine (QuickJS through flutter_js). No WebView, no network: the app
// hands it the airport files, advances its clock, and draws what frame() / ui() return natively.
//
//   core.tick(dt)        advance (the store applies pause and the 1x/2x/4x rate)
//   core.frame()         aircraft positions / attitudes / routes for the map
//   core.ui()            board, selected flight, new radio lines, toasts, alerts, score, sounds to play
//   core.heard([...])    what the recogniser heard -> repaired, parsed, sent when understood
//   core.command(text)   a typed line

import 'dart:async';
import 'dart:convert';

import 'package:flutter_js/flutter_js.dart';

import 'models.dart';

class AtcCoreError implements Exception {
  AtcCoreError(this.message);
  final String message;
  @override
  String toString() => 'AtcCoreError: $message';
}

class AtcCore {
  AtcCore._(this._rt);
  final JavascriptRuntime _rt;
  bool _disposed = false;

  /// Load the core script and the airport files it may ask for (`path` -> text, e.g. '/maps/osm/KSFO.geojson').
  static AtcCore create({required String coreJs, required Map<String, String> files, String? storage}) {
    final rt = getJavascriptRuntime(xhr: false);
    final c = AtcCore._(rt);
    c._eval(coreJs, source: 'core.js');
    for (final e in files.entries) {
      c._eval('ATC.provide(${jsonEncode(e.key)}, ${jsonEncode(e.value)})');
    }
    if (storage != null) c._eval('ATC.restore(${jsonEncode(storage)})');
    return c;
  }

  String _eval(String code, {String? source}) {
    if (_disposed) throw AtcCoreError('disposed');
    final r = _rt.evaluate(code, sourceUrl: source);
    if (r.isError) throw AtcCoreError(r.stringResult);
    return r.stringResult;
  }

  Map<String, dynamic> _json(String code) => jsonDecode(_eval(code)) as Map<String, dynamic>;

  /// Run the engine's pending promise jobs (the store's load and the voice chain are async).
  void _drain() {
    for (var i = 0; i < 10000; i++) {
      if (_rt.executePendingJob() <= 0) break;
    }
  }

  /// Start a session and wait for it (building the airport graph takes a moment on a phone).
  Future<void> boot({String icao = 'KSFO', String position = 'tower', String? difficulty, int? seed, String? spawn, List<String>? ends, String? naming, Map<String, Object?>? settings}) async {
    _eval('ATC.boot(${jsonEncode(jsonEncode({'icao': icao, 'position': position, 'difficulty': ?difficulty, 'seed': ?seed, 'spawn': ?spawn, 'ends': ?ends, 'naming': ?naming, 'settings': ?settings}))})');
    await _waitReady();
  }

  Future<void> _waitReady() async {
    final sw = Stopwatch()..start();
    while (sw.elapsed < const Duration(seconds: 60)) {
      _drain();
      final s = _json('ATC.status()');
      if (s['state'] == 'ready') return;
      if (s['state'] == 'error') throw AtcCoreError('${s['error']}');
      await Future<void>.delayed(const Duration(milliseconds: 16));
    }
    throw AtcCoreError('the airport took too long to load');
  }

  void tick(double dt) {
    _eval('ATC.tick($dt)');
    _drain();
  }

  SimFrame frame() => SimFrame.fromJson(_json('ATC.frame()'));
  UiState ui() => UiState.fromJson(_json('ATC.ui()'));
  Map<String, dynamic> airport() => _json('ATC.airport()');
  List<RadioLine> radio() => (jsonDecode(_eval('ATC.radio()')) as List).map((e) => RadioLine.fromJson(e as Map<String, dynamic>)).toList();

  /// Spoken names to bias the recogniser with ("united two one four").
  List<String> hints() => (jsonDecode(_eval('ATC.hints()')) as List).cast<String>();
  List<Map<String, dynamic>> practice() => (jsonDecode(_eval('ATC.practice()')) as List).cast<Map<String, dynamic>>();

  CommandOutcome command(String text) {
    final r = _json('ATC.command(${jsonEncode(text)})');
    _drain();
    return CommandOutcome(ok: r['ok'] == true, sent: true, line: text, error: r['error'] as String?, faults: CallFault.list(r['faults']));
  }

  /// The recogniser's guesses, best first: understood -> sent; otherwise what to show the player.
  /// [model] answers the command model's questions (the rules are tried first, so most calls never ask).
  Future<CommandOutcome> heard(List<String> alternatives, {Future<Map<String, Object?>?> Function(String said, List<String> callsigns, String ctx)? model}) async {
    _eval('globalThis.__heard = null; ATC.heard(${jsonEncode(jsonEncode(alternatives))}).then(function (r) { globalThis.__heard = r }, function (e) { globalThis.__heard = JSON.stringify({ ok: false, error: String(e) }) })');
    _drain();
    for (var turn = 0; turn < 12 && _eval('globalThis.__heard ? "y" : "n"') == 'n'; turn++) {
      final asks = (jsonDecode(_eval('ATC.l1Take()')) as List).cast<Map<String, dynamic>>();
      if (asks.isEmpty) break;
      for (final q in asks) {
        Map<String, Object?>? a;
        try {
          a = await model?.call(q['said'] as String, (q['callsigns'] as List).cast<String>(), q['ctx'] as String);
        } catch (_) {/* the rules' answer stands */}
        _eval('ATC.l1Answer(${q['id']}, ${a == null ? 'null' : jsonEncode(jsonEncode(a))})');
        _drain();
      }
    }
    final raw = _eval('globalThis.__heard || "null"');
    final r = jsonDecode(raw) as Map<String, dynamic>?;
    if (r == null) return const CommandOutcome(ok: false, sent: false, line: '', error: 'Not understood');
    return CommandOutcome(
      ok: r['ok'] == true,
      sent: r['sent'] == true,
      line: (r['line'] as String?) ?? '',
      heard: r['heard'] as String?,
      error: r['error'] as String?,
      sayAgain: r['sayAgain'] == true,
      faults: CallFault.list(r['faults']),
    );
  }

  /// Use the command model [url] names (null: rules only); [gate] when it is newer than this build.
  void l1Enable(String? url, [String? gate]) => _eval('ATC.l1Enable(${url == null ? 'null' : jsonEncode(url)}, ${gate == null ? 'null' : jsonEncode(gate)})');
  String l1Ctx() => _eval('ATC.l1Ctx()');

  void select(int? id) => _eval('ATC.select(${id ?? 'null'})');
  void setPosition(String p) => _eval('ATC.setPosition(${jsonEncode(p)})');
  void setPaused(bool b) => _eval('ATC.setPaused($b)');
  void setRate(int r) => _eval('ATC.setRate($r)');
  void setSectorAi(bool on) => _eval('ATC.setSectorAi($on)');
  Map<String, dynamic> settings([Map<String, Object?>? patch]) => _json('ATC.settings(${patch == null ? '' : jsonEncode(jsonEncode(patch))})');
  /// A new shift (same airport and options, the seat in use now, new traffic); waits for it as boot does.
  Future<void> restart() async {
    _eval('ATC.restart()');
    await _waitReady();
  }

  // ── runways in use ──
  RunwaysState runways() => RunwaysState.fromJson(_json('ATC.runways()'));

  /// Flip one end for departures ('dep') or arrivals ('arr'); returns why not, or nothing.
  String toggleRunway(String name, String role) => _json('ATC.toggleRunway(${jsonEncode(name)}, ${jsonEncode(role)})')['why'] as String? ?? '';
  String runwaysIntoWind() => _json('ATC.runwaysIntoWind()')['why'] as String? ?? '';

  // ── the approach scope (mobile/core/radar.ts) ──
  Map<String, dynamic>? radarScene() => jsonDecode(_eval('ATC.radarScene()')) as Map<String, dynamic>?;
  Map<String, dynamic> radarFrame() => _json('ATC.radarFrame()');

  // ── the tutorial (mobile/core/course.ts) ──
  void courseStart({bool fromStart = false}) {
    _eval('ATC.course.start($fromStart)');
    _drain();
  }

  Map<String, dynamic> courseState() => _json('ATC.course.state()');
  void courseNext() => _eval('ATC.course.next()');
  void courseBack() => _eval('ATC.course.back()');
  void courseGoSection(String sec) => _eval('ATC.course.goSection(${jsonEncode(sec)})');
  void courseRestart() => _eval('ATC.course.restart()');
  void courseFreePlay() => _eval('ATC.course.freePlay()');
  void courseDismissNote(int id) => _eval('ATC.course.dismissNote($id)');
  CommandOutcome courseSend(String phrase) {
    final r = _json('ATC.course.send(${jsonEncode(phrase)})');
    _drain();
    return CommandOutcome(ok: r['ok'] == true, sent: true, line: phrase, error: r['error'] as String?);
  }

  /// The game's localStorage (high score, settings), for the app to keep between launches.
  String storage() => _eval('ATC.storage()');

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _rt.dispose();
  }
}
