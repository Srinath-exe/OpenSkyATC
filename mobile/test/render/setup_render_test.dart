// The airport choice on the landing's set-up sheet: RENDER=/dir flutter test test/render/setup_render_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/game/airports.dart';
import 'package:openatc/src/ui/theme.dart';

void main() {
  final out = Platform.environment['RENDER'];
  testWidgets('airport grid', (t) async {
    t.view.physicalSize = const Size(360 * 2, 780 * 2);
    t.view.devicePixelRatio = 2;
    final key = GlobalKey();
    var picked = '';
    await t.pumpWidget(RepaintBoundary(
      key: key,
      child: MaterialApp(theme: atcTheme(), debugShowCheckedModeBanner: false, home: Scaffold(body: Padding(padding: const EdgeInsets.all(20), child: AirportGrid(value: 'LFPG', onPick: (i) => picked = i)))),
    ));
    for (var i = 0; i < 12; i++) {
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 60)));
      await t.pump();
    }
    expect(find.text('Singapore'), findsOneWidget);
    await t.tap(find.text('Tokyo'));
    expect(picked, 'RJTT');
    if (out == null) return;
    final img = await t.runAsync(() async {
      final im = await (key.currentContext!.findRenderObject()! as RenderRepaintBoundary).toImage(pixelRatio: 1);
      return (await im.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
    });
    File('$out/setup.png').writeAsBytesSync(img!);
  });
}
