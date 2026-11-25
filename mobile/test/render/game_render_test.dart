// Plays the game and the tutorial on the host and photographs each screen (the Mapbox map is a stand-in: it needs a
// GPU), collecting layout errors: RENDER=/dir LIBQUICKJSC_TEST_PATH=... flutter test test/render/game_render_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openatc/src/game/course_screen.dart';
import 'package:openatc/src/game/fleet.dart';
import 'package:openatc/src/game/game_controller.dart';
import 'package:openatc/src/game/game_screen.dart';
import 'package:openatc/src/ui/theme.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> _font(String family, List<String> files) async {
  final l = FontLoader(family);
  for (final f in files) {
    l.addFont(File(f).readAsBytes().then((b) => b.buffer.asByteData()));
  }
  await l.load();
}

void main() {
  final out = Platform.environment['RENDER'];
  final errors = <String>[];
  testWidgets('play a shift', (t) async {
    const m = '/opt/flutter/bin/cache/artifacts/material_fonts';
    final msg = t.binding.defaultBinaryMessenger;
    for (final ch in ['flutter_tts', 'xyz.luan/audioplayers', 'xyz.luan/audioplayers.global', 'plugins.flutter.io/path_provider', 'com.llfbandit.record/messages', 'xyz.luan/audioplayers.global/events', 'xyz.luan/audioplayers/events/sfx', 'xyz.luan/audioplayers/events/narrator']) {
      msg.setMockMethodCallHandler(MethodChannel(ch), (c) async => c.method.contains('Directory') ? Directory.systemTemp.path : null);
    }
    SharedPreferences.setMockInitialValues({});
    final old = FlutterError.onError;
    FlutterError.onError = (d) {
      errors.add(d.exceptionAsString().split('\n').first);
      if (!d.exceptionAsString().contains('overflowed')) old?.call(d);   // shown as itself, not as this override
    };
    await t.runAsync(() async {
      await _font('Roboto', ['$m/Roboto-Regular.ttf', '$m/Roboto-Bold.ttf', '$m/Roboto-Medium.ttf', '$m/Roboto-Black.ttf']);
      await _font('monospace', ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf']);
      await _font('DMSans', ['assets/fonts/DMSans-Regular.ttf', 'assets/fonts/DMSans-Medium.ttf', 'assets/fonts/DMSans-SemiBold.ttf', 'assets/fonts/DMSans-Bold.ttf', 'assets/fonts/DMSans-ExtraBold.ttf']);
      await _font('DMMono', ['assets/fonts/DMMono-Regular.ttf', 'assets/fonts/DMMono-Medium.ttf']);
      await _font('MaterialIcons', ['$m/MaterialIcons-Regular.otf']);
    });
    // a Samsung Galaxy S2x in logical pixels
    t.view.physicalSize = const Size(360 * 3, 780 * 3);
    t.view.devicePixelRatio = 3;
    final fleet = Fleet.fromJson(<String, dynamic>{'pairs': <String, dynamic>{}, 'types': {'B738': 'x.glb'}, 'len': <String, dynamic>{}});
    final theme = atcTheme();
    final key = GlobalKey();
    const map = ColoredBox(color: Color(0xFF1B2330), child: Center(child: Text('MAP', style: TextStyle(color: Color(0x33FFFFFF), fontSize: 40))));

    Future<void> shot(String name) async {
      for (var i = 0; i < 6; i++) {
        await t.pump(const Duration(milliseconds: 100));
      }
      final img = await t.runAsync(() async {
        final b = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final im = await b.toImage(pixelRatio: 1.5);
        return (await im.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      });
      File('$out/$name.png').writeAsBytesSync(img!);
    }

    // ── a shift in the tower ──
    final g = GameController(config: const ShiftConfig(voices: false));
    await t.runAsync(() => g.start());
    await t.runAsync(() => g.debugStopLoop());
    expect(g.loadError, isNull);
    await t.pumpWidget(RepaintBoundary(key: key, child: MaterialApp(theme: theme, debugShowCheckedModeBanner: false, home: GameScreen(game: g, fleet: fleet, onLeave: () {}, onSpeechModel: () {}, mapOverride: map))));
    await t.runAsync(() async => g.debugAdvance(150));
    await shot('g1-board');
    // tap the first departure in view on the board, else the first arrival (the strip scrolls sideways, most urgent first)
    final dep = [...g.ui!.departures, ...g.ui!.arrivals].firstWhere((r) => find.text(r.callsign).hitTestable().evaluate().isNotEmpty);
    await t.tap(find.text(dep.callsign).hitTestable().first);
    await t.runAsync(() async => g.debugAdvance(1));
    await shot('g2-card');
    // send the suggested call
    final send = find.text('Send');
    if (send.evaluate().isNotEmpty) {
      await t.tap(send.first);
      await t.runAsync(() async => g.debugAdvance(6));
    }
    await shot('g3-sent');
    // the whole card, pulled up in the dock; a swipe moves to the next flight, the radio stays below
    if (find.byTooltip('Full card').evaluate().isNotEmpty) {
      final before = g.ui!.card?.id;
      await t.tap(find.byTooltip('Full card'));
      await t.pumpAndSettle();
      await shot('g3b-expanded');
      expect(find.byTooltip('Type a call'), findsOneWidget);   // the radio bar is still there
      final pv = t.widget<PageView>(find.byType(PageView));
      final last = (pv.childrenDelegate as SliverChildBuilderDelegate).childCount! - 1;
      // ignore: avoid_print
      print('pages ${last + 1}, on ${pv.controller!.page}');
      await t.fling(find.byType(PageView), Offset(pv.controller!.page!.round() >= last ? 300 : -300, 0), 1200);
      await t.pumpAndSettle();

      await t.runAsync(() async => g.debugAdvance(1));
      await t.pump();
      await shot('g3c-swiped');
      // ignore: avoid_print
      print('swipe: $before -> ${g.ui!.card?.id}');
      expect(g.ui!.card?.id, isNot(before));
      await t.tap(find.byTooltip('Smaller').first);
      await t.pumpAndSettle();
    }
    // the menu
    await t.tap(find.byTooltip('Menu'));
    await shot('g4-menu');
    // the runways in use, from the menu: an end flipped, then back into the wind
    await t.tap(find.text('Runways in use'));
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await t.pumpAndSettle();
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await shot('g4b-runways');
    expect(find.text('Into the wind'), findsOneWidget);
    await t.tapAt(const Offset(180, 20));
    await t.pumpAndSettle();
    // a call to an aircraft that is not there: what is wrong, in words
    await t.runAsync(() => g.type('UAL9999 runway 99 cleared to land'));
    await t.pump();
    await shot('g4c-fault');
    expect(g.lastCall!.outcome.faults, isNotEmpty);
    expect(find.text(g.lastCall!.outcome.faults.first.title), findsOneWidget);
    // names switched in the middle of a shift: the map's labels come again
    final v = g.airportVersion, refs = ((g.airport!['stands'] as Map)['features'] as List).length;
    g.setNaming('simple');
    await t.runAsync(() async => g.debugAdvance(1));
    // (the new names come from the core's isolate: a busy machine takes its time, a lost message never comes)
    final named = Stopwatch()..start();
    while (g.airportVersion <= v && named.elapsedMilliseconds < 20000) {
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    }
    // ignore: avoid_print
    print('names switched after ${named.elapsedMilliseconds} ms');
    expect(g.airportVersion, greaterThan(v));
    expect(((g.airport!['stands'] as Map)['features'] as List).length, refs);
    g.setNaming('auto');
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 800)));
    // the keyboard
    await t.tap(find.byTooltip('Type a call'));
    await shot('g5-type');
    await t.tapAt(const Offset(180, 40));
    await t.pumpAndSettle();
    // approach seat, a few minutes on
    await t.tap(find.text('Approach').first);
    await t.runAsync(() async => g.debugAdvance(240));
    await shot('g6-approach');
    // a long score beside a raised speed still fits the top bar
    g.setRate(4);
    for (var i = 0; i < 12 && (g.ui!.score?.points ?? 0) > -1000; i++) {
      await t.runAsync(() async => g.debugAdvance(60));
      await t.pump();
    }
    await shot('g7-score');
    // ignore: avoid_print
    print('score ${g.ui!.score?.points} x${g.ui!.rate}');
    g.dispose();

    FlutterError.onError = old;
    // ignore: avoid_print
    print('LAYOUT ERRORS: ${errors.toSet().join(' | ')}');
    expect(errors.where((e) => e.contains('overflowed')), isEmpty);
  }, skip: out == null || Platform.environment['LIBQUICKJSC_TEST_PATH'] == null, timeout: const Timeout(Duration(minutes: 5)));

  testWidgets('play the tutorial', (t) async {
    const m = '/opt/flutter/bin/cache/artifacts/material_fonts';
    final msg = t.binding.defaultBinaryMessenger;
    for (final ch in ['flutter_tts', 'xyz.luan/audioplayers', 'xyz.luan/audioplayers.global', 'plugins.flutter.io/path_provider', 'com.llfbandit.record/messages', 'xyz.luan/audioplayers.global/events', 'xyz.luan/audioplayers/events/sfx', 'xyz.luan/audioplayers/events/narrator']) {
      msg.setMockMethodCallHandler(MethodChannel(ch), (c) async => c.method.contains('Directory') ? Directory.systemTemp.path : null);
    }
    SharedPreferences.setMockInitialValues({});
    final old = FlutterError.onError;
    FlutterError.onError = (d) {
      errors.add(d.exceptionAsString().split('\n').first);
      if (!d.exceptionAsString().contains('overflowed')) old?.call(d);   // shown as itself, not as this override
    };
    await t.runAsync(() async {
      await _font('Roboto', ['$m/Roboto-Regular.ttf', '$m/Roboto-Bold.ttf', '$m/Roboto-Medium.ttf', '$m/Roboto-Black.ttf']);
      await _font('monospace', ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf']);
      await _font('DMSans', ['assets/fonts/DMSans-Regular.ttf', 'assets/fonts/DMSans-Medium.ttf', 'assets/fonts/DMSans-SemiBold.ttf', 'assets/fonts/DMSans-Bold.ttf', 'assets/fonts/DMSans-ExtraBold.ttf']);
      await _font('DMMono', ['assets/fonts/DMMono-Regular.ttf', 'assets/fonts/DMMono-Medium.ttf']);
      await _font('MaterialIcons', ['$m/MaterialIcons-Regular.otf']);
    });
    // a Samsung Galaxy S2x in logical pixels
    t.view.physicalSize = const Size(360 * 3, 780 * 3);
    t.view.devicePixelRatio = 3;
    final fleet = Fleet.fromJson(<String, dynamic>{'pairs': <String, dynamic>{}, 'types': {'B738': 'x.glb'}, 'len': <String, dynamic>{}});
    final theme = atcTheme();
    final key = GlobalKey();
    const map = ColoredBox(color: Color(0xFF1B2330), child: Center(child: Text('MAP', style: TextStyle(color: Color(0x33FFFFFF), fontSize: 40))));

    Future<void> shot(String name) async {
      for (var i = 0; i < 6; i++) {
        await t.pump(const Duration(milliseconds: 100));
      }
      final img = await t.runAsync(() async {
        final b = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        final im = await b.toImage(pixelRatio: 1.5);
        return (await im.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
      });
      File('$out/$name.png').writeAsBytesSync(img!);
    }

    // ── the tutorial ──
    final c = GameController(config: const ShiftConfig(voices: false), course: true);
    await t.runAsync(() => c.start());
    await t.runAsync(() => c.debugStopLoop());
    await t.pumpWidget(RepaintBoundary(key: key, child: MaterialApp(theme: theme, debugShowCheckedModeBanner: false, home: CourseScreen(key: const ValueKey('course'), game: c, fleet: fleet, onExit: () {}, onPlay: () {}, mapOverride: map))));
    await t.runAsync(() async => c.debugAdvance(1));
    await t.pump(const Duration(seconds: 4));
    await shot('c1-welcome');
    for (final want in ['words', 'controls', 'm-push', 'finish']) {
      for (var k = 0; k < 40 && (c.courseState!['step'] as Map)['id'] != want; k++) {
        c.courseNext();
        await t.runAsync(() async => c.debugAdvance(1));
      }
      await t.runAsync(() async => c.debugAdvance(3));
      await t.pump(const Duration(seconds: 5));
      await shot('c-$want');
    }
    c.dispose();
    FlutterError.onError = old;
    // ignore: avoid_print
    print('LAYOUT ERRORS: ${errors.toSet().join(' | ')}');
    expect(errors.where((e) => e.contains('overflowed')), isEmpty);
  }, skip: out == null || Platform.environment['LIBQUICKJSC_TEST_PATH'] == null, timeout: const Timeout(Duration(minutes: 5)));
}
