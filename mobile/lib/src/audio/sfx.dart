// The game's sound: SoLoud plays, this decides. Three groups, each with its own volume:
//
//   airfield   the aircraft (soundscape.dart) and the place (the field at night, the radar room, the home screen)
//   interface  every button, swipe and cue            radio   squelch clicks and the hiss under a pilot's voice
//
// While the player transmits everything but the interface falls silent at once (the phone's own speaker would reach the
// microphone and the recogniser); while a pilot or the narrator speaks the airfield steps back.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_soloud/flutter_soloud.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'soundscape.dart';
import 'tappable.dart';

/// What plays the sounds (SoLoud on the phone; tests record what was asked for).
abstract class AudioOut {
  Future<void> open(List<String> names);
  Object? loop(String name, double gain, double speed, double pan);
  void tune(Object h, double gain, double speed, double pan, int ms);
  void stop(Object h, int ms);
  void shot(String name, double gain, double speed, double pan);
  void master(double gain);
}

class SoLoudOut implements AudioOut {
  final Map<String, AudioSource> _src = {};
  SoLoud get _so => SoLoud.instance;

  @override
  Future<void> open(List<String> names) async {
    // the conservative output path: its few ms more latency do not matter here, and screen recordings get the sound
    await _so.init(sampleRate: 44100, bufferSize: 1024, channels: Channels.stereo, lowLatency: false);
    _so.setMaxActiveVoiceCount(48);
    for (final n in names) {
      try {
        _src[n] = await _so.loadAsset('assets/sound/$n.wav');
      } catch (e) {
        debugPrint('sound $n: $e');
      }
    }
  }

  @override
  Object? loop(String name, double gain, double speed, double pan) {
    final s = _src[name];
    if (s == null) return null;
    final h = _so.play(s, volume: 0, pan: pan, looping: true);
    _so.setRelativePlaySpeed(h, speed);
    _so.fadeVolume(h, gain, const Duration(milliseconds: 250));
    return h;
  }

  @override
  void tune(Object h, double gain, double speed, double pan, int ms) {
    final t = Duration(milliseconds: ms), v = h as SoundHandle;
    _so.fadeVolume(v, gain, t);
    _so.fadeRelativePlaySpeed(v, speed, t);
    _so.fadePan(v, pan, t);
  }

  @override
  void stop(Object h, int ms) {
    final t = Duration(milliseconds: ms), v = h as SoundHandle;
    _so.fadeVolume(v, 0, t);
    _so.scheduleStop(v, t);
  }

  @override
  void shot(String name, double gain, double speed, double pan) {
    final s = _src[name];
    if (s == null) return;
    final h = _so.play(s, volume: gain, pan: pan);
    if ((speed - 1).abs() > 0.005) _so.setRelativePlaySpeed(h, speed);
  }

  @override
  void master(double gain) => _so.fadeGlobalVolume(gain, const Duration(milliseconds: 120));
}

enum Bed { none, home, field, scope }

class Sfx with WidgetsBindingObserver {
  Sfx._();
  static final Sfx I = Sfx._();

  static const names = [
    // interface
    'tap', 'key', 'select', 'swipe', 'open', 'close', 'view', 'toggle_on', 'toggle_off', 'ai_on', 'ai_off', 'start', 'done',
    'ptt_on', 'ptt_off', 'squelch_open', 'squelch_close', 'transmit', 'readback', 'request', 'handoff', 'resolve', 'score_up', 'score_down',
    'error', 'undo', 'pause', 'resume', 'alert_info', 'alert_warning', 'alert_critical', 'emergency',
    // aircraft
    'idle_s', 'idle_m', 'idle_h', 'roar_s', 'roar_m', 'roar_h', 'rev_s', 'rev_m', 'rev_h', 'prop_idle', 'prop_power', 'rumble', 'air', 'roll', 'tug', 'apu',
    'touch_s', 'touch_m', 'touch_h', 'spool_up', 'spool_down',
    // places
    'amb_field', 'amb_scope', 'amb_home', 'static',
  ];

  AudioOut? _out;
  bool _open = false;

  /// 0..1, kept between sessions: the airfield and the interface (which carries the radio clicks too).
  double airfield = 0.8, interface = 0.8;
  static const _prefs = 'openatc_sound_v1';

  bool _transmitting = false, _speaking = false, _away = false;
  Bed _bed = Bed.none;
  final Map<String, ({String sample, Object handle})> _loops = {};
  Map<String, LoopWant> _want = const {};
  final Map<String, DateTime> _last = {};
  DateTime _lastUi = DateTime(0);

  /// Never throws: a phone whose audio will not open plays the game in silence.
  Future<void> init({AudioOut? out}) async {
    if (_open) return;
    try {
      final p = await SharedPreferences.getInstance();
      final j = p.getString(_prefs);
      if (j != null) {
        final m = jsonDecode(j) as Map<String, dynamic>;
        airfield = (m['airfield'] as num).toDouble().clamp(0, 1);
        interface = (m['interface'] as num).toDouble().clamp(0, 1);
      }
      final o = out ?? SoLoudOut();
      await o.open(names);
      _out = o;
      _open = true;
      WidgetsBinding.instance.addObserver(this);
      _apply(300);
    } catch (e) {
      debugPrint('sound: $e');
    }
  }

  void setVolumes({double? airfield, double? interface}) {
    if (airfield != null) this.airfield = airfield;
    if (interface != null) this.interface = interface;
    _apply(80);
  }

  Future<void> saveVolumes() async => (await SharedPreferences.getInstance()).setString(_prefs, jsonEncode({'airfield': airfield, 'interface': interface}));

  // ── interface ──

  /// Something the player did or must hear. The same cue twice within a moment plays once.
  void ui(String name, {double gain = 1, double speed = 1}) {
    final o = _out;
    if (o == null || interface <= 0 || _away) return;
    if (_transmitting && name != 'ptt_off') return;   // nothing over the player's own voice
    final now = DateTime.now(), long = name.startsWith('alert') || name == 'emergency';
    if (now.difference(_last[name] ?? DateTime(0)).inMilliseconds < (long ? 400 : 70)) return;
    _last[name] = now;
    _lastUi = now;
    o.shot(name, gain * interface, speed, 0);
  }

  /// A button with no sound of its own: plays unless the press already made one.
  void tapAfter(DateTime pressed) {
    if (!_lastUi.isBefore(pressed)) return;
    ui('tap');
  }

  /// The simulation's cues (core/sound.ts).
  void cue(String cue) => ui(switch (cue) { 'score-up' => 'score_up', 'score-down' => 'score_down', 'alert-info' => 'alert_info', 'alert-warning' => 'alert_warning', 'alert-critical' => 'alert_critical', 'tick' => 'key', _ => cue });

  // ── the radio ──

  /// The player is holding the talk button.
  void transmitting(bool on) {
    if (_transmitting == on) return;
    ui(on ? 'ptt_on' : 'ptt_off');
    _transmitting = on;
    _apply(on ? 60 : 500);
  }

  /// A pilot's line: the squelch opens, hiss under the voice, the squelch closes.
  void pilotLine(bool on) {
    if (_transmitting && on) return;
    ui(on ? 'squelch_open' : 'squelch_close', gain: 0.9);
    _setLoop('static', on ? LoopWant('static', 0.16 * interface, 1, 0) : null, 80);
  }

  /// A pilot, a controller or the narrator is speaking: the airfield steps back.
  void speaking(bool on) {
    if (_speaking == on) return;
    _speaking = on;
    _apply(on ? 200 : 700);
  }

  // ── places and aircraft ──

  void bed(Bed b) {
    if (_bed == b) return;
    _bed = b;
    _apply(900);
  }

  void world(Map<String, LoopWant> loops, List<Shot> shots) {
    _want = loops;
    _apply(130);
    final o = _out, k = _world;
    if (o == null || k <= 0) return;
    for (final s in shots) {
      if (s.gain > 0.01) o.shot(s.sample, s.gain * k, s.speed, s.pan);
    }
  }

  /// (1.35: a wide-body's take-off then peaks just under full scale at full volume)
  double get _world => _away || _transmitting ? 0 : airfield * 1.35 * (_speaking ? 0.38 : 1);

  void _apply(int ms) {
    if (_out == null) return;
    final k = _world;
    // the night field is loudest on its own, and gives way to an engine next to it
    final busy = _want.values.fold(0.0, (a, w) => a + w.gain).clamp(0.0, 1.0);
    final b = switch (_bed) { Bed.home => ('amb_home', 0.40), Bed.field => ('amb_field', 0.46 * (1 - 0.4 * busy)), Bed.scope => ('amb_scope', 0.30), Bed.none => null };
    final now = <String, LoopWant>{
      if (b != null && k > 0) 'bed:${b.$1}': LoopWant(b.$1, b.$2 * k, 1, 0),
      if (k > 0)
        for (final e in _want.entries) e.key: LoopWant(e.value.sample, e.value.gain * k, e.value.speed, e.value.pan),
    };
    for (final key in _loops.keys.toList()) {
      if (key != 'static' && !now.containsKey(key)) _setLoop(key, null, ms);
    }
    now.forEach((key, w) => _setLoop(key, w, ms));
  }

  void _setLoop(String key, LoopWant? w, int ms) {
    final o = _out;
    if (o == null) return;
    final cur = _loops[key];
    if (w == null || (cur != null && cur.sample != w.sample)) {
      if (cur != null) {
        o.stop(cur.handle, w == null ? ms.clamp(60, 900) : 150);
        _loops.remove(key);
      }
      if (w == null) return;
    }
    final live = _loops[key];
    if (live != null) {
      o.tune(live.handle, w.gain, w.speed, w.pan, ms);
    } else {
      final h = o.loop(w.sample, w.gain, w.speed, w.pan);
      if (h != null) _loops[key] = (sample: w.sample, handle: h);
    }
  }

  @visibleForTesting
  Set<String> get playing => _loops.keys.toSet();

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final away = state != AppLifecycleState.resumed && state != AppLifecycleState.inactive;
    if (away == _away) return;
    _away = away;
    _out?.master(away ? 0 : 1);
    if (away) _setLoop('static', null, 60);
    _apply(away ? 60 : 500);
  }
}

/// Every button in the app clicks: a press that lands on something tappable (wherever it is: sheets, dialogs, the game)
/// plays the tap, unless what it did made a sound of its own.
class TapSounds extends StatefulWidget {
  const TapSounds({super.key, required this.child});
  final Widget child;
  @override
  State<TapSounds> createState() => _TapSoundsState();
}

class _TapSoundsState extends State<TapSounds> {
  Offset? _at;
  DateTime _when = DateTime(0);

  void _up(PointerUpEvent e) {
    final at = _at;
    _at = null;
    if (at == null || (e.position - at).distance > 18 || DateTime.now().difference(_when).inMilliseconds > 600) return;
    final hit = HitTestResult();
    WidgetsBinding.instance.hitTestInView(hit, e.position, e.viewId);
    if (!hit.path.any((h) => tappable(h.target))) return;
    final pressed = _when;
    Timer(const Duration(milliseconds: 30), () => Sfx.I.tapAfter(pressed));   // after the tap itself ran
  }

  @override
  Widget build(BuildContext context) => Listener(
        onPointerDown: (e) {
          _at = e.position;
          _when = DateTime.now();
        },
        onPointerUp: _up,
        onPointerCancel: (_) => _at = null,
        child: widget.child,
      );
}
