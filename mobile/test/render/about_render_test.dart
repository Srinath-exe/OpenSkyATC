// The About screen: RENDER=/dir flutter test test/render/about_render_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/ui/about_screen.dart';
import 'package:openatc/src/ui/theme.dart';

void main() {
  final out = Platform.environment['RENDER'];
  testWidgets('about screen fits and lists the legal pages and credits', (t) async {
    t.view.physicalSize = const Size(360 * 2, 780 * 2);
    t.view.devicePixelRatio = 2;
    final key = GlobalKey();
    await t.pumpWidget(RepaintBoundary(key: key, child: MaterialApp(theme: atcTheme(), debugShowCheckedModeBanner: false, home: const AboutScreen(version: '9.9.9'))));
    await t.pump();
    expect(find.text('Privacy'), findsOneWidget);
    expect(find.text('Version 9.9.9'), findsOneWidget);
    Future<void> shot(String name) async {
      if (out == null) return;
      final img = await t.runAsync(() async {
        final im = await (key.currentContext!.findRenderObject()! as RenderRepaintBoundary).toImage(pixelRatio: 1);
        return (await im.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      });
      File('$out/$name.png').writeAsBytesSync(img!);
    }
    await shot('about');
    await t.scrollUntilVisible(find.text('Flutter and package licences'), 400);
    expect(tester(t), isNull);
    await shot('about2');
  });
}

Object? tester(WidgetTester t) => t.takeException();
