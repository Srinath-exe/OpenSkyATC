// The phone's model updates: asked about newer models, the old one in use until the new one is verified, never left without.
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/models/downloader.dart';
import 'package:openatc/src/models/manifest.dart';
import 'package:openatc/src/models/updates.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  late HttpServer server;
  late Directory root;
  late String origin;
  final body = <String, List<int>>{};
  Map<String, Object?> list = {};
  List<int> bytes(String s) => utf8.encode(s * 50);
  Map<String, Object?> file(String dir, String name, String content, {String? role, String? sha}) {
    body['$dir/$name'] = bytes(content);
    return {'name': name, 'role': ?role, 'size': bytes(content).length, 'sha256': sha ?? sha256.convert(bytes(content)).toString()};
  }

  Map<String, Object?> speech(String v, {String? badHash}) {
    final d = '/models/stt/p-$v';
    return {'version': v, 'aliases': <String>[], 'title': 'Speech model', 'notes': ['Hears more accents'], 'dir': d, 'files': [for (final r in ['encoder', 'decoder', 'joiner', 'tokens']) file(d, '$r.onnx', '$r $v', role: r, sha: r == 'joiner' ? badHash : null)], 'phone': {'id': 'p', 'name': 'P', 'kind': 'nemoTransducer', 'sampleRate': 16000, 'hotwords': false}};
  }

  Map<String, Object?> command(String v, {bool gate = true}) {
    final d = '/models/s1/$v';
    return {'version': v, 'aliases': <String>[], 'title': 'Command model', 'notes': ['x'], 'dir': d, 'files': [for (final n in ['model.json', 'model.bin', if (gate) 'gate.json']) file(d, n, '$n $v')]};
  }

  ModelSpec old(String v) => ModelSpec(id: 'p', name: 'P', version: v, kind: ModelKind.nemoTransducer, files: [for (final r in ['encoder', 'decoder', 'joiner', 'tokens']) ModelFile(role: r, name: '$r.onnx', url: '$origin/models/stt/p-$v/$r.onnx', sha256: sha256.convert(bytes('$r $v')).toString(), size: bytes('$r $v').length)]);

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('models');
    server = await HttpServer.bind('127.0.0.1', 0);
    origin = 'http://127.0.0.1:${server.port}';
    server.listen((q) async {
      if (q.uri.path == '/model-updates.json') {
        q.response.write(jsonEncode({'schema': 1, 'models': list}));
      } else if (body[q.uri.path] case final b?) {
        q.response.add(b);
      } else {
        q.response.statusCode = 404;
      }
      await q.response.close();
    });
    speech('v1');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (m) async {
      final k = utf8.decode(m!.buffer.asUint8List(m.offsetInBytes, m.lengthInBytes)), f = File(k);
      return f.existsSync() ? ByteData.sublistView(Uint8List.fromList(f.readAsBytesSync())) : null;
    });
    rootBundle.clear();
  });
  tearDown(() async {
    await server.close(force: true);
    await root.delete(recursive: true);
  });

  ModelDownloader dl() => ModelDownloader(root: root, retries: 0);
  Future<ModelUpdates> open({ModelSpec? bundled}) async {
    final u = ModelUpdates(downloader: dl(), bundled: bundled ?? old('v1'), origin: origin);
    await u.load();
    await u.check(force: true);
    return u;
  }

  final shipped = (jsonDecode(File('assets/s1/version.json').readAsStringSync()) as Map)['version'] as String;

  test('an app that ships a newer version still uses the model already on the phone', () async {
    await dl().install(old('v1'));
    list = {'stt': speech('v2')};
    final u = await open(bundled: old('v2'));
    expect(u.speech?.version, 'v1');   // it used to say there was none, and the player was mute
    expect(u.due.map((r) => r.version), ['v2']);
  });

  test('asked, updated, switched; the old files go only afterwards; not asked again', () async {
    await dl().install(old('v1'));
    list = {'stt': speech('v2'), 's1': command('c9')};
    final u = await open();
    expect((await u.toAsk()).map((r) => '${r.id} ${r.version}'), ['stt v2', 's1 c9']);
    expect(await u.install(u.due), isTrue, reason: u.error);
    expect(u.speech!.version, 'v2');
    expect(File('${dl().dirFor(u.speech!).path}/encoder.onnx').existsSync(), isTrue);
    expect(dl().dirFor(old('v1')).existsSync(), isFalse);
    final c = await u.commandModel();
    expect(c!.url, '/models/s1/c9');
    expect(c.gate, contains('gate.json c9'));
    final again = await open();
    expect(again.speech!.version, 'v2');
    expect(again.due, isEmpty);
  });

  test('a file that does not match its hash is refused and the old model stays', () async {
    await dl().install(old('v1'));
    list = {'stt': speech('v2', badHash: 'a' * 64)};
    final u = await open();
    expect(await u.install(u.due), isFalse);
    expect(u.error, contains('Checksum'));
    expect(u.speech!.version, 'v1');
    expect((await open()).speech!.version, 'v1');
    expect(File('${dl().dirFor(old('v1')).path}/encoder.onnx').existsSync(), isTrue);
  });

  test('nothing on the phone: not asked, and the first download is the newest', () async {
    list = {'stt': speech('v2'), 's1': {...command(shipped)}};
    final u = await open();
    expect(u.due, isEmpty);
    expect(u.speechToGet.version, 'v2');
    expect((await u.commandModel())!.url, endsWith(shipped));
  });

  test('later is a day, skip is that version only', () async {
    await dl().install(old('v1'));
    list = {'stt': speech('v2')};
    final u = await open();
    await u.snooze(u.due);
    expect(await u.toAsk(), isEmpty);
    expect(u.due, hasLength(1));   // still offered from the menu
    list = {'stt': speech('v3')};
    await u.check(force: true);
    expect(await u.toAsk(), hasLength(1));
    await u.snooze(u.due, forever: true);
    expect(await u.toAsk(), isEmpty);
  });

  test('lists that point elsewhere, a command model without its gate, and unknown kinds are ignored', () async {
    await dl().install(old('v1'));
    for (final bad in [
      {'stt': {...speech('v2'), 'dir': 'https://example.com/models/x'}},
      {'stt': {...speech('v2'), 'dir': '/models/../x'}},
      {'stt': {...speech('v2'), 'phone': {'id': 'p', 'name': 'P', 'kind': 'somethingNew'}}},
      {'s1': command('c9', gate: false)},
      {'s1': {...command('c9'), 'files': [{'name': '../x', 'size': 1, 'sha256': 'a' * 64}]}},
    ]) {
      list = bad;
      expect((await open()).due, isEmpty, reason: '$bad');
    }
  });

  test('offline: no update, no error, the phone keeps what it has', () async {
    await dl().install(old('v1'));
    final u = ModelUpdates(downloader: dl(), bundled: old('v1'), origin: 'http://127.0.0.1:1');
    await u.load();
    await u.check(force: true);
    expect(u.speech!.version, 'v1');
    expect(u.due, isEmpty);
  });
}
