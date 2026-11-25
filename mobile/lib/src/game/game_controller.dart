// One shift: the core (the web game's sim, in QuickJS on its own thread, core_worker.dart), the map frames, the panels,
// the voice. The UI thread only receives:
//
//   30 Hz   frames  -> frames stream (the map)
//    8 Hz   panels  -> notifyListeners (board, card, radio, score, alerts) + pilot voices; course state; radar 15 Hz

import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../audio/sfx.dart';
import '../audio/soundscape.dart';
import '../core/core_worker.dart';
import '../core/models.dart';
import '../models/manifest.dart';
import '../s1/s1_worker.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'airports.dart';
import 'voice.dart';

class ShiftConfig {
  const ShiftConfig({this.icao = 'KSFO', this.position = 'tower', this.difficulty = 'low', this.light = 'auto', this.voices = true});
  final String icao;
  final String position;
  final String difficulty;

  /// 'auto' (the sun at the airport), 'dawn', 'day', 'dusk', 'night'.
  final String light;
  final bool voices;

  ShiftConfig copyWith({String? icao, String? position, String? difficulty, String? light, bool? voices}) =>
      ShiftConfig(icao: icao ?? this.icao, position: position ?? this.position, difficulty: difficulty ?? this.difficulty, light: light ?? this.light, voices: voices ?? this.voices);

  Map<String, Object?> toJson() => {'icao': icao, 'position': position, 'difficulty': difficulty, 'light': light, 'voices': voices};
  factory ShiftConfig.fromJson(Map<String, dynamic> j) => ShiftConfig(
        icao: airportOf(j['icao'] as String? ?? 'KSFO').icao,
        position: j['position'] as String? ?? 'tower',
        difficulty: j['difficulty'] as String? ?? 'low',
        light: j['light'] as String? ?? 'auto',
        voices: j['voices'] as bool? ?? true,
      );

  static const _key = 'openatc_shift_v1';
  static Future<ShiftConfig> load() async {
    final p = await SharedPreferences.getInstance();
    final s = p.getString(_key);
    return s == null ? const ShiftConfig() : ShiftConfig.fromJson(jsonDecode(s) as Map<String, dynamic>);
  }

  Future<void> save() async => (await SharedPreferences.getInstance()).setString(_key, jsonEncode(toJson()));
}

/// What happened to the last call (shown over the radio bar for a few seconds).
class CallResult {
  CallResult(this.outcome, {this.typed = false});
  final CommandOutcome outcome;
  final bool typed;
  final DateTime at = DateTime.now();
}

class GameController extends ChangeNotifier with WidgetsBindingObserver {
  GameController({required this.config, this.speechSpec, this.speechDir, this.commandModel, this.course = false});

  /// The command model to run (the same one the website uses); null or a null answer: the rules alone.
  final Future<S1Files?> Function()? commandModel;

  ShiftConfig config;

  /// The tutorial (/learn): SFO with no traffic, the 747 at its gate, the course card instead of the board.
  final bool course;

  /// The course's state (mobile/core/course.ts state()): step, sections, mission, anchor; null outside the course.
  Map<String, dynamic>? courseState;
  final _cues = StreamController<List<Map<String, dynamic>>>.broadcast();

  /// Map cues from the course (camera moves, lit routes, marks, clear), in lng/lat.
  Stream<List<Map<String, dynamic>>> get cues => _cues.stream;
  late final Narrator narrator = Narrator(radioVoice);
  final ModelSpec? speechSpec;
  final String? speechDir;

  CoreWorker? _w;
  StreamSubscription<CoreEvent>? _sub;
  String? loadError;
  bool get ready => _w != null && loadError == null;
  Map<String, dynamic>? airport;

  /// The airport in play (the tutorial is always SFO).
  String get icao => course ? 'KSFO' : config.icao;

  /// Goes up when the airport's names changed (real / simple): the map puts its labels on again.
  int airportVersion = 0;
  String _names = '';
  bool _renaming = false;

  /// The game's own settings (names, what is heard...), as the core keeps them.
  Map<String, dynamic> core = const {};

  final _frames = StreamController<SimFrame>.broadcast();
  Stream<SimFrame> get frames => _frames.stream;
  SimFrame? frame;
  List<ParkedAircraft> parked = const [];
  bool parkedChanged = false;

  /// The approach scope: its chart (once) and the traffic (15 Hz while the scope is on screen).
  Map<String, dynamic>? radarScene;
  final ValueNotifier<Map<String, dynamic>?> radarFrame = ValueNotifier(null);
  bool radarOn = false;

  UiState? ui;
  final List<RadioLine> radio = [];
  CallResult? lastCall;
  String partial = '';
  bool _myAi = false;

  final Voice voice = Voice();
  final RadioVoice radioVoice = RadioVoice();
  static const _storageKey = 'openatc_core_storage_v1';

  /// Where the camera listens from (the map keeps it current); the airport's middle until the map has reported.
  Ear? ear;
  final Soundscape _sound = Soundscape();
  Timer? _soundTimer;

  /// Ten times a second: what the airfield sounds like from here. On the scope there is only the radar room.
  void _hear() {
    final f = frame, c = (airport?['center'] as List?)?.cast<num>();
    final talking = radioVoice.speaking || narrator.speaking;
    Sfx.I.speaking(talking);
    Sfx.I.bed(radarOn ? Bed.scope : Bed.field);
    final l = ear ?? (c == null ? null : Ear(lng: c[0].toDouble(), lat: c[1].toDouble(), bearing: 298, pitch: 50, distanceM: 4600));
    if (f == null || l == null) return;
    final s = _sound.update(f, l, 0.1, paused: ui?.paused ?? false);   // kept going on the scope: nothing fires late on the way back
    Sfx.I.world(radarOn ? const {} : s.loops, radarOn ? const [] : s.shots);
  }

  Future<void> start() async {
    WidgetsBinding.instance.addObserver(this);
    try {
      final b = rootBundle;
      final prefs = await SharedPreferences.getInstance();
      final icao = this.icao;
      final files = <String, String>{
        '/maps/osm/$icao.geojson': await b.loadString('assets/airports/$icao.geojson'),
        '/airspace/$icao.txt': await b.loadString('assets/airports/$icao.txt'),
      };
      try {
        files['/maps/baked/$icao.json'] = await b.loadString('assets/airports/$icao.baked.json');
        files['/maps/baked/$icao.names.json'] = await b.loadString('assets/airports/$icao.names.json');
        files['/maps/baked/$icao.limits.json'] = await b.loadString('assets/airports/$icao.limits.json');
      } catch (_) {/* built on the phone instead (slower) */}
      final bootArgs = course
          // as /learn: no traffic, ground seat, all four runways
          ? <String, Object?>{'icao': icao, 'position': 'ground', 'spawn': 'none', 'ends': const ['28L', '28R', '01L', '01R'], 'naming': 'real', 'settings': {'tts': config.voices, 'sound': true}}
          : <String, Object?>{'icao': icao, 'position': config.position, 'difficulty': config.difficulty, 'settings': {'tts': config.voices, 'sound': true}};
      final w = await CoreWorker.start(coreJs: await b.loadString('assets/core/core.js'), files: files, storage: prefs.getString(_storageKey), bootArgs: bootArgs, course: course, s1: await commandModel?.call());
      _w = w;
      airport = w.boot.airport;
      radarScene = w.boot.radarScene;
      core = w.boot.settings;
      _names = airport?['naming'] as String? ?? '';
      _myAi = _aiOf(w.boot.settings);
      _sub = w.events.listen(_onEvent);
      if (radarOn) w.setRadar(true);
      if (!_disposed) _soundTimer = Timer.periodic(const Duration(milliseconds: 100), (_) => _hear());
      notifyListeners();
    } catch (e) {
      loadError = '$e';
      notifyListeners();
    }
    unawaited(radioVoice.init().then((_) => radioVoice.enabled = config.voices));
    final spec = speechSpec, dir = speechDir;
    if (spec != null && dir != null) loadVoice(spec, dir);
    unawaited(WakelockPlus.enable().catchError((Object _) {}));   // the screen stays on while you watch traffic
  }

  bool _disposed = false;

  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  void _onEvent(CoreEvent e) {
    if (_disposed) return;
    switch (e) {
      case FrameEvent(:final frame):
        this.frame = frame;
        if (frame.parked != null) {
          parked = frame.parked!;
          parkedChanged = true;
        }
        if (!_frames.isClosed) _frames.add(frame);
      case UiEvent(:final ui):
        this.ui = ui;
        _absorb(ui);
        notifyListeners();
      case CourseEvent(:final state):
        _applyCourse(state);
        notifyListeners();
      case RadarEvent(:final frame):
        radarFrame.value = frame;
      case StorageEvent(:final json):
        unawaited(SharedPreferences.getInstance().then((p) => p.setString(_storageKey, json)).catchError((Object _) => false));
    }
  }

  /// Load the speech model (at start, or once it has been downloaded mid-shift).
  void loadVoice(ModelSpec spec, String dir) {
    if (voice.available || voice.state == VoiceState.loading) return;
    unawaited(voice.load(spec, dir).then((_) => notifyListeners()));
    notifyListeners();
  }

  void _applyCourse(Map<String, dynamic> c) {
    courseState = c;
    final cues = (c['cues'] as List).cast<Map<String, dynamic>>();
    if (cues.isNotEmpty && !_cues.isClosed) _cues.add(cues);
    final nar = (c['narrate'] as List).cast<String>();
    if (nar.isNotEmpty) narrator.say(nar);
    for (final f in (c['sfx'] as List).cast<String>()) {
      narrator.sfx(f);
    }
  }

  Future<T?> _call<T>(String method, [List<Object?> args = const []]) async {
    final w = _w;
    if (w == null) return null;
    try {
      return await w.call<T>(method, args);
    } catch (e) {
      debugPrint('core $method: $e');
      return null;
    }
  }

  // ── the course ──
  void _course(String method, [List<Object?> args = const []]) {
    unawaited(narrator.hush());
    unawaited(_call<void>(method, args));
  }

  void courseNext() => _course('courseNext');
  void courseBack() => _course('courseBack');
  void courseSection(String sec) => _course('courseGoSection', [sec]);
  void courseRestart() => _course('courseRestart');
  void courseFreePlay() => _course('courseFreePlay');
  void courseDismiss(int id) => _course('courseDismissNote', [id]);
  Future<void> courseSend(String phrase) async {
    unawaited(narrator.hush());
    final r = await _call<CommandOutcome>('courseSend', [phrase]);
    if (r != null) lastCall = CallResult(r, typed: true);
    notifyListeners();
  }

  void _absorb(UiState u) {
    if (_names.isNotEmpty && u.names != _names) unawaited(_rename(u.names));
    if (u.radio.isNotEmpty) {
      radio.addAll(u.radio);
      if (radio.length > 300) radio.removeRange(0, radio.length - 300);
    }
    for (final s in u.sounds) {
      if (s.kind == 'speak' && s.text != null) radioVoice.say(s.text!, who: s.who, callsign: s.callsign);
      if (s.kind == 'stop') unawaited(radioVoice.stop());
      // (selecting, pausing: their sounds play with the press itself)
      if (s.kind == 'cue' && s.cue != null && !const {'select', 'pause', 'resume'}.contains(s.cue)) Sfx.I.cue(s.cue!);
      if (s.kind == 'alert') Sfx.I.cue('alert-${s.severity == 'critical' ? 'critical' : s.severity == 'warning' ? 'warning' : 'info'}');
      if (s.kind == 'alert' && s.severity == 'critical') HapticFeedback.heavyImpact();
    }
  }

  Future<void> _rename(String names) async {
    if (_renaming) return;
    _renaming = true;
    final a = await _call<Map<String, dynamic>>('airport');
    _renaming = false;
    if (a == null) return;
    _names = a['naming'] as String? ?? names;
    airport = a;
    airportVersion++;
    notifyListeners();
  }

  /// Taxiway and stand names: 'auto' (real at SFO, simple elsewhere), 'real', 'simple'. Also in the middle of a shift.
  void setNaming(String v) => _setting('naming', v);

  /// In the tower: also hear the ground frequency.
  void setHearGround(bool on) {
    Sfx.I.ui(on ? 'toggle_on' : 'toggle_off');
    _setting('hearGround', on);
  }

  void _setting(String key, Object value) {
    core = {...core, key: value};
    notifyListeners();
    unawaited(_call<Map<String, dynamic>>('settings', [<String, Object?>{key: value}]).then((s) {
      if (s != null) core = s;
      notifyListeners();
    }));
  }

  Future<RunwaysState?> runways() => _call<RunwaysState>('runways');
  Future<String> toggleRunway(String name, String role) async => await _call<String>('toggleRunway', [name, role]) ?? '';
  Future<String> runwaysIntoWind() async => await _call<String>('runwaysIntoWind') ?? '';

  /// Tests: run the sim [seconds] ahead at once, then wait for the panels.
  @visibleForTesting
  Future<void> debugAdvance(double seconds) async {
    await _call<void>('debugAdvance', [seconds]);
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }

  @visibleForTesting
  Future<void> debugStopLoop() async => _call<void>('stopLoop');

  // ── player actions ──

  void select(int? id) {
    Sfx.I.ui(id == null ? 'close' : 'select');
    unawaited(_call<void>('select', [id]));
  }

  /// The scope came on screen (or left it): its traffic is only computed while it shows.
  void setRadar(bool on) {
    radarOn = on;
    _w?.setRadar(on);
  }

  Future<CommandOutcome?> type(String text) async {
    if (text.trim().isEmpty) return null;
    final r = await _call<CommandOutcome>('command', [text.trim()]);
    if (r != null) lastCall = CallResult(r, typed: true);
    notifyListeners();
    return r;
  }

  /// The button is held (a release that comes before the mic has opened ends the call as soon as it opens).
  bool _pttHeld = false;
  StreamSubscription<String>? _partialSub;

  Future<void> pttDown() async {
    if (_w == null || _pttHeld) return;
    _pttHeld = true;
    partial = '';
    Sfx.I.transmitting(true);   // silence before the mic opens: the speaker must not reach the recogniser
    unawaited(radioVoice.hold(true));
    HapticFeedback.mediumImpact();
    unawaited(_call<void>('l1Prefill'));   // the command model reads the state while you talk
    final hints = await _call<List<String>>('hints') ?? const [];
    final ok = await voice.start(hints);
    if (!ok) {
      _pttHeld = false;
      Sfx.I.transmitting(false);
      Sfx.I.ui('error');
      unawaited(radioVoice.hold(false));
      lastCall = CallResult(CommandOutcome(ok: false, sent: false, line: '', error: voice.error ?? 'The speech model is not loaded yet.'));
    }
    _partialSub ??= voice.partials.listen((t) {
      partial = t;
      notifyListeners();
    });
    notifyListeners();
    if (ok && !_pttHeld) await _release();   // let go while the mic was opening
  }

  Future<void> pttUp() async {
    _pttHeld = false;
    await _release();
  }

  Future<void> _release() async {
    if (_w == null || voice.state != VoiceState.listening) return;
    HapticFeedback.lightImpact();
    notifyListeners();
    final text = await voice.stop(micClosed: () => Sfx.I.transmitting(false));
    unawaited(radioVoice.hold(false));
    partial = '';
    if (text.isEmpty) {
      Sfx.I.ui('error');
      lastCall = CallResult(const CommandOutcome(ok: false, sent: false, line: '', error: 'Nothing heard. Hold the button while you speak.'));
    } else {
      final r = await _call<CommandOutcome>('heard', [<String>[text]]);
      if (r == null || !r.sent) Sfx.I.ui('error');   // (a sent call that is refused: the sim's own cue)
      lastCall = CallResult(r ?? const CommandOutcome(ok: false, sent: false, line: '', error: 'Not understood'));
    }
    notifyListeners();
  }

  void setPosition(String p) {
    Sfx.I.ui('view');
    config = config.copyWith(position: p);
    unawaited(config.save());
    // the seat you move to is yours (the AI keeps the other one) until you hand it to the AI too
    _myAi = false;
    unawaited(_call<void>('setPosition', [p]).then((_) => _call<void>('setSectorAi', [false])).then((_) => _refreshAi()));
  }

  void setPaused(bool b) {
    Sfx.I.ui(b ? 'pause' : 'resume');
    unawaited(_call<void>('setPaused', [b]));
  }

  void setRate(int r) {
    Sfx.I.ui('view', speed: r == 1 ? 1 : r == 2 ? 1.12 : 1.25);
    unawaited(_call<void>('setRate', [r]));
  }

  void setLight(String l) {
    config = config.copyWith(light: l);
    unawaited(config.save());
    notifyListeners();
  }

  void setVoices(bool on) {
    Sfx.I.ui(on ? 'toggle_on' : 'toggle_off');
    config = config.copyWith(voices: on);
    unawaited(config.save());
    radioVoice.enabled = on;
    if (!on) unawaited(radioVoice.stop());
    unawaited(_call<void>('settings', [<String, Object?>{'tts': on}]));
    notifyListeners();
  }

  /// The AI works your seat too (watch it, or take a break).
  void setMyAi(bool on) {
    Sfx.I.ui(on ? 'ai_on' : 'ai_off');
    _myAi = on;
    notifyListeners();
    unawaited(_call<void>('setSectorAi', [on]).then((_) => _refreshAi()));
  }

  bool get myAi => _myAi;
  bool _aiOf(Map<String, dynamic> s) => config.position == 'approach' ? s['autoApproach'] == true : s['autoTower'] == true && s['autoGround'] == true;
  Future<void> _refreshAi() async {
    final s = await _call<Map<String, dynamic>>('settings');
    if (s != null) {
      core = s;
      _myAi = _aiOf(s);
    }
    notifyListeners();
  }

  Future<void> restart() async {
    Sfx.I.ui('start');
    _sound.reset();
    radio.clear();
    await _call<void>('restart');
  }

  /// Every radio line (the full log).
  Future<List<RadioLine>> fullRadio() async => await _call<List<RadioLine>>('radio') ?? radio;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final fg = state == AppLifecycleState.resumed;
    _w?.setRunning(fg);   // the sim holds while the app is away
    if (!fg) {
      unawaited(narrator.hush());
      unawaited(voice.cancel());
      _pttHeld = false;
      Sfx.I.transmitting(false);
      unawaited(radioVoice.stop());
      unawaited(_call<String>('storage').then((j) async {
        if (j != null) (await SharedPreferences.getInstance()).setString(_storageKey, j);
      }));
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _soundTimer?.cancel();
    if (_pttHeld) Sfx.I.transmitting(false);
    Sfx.I
      ..speaking(false)
      ..world(const {}, const [])
      ..bed(Bed.home);
    WidgetsBinding.instance.removeObserver(this);
    unawaited(WakelockPlus.disable().catchError((Object _) {}));
    unawaited(_sub?.cancel());
    _w?.dispose();
    unawaited(_partialSub?.cancel());
    unawaited(voice.dispose());
    unawaited(radioVoice.stop());
    unawaited(narrator.dispose());
    unawaited(_cues.close());
    radarFrame.dispose();
    unawaited(_frames.close());
    super.dispose();
  }
}
