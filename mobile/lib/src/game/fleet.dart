// Which baked GLB an aircraft wears (assets/fleet/map.json, written by mobile/tool/fleet/bake.ts): the airline's
// livery on its type when the app ships it, else the type in plain white, else a stand-in of about the right size.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

class Fleet {
  Fleet._(this._pairs, this._types, this._len);

  final Map<String, String> _pairs;
  final Map<String, String> _types;
  final Map<String, double> _len;

  static Future<Fleet> load([AssetBundle? bundle]) async {
    final j = jsonDecode(await (bundle ?? rootBundle).loadString('assets/fleet/map.json')) as Map<String, dynamic>;
    return Fleet.fromJson(j);
  }

  factory Fleet.fromJson(Map<String, dynamic> j) => Fleet._(
        (j['pairs'] as Map).cast<String, String>(),
        (j['types'] as Map).cast<String, String>(),
        (j['len'] as Map).map((k, v) => MapEntry(k as String, (v as num).toDouble())),
      );

  /// GLB file name for an aircraft type and airline ICAO code.
  String fileFor(String type, String airline, double lengthM) {
    final t = type.toUpperCase();
    return _pairs['$t|$airline'] ?? _types[t] ?? _standIn(lengthM);
  }

  /// The flight card's picture of that aircraft (assets/fleet/thumbs, baked by mobile/tool/fleet/thumbs.mjs).
  String pictureFor(String type, String airline) => 'assets/fleet/thumbs/${fileFor(type, airline, 40).replaceAll('.glb', '.webp')}';

  String _standIn(double lengthM) {
    final t = lengthM < 32 ? 'E175' : lengthM < 45 ? 'B738' : lengthM < 62 ? 'B789' : 'B77W';
    return _types[t] ?? _types.values.first;
  }

  static const _version = 3;   // bump with the fleet bake, so a changed GLB replaces the copy
  Directory? _dir;
  final Map<String, Future<String>> _copies = {};

  /// The GLB on disk (copied from the app's assets the first time it is used).
  Future<String> localFile(String file) => _copies[file] ??= () async {
        final dir = _dir ??= Directory('${(await getApplicationSupportDirectory()).path}/fleet-v$_version');
        final f = File('${dir.path}/$file');
        if (!await f.exists()) {
          await dir.create(recursive: true);
          final data = await rootBundle.load('assets/fleet/$file');
          final tmp = File('${f.path}.part');
          await tmp.writeAsBytes(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes), flush: true);
          await tmp.rename(f.path);
        }
        return f.path;
      }();

  /// The style's model id for a file (one Mapbox model per GLB).
  static String modelId(String file) => file.replaceAll('.glb', '');

  /// Scale that makes the model the aircraft's real length.
  double scaleFor(String file, double lengthM) {
    final l = _len[file];
    return l == null || l <= 0 || lengthM <= 0 ? 1 : lengthM / l;
  }
}
