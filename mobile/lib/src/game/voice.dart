// Push-to-talk on the phone: microphone -> on-device speech model (sherpa-onnx in its own isolate) -> text, biased
// toward the callsigns on frequency; and the pilots' voices back through the phone's text-to-speech.

import 'dart:async';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';

import '../audio/sfx.dart';
import 'package:flutter_tts/flutter_tts.dart';

import '../audio/mic.dart';
import '../models/manifest.dart';
import '../stt/hotwords.dart';
import '../stt/stt_engine.dart';
import '../stt/stt_service.dart';

enum VoiceState { off, loading, ready, listening, thinking, error }

class Voice {
  Voice({MicSource? mic}) : _mic = mic ?? RecordMic();

  final MicSource _mic;
  SpeechToText? _stt;
  VoiceState state = VoiceState.off;
  String? error;
  String label = '';
  final _partials = StreamController<String>.broadcast();
  StreamSubscription<String>? _sub;
  bool _open = false;

  Stream<String> get partials => _partials.stream;
  bool get available => _stt != null;

  /// Load the installed model (a second or two; runs in the background).
  Future<void> load(ModelSpec spec, String dir) async {
    state = VoiceState.loading;
    try {
      final threads = Platform.numberOfProcessors >= 6 ? 2 : 1;
      _stt = await IsolateStt.start(spec, dir, options: SttOptions(threads: threads));
      label = spec.name;
      state = VoiceState.ready;
    } catch (e) {
      error = '$e';
      state = VoiceState.error;
    }
  }

  /// Press: start listening, biased toward [hints] ("united two one four").
  Future<bool> start(List<String> hints) async {
    final stt = _stt;
    if (stt == null || _open) return false;
    if (!await _mic.ensurePermission()) {
      error = 'Microphone permission is off. Allow it in Settings > Apps > OpenATC > Permissions.';
      return false;
    }
    stt.begin(buildHotwords(spoken: hints));
    await _sub?.cancel();
    _sub = stt.partials.listen(_partials.add);
    await _mic.open(stt.feed);
    _open = true;
    state = VoiceState.listening;
    return true;
  }

  /// Release: the transcript ('' when nothing was heard).
  Future<String> stop({void Function()? micClosed}) async {
    final stt = _stt;
    if (stt == null || !_open) {
      micClosed?.call();
      return '';
    }
    _open = false;
    state = VoiceState.thinking;
    try {
      try {
        await _mic.close();
      } finally {
        micClosed?.call();
      }
      final SttResult r = await stt.finish();
      return r.text.trim();
    } catch (e) {
      error = '$e';
      return '';
    } finally {
      await _sub?.cancel();
      _sub = null;
      state = VoiceState.ready;
    }
  }

  Future<void> cancel() async {
    if (!_open) return;
    _open = false;
    try {
      await _mic.close();
    } catch (_) {}
    _stt?.cancel();
    state = VoiceState.ready;
  }

  Future<void> dispose() async {
    await cancel();
    await _sub?.cancel();
    await _stt?.dispose();
    await _mic.dispose();
    await _partials.close();
  }
}

/// Pilot and controller voices: one line at a time, a different voice pitch per callsign, quiet while the player talks.
class RadioVoice {
  final FlutterTts _tts = FlutterTts();
  final List<({String text, String? who, String? callsign})> _queue = [];
  bool _busy = false;
  bool enabled = true;
  bool _held = false;

  /// A pilot or controller is talking (the tutorial's narrator waits for the radio).
  bool get speaking => _busy;

  Future<void> init() async {
    await _tts.awaitSpeakCompletion(true);
    await _tts.setSpeechRate(0.52);
    await _tts.setVolume(1);
    try {
      await _tts.setLanguage('en-US');
    } catch (_) {}
  }

  void say(String text, {String? who, String? callsign}) {
    if (!enabled || text.trim().isEmpty) return;
    if (_queue.length > 4) _queue.removeAt(0);   // never fall minutes behind the radio
    _queue.add((text: text, who: who, callsign: callsign));
    unawaited(_pump());
  }

  /// The player is transmitting: stop talking over them.
  Future<void> hold(bool on) async {
    _held = on;
    if (on) await _tts.stop();
    if (!on) unawaited(_pump());
  }

  Future<void> stop() async {
    _queue.clear();
    await _tts.stop();
  }

  Future<void> _pump() async {
    if (_busy) return;
    _busy = true;
    try {
      while (_queue.isNotEmpty && enabled && !_held) {
        final l = _queue.removeAt(0);
        final h = (l.callsign ?? l.who ?? '').codeUnits.fold<int>(7, (a, c) => (a * 31 + c) & 0xffff);
        final atc = l.who == 'ATC' || l.who == 'AI';
        await _tts.setPitch(atc ? 0.92 : 0.8 + (h % 9) * 0.06);
        Sfx.I.pilotLine(true);
        try {
          await _tts.speak(l.text);
        } finally {
          Sfx.I.pilotLine(false);
        }
      }
    } catch (_) {
      // no speech engine on this phone: the radio log still shows every line
    } finally {
      _busy = false;
    }
  }
}

/// The tutorial's narrator: recorded lines (assets/learn, made for the web course with ElevenLabs), one at a time,
/// never over the radio: a line waits for the pilots to be quiet and stops when one starts.
class Narrator {
  Narrator(this.radio);
  final RadioVoice radio;
  final AudioPlayer _voice = AudioPlayer(playerId: 'narrator');
  final AudioPlayer _sfx = AudioPlayer(playerId: 'sfx');
  final List<String> _queue = [];
  bool _busy = false, _playing = false;
  bool enabled = true;
  int _gen = 0;

  /// A line is being read (the airfield steps back under it).
  bool get speaking => _playing;

  void say(List<String> ids) {
    if (!enabled || ids.isEmpty) return;
    _queue
      ..clear()
      ..addAll(ids);
    unawaited(_pump(++_gen));
  }

  void sfx(String name) {
    if (!enabled) return;
    unawaited(_sfx.play(AssetSource('learn/sfx-$name.mp3'), volume: 0.5).catchError((_) {}));
  }

  Future<void> hush() async {
    _gen++;
    _playing = false;
    _queue.clear();
    await _voice.stop();
  }

  Future<void> _pump(int gen) async {
    if (_busy) {
      await _voice.stop();
    }
    _busy = true;
    try {
      while (_queue.isNotEmpty && gen == _gen) {
        final id = _queue.removeAt(0);
        // wait for 0.7 s of radio silence
        var quiet = 0;
        while (quiet < 700) {
          await Future<void>.delayed(const Duration(milliseconds: 120));
          if (gen != _gen) return;
          quiet = radio.speaking ? 0 : quiet + 120;
        }
        final done = Completer<void>();
        final sub = _voice.onPlayerComplete.listen((_) => done.isCompleted ? null : done.complete());
        try {
          await _voice.play(AssetSource('learn/$id.mp3'));
          _playing = true;
        } catch (_) {
          await sub.cancel();
          continue;   // no recording for this line: the card has the words
        }
        // the radio comes first: a pilot starting to talk cuts the narrator
        while (!done.isCompleted && gen == _gen) {
          await Future.any([done.future, Future<void>.delayed(const Duration(milliseconds: 120))]);
          if (radio.speaking) {
            await _voice.stop();
            break;
          }
        }
        await sub.cancel();
        _playing = false;
      }
    } finally {
      if (gen == _gen) _playing = false;
      if (gen == _gen) _busy = false;
    }
  }

  Future<void> dispose() async {
    _gen++;
    await _voice.dispose();
    await _sfx.dispose();
  }
}
