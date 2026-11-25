// Renders the landing at a few chapters to PNGs (a look without a phone): RENDER=1 flutter test test/render
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/game/game_controller.dart';
import 'package:openatc/src/ui/landing_screen.dart';
import 'package:openatc/src/ui/theme.dart';

Future<void> _font(String family, List<String> files) async {
  final l = FontLoader(family);
  for (final f in files) {
    l.addFont(File(f).readAsBytes().then((b) => b.buffer.asByteData()));
  }
  await l.load();
}

void main() {
  final out = Platform.environment['RENDER'];
  testWidgets('landing chapters', (t) async {
    const m = '/opt/flutter/bin/cache/artifacts/material_fonts';
    await t.runAsync(() async {
      await _font('Roboto', ['$m/Roboto-Regular.ttf', '$m/Roboto-Bold.ttf', '$m/Roboto-Medium.ttf', '$m/Roboto-Black.ttf']);
      await _font('monospace', ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf']);
      await _font('DMSans', ['assets/fonts/DMSans-Bold.ttf', 'assets/fonts/DMSans-ExtraBold.ttf', 'assets/fonts/DMSans-Medium.ttf', 'assets/fonts/DMSans-Regular.ttf', 'assets/fonts/DMSans-SemiBold.ttf']);
      await _font('DMMono', ['assets/fonts/DMMono-Medium.ttf', 'assets/fonts/DMMono-Regular.ttf']);
      await _font('MaterialIcons', ['$m/MaterialIcons-Regular.otf']);
    });
    t.view.physicalSize = const Size(390 * 2, 844 * 2);
    t.view.devicePixelRatio = 2;
    for (final f in [6, 170, 240, 312, 412, 466]) {
      final key = GlobalKey();
      await t.pumpWidget(RepaintBoundary(
        key: key,
        child: MaterialApp(
          theme: atcTheme().copyWith(textTheme: atcTheme().textTheme.apply(fontFamily: 'Roboto')),
          debugShowCheckedModeBanner: false,
          home: LandingScreen(key: ValueKey(f), startFrame: f, config: const ShiftConfig(), speechInstalled: false, speechLabel: 'x', onStart: (_) {}, onSpeechModel: () {}, onLearn: () {}),
        ),
      ));
      for (var i = 0; i < 30; i++) {
        await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 60)));
        await t.pump(const Duration(milliseconds: 16));
      }
      final img = await t.runAsync(() async {
        final b = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final im = await b.toImage(pixelRatio: 1);
        return (await im.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      });
      File('$out/landing-$f.png').writeAsBytesSync(img!);
    }
  }, skip: out == null);
}
