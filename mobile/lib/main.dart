// OpenATC for phones, native: the web game's simulation, parser and AI run in an embedded JS engine (mobile/core ->
// assets/core/core.js); the map is Mapbox with the 3D fleet as GLB models; the UI is Flutter, in portrait; speech is
// recognised on the phone (sherpa-onnx) and the pilots answer through the phone's text-to-speech.
//
//   LandingScreen   the film, your shift (seat, traffic, light), the speech model, Start
//   ModelScreen     download the pinned speech model (progress, resume, SHA-256); skippable (typed calls)
//   GameScreen      the map, the flight board / card, hold-to-talk
//
// Build-time settings: --dart-define=MAPBOX_TOKEN=pk... (required for the map), APP_VERSION.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart';
import 'package:path_provider/path_provider.dart';

import 'src/audio/sfx.dart';
import 'src/game/course_screen.dart';
import 'src/game/fleet.dart';
import 'src/game/game_controller.dart';
import 'src/game/game_screen.dart';
import 'src/models/downloader.dart';
import 'src/models/manifest.dart';
import 'src/models/updates.dart';
import 'src/ui/landing_screen.dart';
import 'src/ui/model_screen.dart';
import 'src/ui/model_update_sheet.dart';
import 'src/ui/theme.dart';

const String kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: '2.0.0');
const String kMapboxToken = String.fromEnvironment('MAPBOX_TOKEN');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  MapboxOptions.setAccessToken(kMapboxToken);
  final manifest = ModelManifest.parse(await rootBundle.loadString('assets/stt_models.json'));
  final support = await getApplicationSupportDirectory();
  final downloader = ModelDownloader(root: Directory('${support.path}/models'));
  final updates = ModelUpdates(downloader: downloader, bundled: manifest.activeModel);
  await updates.load();
  final fleet = await Fleet.load();
  final config = await ShiftConfig.load();
  // the sounds load while the first screen is up
  Sfx.I.bed(Bed.home);
  Sfx.I.init();
  runApp(OpenAtcApp(updates: updates, downloader: downloader, fleet: fleet, config: config));
}

class OpenAtcApp extends StatelessWidget {
  const OpenAtcApp({super.key, required this.updates, required this.downloader, required this.fleet, required this.config});
  final ModelUpdates updates;
  final ModelDownloader downloader;
  final Fleet fleet;
  final ShiftConfig config;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'OpenATC',
      debugShowCheckedModeBanner: false,
      theme: atcTheme(),
      builder: (context, child) => TapSounds(child: child!),   // every button clicks
      home: _Flow(updates: updates, downloader: downloader, fleet: fleet, config: config),
    );
  }
}

enum _Page { landing, model, game, course }

class _Flow extends StatefulWidget {
  const _Flow({required this.updates, required this.downloader, required this.fleet, required this.config});
  final ModelUpdates updates;
  final ModelDownloader downloader;
  final Fleet fleet;
  final ShiftConfig config;

  @override
  State<_Flow> createState() => _FlowState();
}

class _FlowState extends State<_Flow> with WidgetsBindingObserver {
  _Page _page = _Page.landing;
  late ShiftConfig _cfg = widget.config;
  bool get _installed => widget.updates.speech != null;
  bool _skipped = false;
  GameController? _game;

  /// Where the model screen goes back to (the landing, or the game it was opened from).
  _Page _after = _Page.landing;

  /// The speech model on the phone (any version: an update never leaves the player without one), else the one to get.
  ModelSpec get _spec => widget.updates.speech ?? widget.updates.speechToGet;

  @override
  void initState() {
    super.initState();
    widget.updates.addListener(_models);
    WidgetsBinding.instance.addObserver(this);
    _checkModels();
  }

  void _models() => mounted ? setState(() {}) : null;

  /// Newer models published: ask, on the first screen only.
  Future<void> _checkModels() async {
    await widget.updates.check();
    final ask = await widget.updates.toAsk();
    if (!mounted || ask.isEmpty || _page != _Page.landing || _asking) return;
    _asking = true;
    await showModelUpdate(context, widget.updates, ask);
    _asking = false;
  }

  bool _asking = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _checkModels();
  }

  /// From the menu: the update when there is one, else the model's own page.
  void _speechModel(_Page after) {
    final due = widget.updates.due;
    if (due.isNotEmpty && _installed) {
      showModelUpdate(context, widget.updates, due);
      return;
    }
    setState(() {
      _after = after;
      _page = _Page.model;
    });
  }

  void _start(ShiftConfig cfg) {
    Sfx.I.ui('start');
    _cfg = cfg;
    cfg.save();
    if (!_installed && !_skipped) {
      _after = _Page.game;
      setState(() => _page = _Page.model);
      return;
    }
    _openGame();
  }

  void _openGame({bool course = false}) {
    _game?.dispose();
    final g = _game = GameController(config: _cfg, course: course, commandModel: widget.updates.commandModel, speechSpec: _installed ? _spec : null, speechDir: _installed ? widget.downloader.dirFor(_spec).path : null);
    g.start();
    setState(() => _page = course ? _Page.course : _Page.game);
  }

  void _leave() {
    _game?.dispose();
    _game = null;
    setState(() => _page = _Page.landing);
    _checkModels();
  }

  /// Back from the model screen: to the shift or course it was opened from, else the landing.
  void _backFromModel() => setState(() => _page = _after == _Page.game && _game != null ? (_game!.course ? _Page.course : _Page.game) : _Page.landing);

  /// Android back in a shift or the course: ask before leaving the tower (it used to close the app).
  Future<void> _confirmLeave() async {
    final course = _page == _Page.course;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(course ? 'Leave the tutorial?' : 'Leave the tower?'),
        content: Text(course ? 'You can pick it up again from the same step.' : 'This shift ends. Your best score is kept.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Stay')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Leave')),
        ],
      ),
    );
    if (ok == true && mounted) _leave();
  }

  @override
  void dispose() {
    widget.updates.removeListener(_models);
    WidgetsBinding.instance.removeObserver(this);
    _game?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 350),
      child: switch (_page) {
        _Page.landing => LandingScreen(
            key: const ValueKey('landing'),
            config: _cfg,
            speechInstalled: _installed,
            speechLabel: _spec.name,
            onStart: _start,
            onLearn: () {
              Sfx.I.ui('start');
              _openGame(course: true);
            },
            onSpeechModel: () => _speechModel(_Page.landing),
          ),
        _Page.model => PopScope(
            canPop: false,
            onPopInvokedWithResult: (didPop, _) => didPop ? null : _backFromModel(),
            child: ModelScreen(
              key: const ValueKey('model'),
              spec: _spec,
              downloader: widget.downloader,
              installed: _installed,
              onBack: _backFromModel,
              onInstalled: () {
                Sfx.I.ui('done');
                widget.updates.load();
                widget.updates.speech ??= widget.updates.speechToGet;
                setState(() {});
                final g = _game;
                if (g != null) {
                  // the shift (or course) goes on; its voice loads now
                  g.loadVoice(_spec, widget.downloader.dirFor(_spec).path);
                  _backFromModel();
                } else if (_after == _Page.game) {
                  _openGame();
                } else {
                  setState(() => _page = _Page.landing);
                }
              },
              onSkip: () {
                _skipped = true;
                if (_after == _Page.game && _game == null) {
                  _openGame();
                } else {
                  _backFromModel();
                }
              },
            ),
          ),
        _Page.course => PopScope(
            key: const ValueKey('course'),
            canPop: false,
            onPopInvokedWithResult: (didPop, _) => didPop ? null : _confirmLeave(),
            child: CourseScreen(
              game: _game!,
              fleet: widget.fleet,
              onExit: _leave,
              onPlay: () => _openGame(),
              onSpeechModel: () => _speechModel(_Page.game),
            ),
          ),
        _Page.game => PopScope(
            key: const ValueKey('game'),
            canPop: false,
            onPopInvokedWithResult: (didPop, _) => didPop ? null : _confirmLeave(),
            child: GameScreen(
              game: _game!,
              fleet: widget.fleet,
              onLeave: _leave,
              onSpeechModel: () => _speechModel(_Page.game),
            ),
          ),
      },
    );
  }
}
