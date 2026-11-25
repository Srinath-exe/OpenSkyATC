// Model updates pushed to phones: the same list the website reads (model-updates.json, written by
// scripts/model-release.mjs). Checked when the app opens and every six hours; the player is asked, never forced, and what
// is on the phone keeps working until the new files are in and their hashes match. Files come only from the list's own
// site: entries are folders under /models, never addresses.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../s1/s1_worker.dart';
import 'downloader.dart';
import 'manifest.dart';

const String kModelOrigin = String.fromEnvironment('MODEL_ORIGIN', defaultValue: 'https://openatc.aeon-labs.site');

/// One model as published.
class ModelRelease {
  ModelRelease._(this.id, this.version, this.aliases, this.title, this.notes, this.dir, this.spec);
  final String id, version, title, dir;
  final List<String> aliases, notes;

  /// What to download: the speech model's spec, or the command model's files as one.
  final ModelSpec spec;
  int get bytes => spec.totalBytes;
  bool same(String? v) => v != null && (v == version || aliases.contains(v));

  static final _dir = RegExp(r'^/models/[\w./-]+$'), _name = RegExp(r'^\w[\w.-]*$'), _hash = RegExp(r'^[0-9a-f]{64}$');

  /// Null when this app cannot use it (a newer kind of model: it needs an app update) or it is malformed.
  static ModelRelease? parse(String id, Map<String, dynamic> j, String origin) {
    try {
      final dir = j['dir'] as String, version = j['version'] as String;
      if (!_dir.hasMatch(dir) || dir.contains('..') || version.isEmpty) return null;
      final files = [
        for (final f in (j['files'] as List).cast<Map<String, dynamic>>())
          ModelFile(role: (f['role'] as String?) ?? f['name'] as String, name: f['name'] as String, url: '$origin$dir/${f['name']}', sha256: f['sha256'] as String, size: f['size'] as int),
      ];
      if (files.isEmpty || files.any((f) => !_name.hasMatch(f.name) || !_hash.hasMatch(f.sha256) || f.size <= 0 || f.size > 600 << 20)) return null;
      final ModelSpec spec;
      if (id == 's1') {
        if (!['model.json', 'model.bin', 'gate.json'].every((n) => files.any((f) => f.name == n))) return null;   // never without its safety gate
        spec = ModelSpec(id: 's1', name: j['title'] as String, version: version, kind: ModelKind.nemoTransducer, files: files);
      } else {
        final p = j['phone'] as Map<String, dynamic>;
        spec = ModelSpec.fromJson({...p, 'version': version, 'files': [for (final f in files) {...f.toJson(), 'url': f.url.replaceFirst('http://127.0.0.1', 'https://127.0.0.1')}]});
      }
      final usable = id == 's1' ? spec : ModelSpec(id: spec.id, name: spec.name, version: version, kind: spec.kind, files: files, license: spec.license, source: spec.source, sampleRate: spec.sampleRate, hotwords: spec.hotwords, modelType: spec.modelType, notes: spec.notes);
      return ModelRelease._(id, version, ((j['aliases'] as List?) ?? const []).cast<String>(), j['title'] as String, ((j['notes'] as List?) ?? const []).cast<String>().take(6).toList(), dir, usable);
    } catch (_) {
      return null;
    }
  }
}

class ModelUpdates extends ChangeNotifier {
  ModelUpdates({required this.downloader, required this.bundled, this.origin = kModelOrigin, HttpClient? client}) : _client = client ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));
  final ModelDownloader downloader;

  /// The speech model this app was built with (offered when nothing newer is published).
  final ModelSpec bundled;
  final String origin;
  final HttpClient _client;

  /// The speech model on this phone, whatever its version: it is used until a newer one is in.
  ModelSpec? speech;
  String _commandVersion = '', _bundledCommandUrl = '', _bundledCommand = '';
  Directory? _commandDir;
  final Map<String, ModelRelease> releases = {};
  DateTime _checked = DateTime(0);

  /// The running update: which, and how far (null when none).
  ModelRelease? running;
  DownloadProgress? progress;
  String? error;

  Future<void> load() async {
    speech = await downloader.isInstalled(bundled) ? bundled : await _installedSpeech();
    try {
      final j = jsonDecode(await rootBundle.loadString('assets/s1/version.json')) as Map<String, dynamic>;
      _bundledCommand = _commandVersion = j['version'] as String;
      _bundledCommandUrl = j['url'] as String;
    } catch (_) {/* no command model in this build: the rules alone */}
    final own = await _marker(Directory('${downloader.root.path}/s1'));
    if (own != null) {
      _commandDir = own.$1;
      _commandVersion = own.$2['version'] as String;
    }
    notifyListeners();
  }

  /// The newest complete model directory under [dir] (each holds its marker).
  Future<(Directory, Map<String, dynamic>)?> _marker(Directory dir) async {
    if (!await dir.exists()) return null;
    (Directory, Map<String, dynamic>)? best;
    await for (final d in dir.list()) {
      if (d is! Directory) continue;
      try {
        final j = jsonDecode(await File('${d.path}/.installed.json').readAsString()) as Map<String, dynamic>;
        final files = ((j['spec'] as Map)['files'] as List).cast<Map<String, dynamic>>();
        var whole = files.isNotEmpty;
        for (final f in files) {
          final x = File('${d.path}/${f['name']}');
          if (!await x.exists() || await x.length() != f['size']) whole = false;
        }
        if (whole && (best == null || '${j['installedAt']}'.compareTo('${best.$2['installedAt']}') > 0)) best = (d, j);
      } catch (_) {/* not a finished download */}
    }
    return best;
  }

  Future<ModelSpec?> _installedSpeech() async {
    if (!await downloader.root.exists()) return null;
    (Directory, Map<String, dynamic>)? best;
    await for (final id in downloader.root.list()) {
      if (id is! Directory || id.path.endsWith('/s1')) continue;
      final m = await _marker(id);
      if (m != null && (best == null || '${m.$2['installedAt']}'.compareTo('${best.$2['installedAt']}') > 0)) best = m;
    }
    try {
      if (best == null) return null;
      final j = best.$2['spec'] as Map<String, dynamic>;
      // (installed: where the files came from no longer matters, only what they are)
      return ModelSpec.fromJson({...j, 'files': [for (final f in (j['files'] as List).cast<Map<String, dynamic>>()) {...f, 'url': 'https://installed/${f['name']}'}]});
    } catch (_) {
      return null;
    }
  }

  /// What a phone with no speech model downloads: the published one, else the one this app was built with.
  ModelSpec get speechToGet => releases['stt']?.spec ?? bundled;

  Future<void> check({bool force = false}) async {
    if (!force && DateTime.now().difference(_checked) < const Duration(hours: 6)) return;
    _checked = DateTime.now();
    try {
      final q = await _client.getUrl(Uri.parse('$origin/model-updates.json')).timeout(const Duration(seconds: 8));
      q.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
      final r = await q.close().timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) {
        await r.drain<void>();
        return;
      }
      final text = await r.transform(utf8.decoder).join().timeout(const Duration(seconds: 8));
      if (text.length > 200000) return;
      final j = jsonDecode(text) as Map<String, dynamic>;
      if (j['schema'] != 1) return;
      releases.clear();
      for (final e in (j['models'] as Map<String, dynamic>).entries) {
        final m = ModelRelease.parse(e.key, e.value as Map<String, dynamic>, origin);
        if (m != null) releases[e.key] = m;
      }
      notifyListeners();
    } catch (_) {
      _checked = DateTime(0);   // offline: ask another time
    }
  }

  /// Newer models than the ones on this phone (the speech model only when there is one to update).
  List<ModelRelease> get due => [
        if (releases['stt'] case final r? when speech != null && !(r.same(speech!.version) && r.spec.id == speech!.id)) r,
        if (releases['s1'] case final r? when _commandVersion.isNotEmpty && !r.same(_commandVersion)) r,
      ];

  static const _snoozeKey = 'openatc_model_snooze_v1';
  Future<List<ModelRelease>> toAsk() async {
    final p = await SharedPreferences.getInstance();
    final m = jsonDecode(p.getString(_snoozeKey) ?? '{}') as Map<String, dynamic>, now = DateTime.now().millisecondsSinceEpoch;
    return [for (final r in due) if (((m['${r.id}@${r.version}'] as int?) ?? 0) case final t when t >= 0 && t < now) r];
  }

  Future<void> snooze(List<ModelRelease> list, {bool forever = false}) async {
    final p = await SharedPreferences.getInstance();
    final m = jsonDecode(p.getString(_snoozeKey) ?? '{}') as Map<String, dynamic>;
    for (final r in list) {
      m['${r.id}@${r.version}'] = forever ? -1 : DateTime.now().add(const Duration(hours: 24)).millisecondsSinceEpoch;
    }
    await p.setString(_snoozeKey, jsonEncode(m));
  }

  /// Download and verify each; what was there is removed only afterwards. True when all are in.
  Future<bool> install(List<ModelRelease> list) async {
    if (running != null) return false;
    error = null;
    try {
      for (final r in list) {
        running = r;
        progress = null;
        notifyListeners();
        final dir = await downloader.install(r.spec, onProgress: (p) {
          progress = p;
          notifyListeners();
        });
        if (r.id == 's1') {
          _commandDir = dir;
          _commandVersion = r.version;
        } else {
          final old = speech;
          speech = r.spec;
          if (old != null && old.id != r.spec.id) {
            try {
              await downloader.dirFor(old).parent.delete(recursive: true);
            } catch (_) {/* in use: the next start clears it */}
          }
        }
      }
      return true;
    } catch (e) {
      error = e is DownloadCancelled ? null : '$e';
      return false;
    } finally {
      running = null;
      progress = null;
      notifyListeners();
    }
  }

  /// The command model to run: the updated one, else the bundled one. Null: the rules alone.
  Future<S1Files?> commandModel() async {
    final d = _commandDir;
    if (d != null) {
      try {
        return S1Files(url: '/models/s1/$_commandVersion', meta: await File('${d.path}/model.json').readAsString(), bin: await File('${d.path}/model.bin').readAsBytes(), gate: await File('${d.path}/gate.json').readAsString());
      } catch (_) {/* damaged: the bundled one */}
    }
    if (_bundledCommand.isEmpty) return null;
    try {
      final b = await rootBundle.load('assets/s1/model.bin');
      return S1Files(url: _bundledCommandUrl, meta: await rootBundle.loadString('assets/s1/model.json'), bin: b.buffer.asUint8List(b.offsetInBytes, b.lengthInBytes), gate: await rootBundle.loadString('assets/s1/gate.json'));
    } catch (_) {
      return null;
    }
  }
}
