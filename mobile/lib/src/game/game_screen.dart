// The game, in portrait, at night. One solid bar on top (your seat, score and clock, the menu); the map or the scope
// fills the rest; the flights along the bottom (Rail on the 3D map for the tower seat, strips under the scope for the
// approach seat); the radio bar last: hold to talk, or type. A picked flight's card rises with the call to give first.
//
// Surfaces are solid (the web game's tokens, theme.dart): text on them reads at the same contrast over any map.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../audio/sfx.dart';
import '../core/models.dart';
import '../ui/theme.dart';
import 'airport_map.dart';
import 'fleet.dart';
import 'game_controller.dart';
import 'layouts.dart';
import 'radar_view.dart';
import 'voice.dart';

class GameScreen extends StatefulWidget {
  const GameScreen({super.key, required this.game, required this.fleet, required this.onLeave, required this.onSpeechModel, this.mapOverride});
  final GameController game;
  final Fleet fleet;
  final VoidCallback onLeave;
  final VoidCallback onSpeechModel;

  /// Stands in for the Mapbox map (tests render the screen without a GPU map).
  final Widget? mapOverride;

  @override
  State<GameScreen> createState() => _GameScreenState();
}

/// Height of the top bar under the status bar.
const kTopBarH = 56.0;

class _GameScreenState extends State<GameScreen> {
  final _map = AirportMapController();
  GameController get g => widget.game;

  /// The approach seat works the radar scope; the tower seat the 3D airfield. Either can show the other.
  bool _radar = false;

  /// The picked flight's card pulled up to full height (swipe for the next flight; the radio stays below).
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    g.addListener(_changed);
    _setRadar(g.config.position == 'approach');
  }

  void _setRadar(bool on) {
    _radar = on;
    g.setRadar(on);
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    g.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (g.ui?.card == null) _expanded = false;
    if (mounted) setState(() {});
  }

  void _select(int? id) {
    g.select(id);
    if (id != null && !_radar) _map.follow(id);
  }

  @override
  Widget build(BuildContext context) {
    final u = g.ui;
    final pad = MediaQuery.paddingOf(context);
    final topH = pad.top + kTopBarH;
    final radioH = 112.0 + pad.bottom; // the radio bar: last line + talk / type
    final dockH = 74.0 + radioH; // the flight row and the radio, under the scope
    final alert = u != null && u.alerts.isNotEmpty ? u.alerts.first : null;
    final alertH = alert != null ? 58.0 : 0.0;
    final cardH = MediaQuery.sizeOf(context).height - topH - alertH - dockH - 6; // the card pulled up: all above the row, under the alert
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light.copyWith(statusBarColor: Colors.transparent),
      child: Scaffold(
        backgroundColor: AtcColors.bg,
        resizeToAvoidBottomInset: false,
        body: Stack(
          children: [
            Positioned.fill(
              child: Offstage(
                offstage: _radar,
                child: widget.mapOverride ?? AirportMap(game: g, fleet: widget.fleet, controller: _map, onTapAircraft: _select),
              ),
            ),
            if (_radar && g.radarScene != null)
              Positioned.fill(
                top: topH,
                child: RadarView(scene: g.radarScene!, frame: g.radarFrame, onSelect: (id) => g.select(id), bottomInset: dockH),
              ),
            // the top bar
            Positioned(
              left: 0,
              right: 0,
              top: 0,
              child: _TopBar(
                ui: u,
                position: u?.position ?? g.config.position,
                ai: g.myAi,
                onAi: () => g.setMyAi(!g.myAi),
                onSeat: (p) {
                  HapticFeedback.selectionClick();
                  g.setPosition(p);
                  _setRadar(p == 'approach');
                },
                onMenu: () => _menu(context),
              ),
            ),
            if (alert != null)
              Positioned(
                left: 0,
                right: 0,
                top: topH,
                child: _AlertBar(alert: alert, onTap: () => _selectByCallsign(alert.who.firstOrNull)),
              ),
            // views: 3D airfield, radar, top-down (and resume when paused)
            if (!_expanded)
              Positioned(
                right: 10,
                top: topH + alertH + 10,
                child: _ViewSwitch(
                  radar: _radar,
                  paused: u?.paused == true,
                  on3d: () {
                    Sfx.I.ui('view');
                    _setRadar(false);
                    _map.flyToAirport();
                  },
                  onRadar: () {
                    Sfx.I.ui('view');
                    _setRadar(true);
                  },
                  onTop: () {
                    Sfx.I.ui('view');
                    _setRadar(false);
                    _map.flyTopDown();
                  },
                  onResume: () => g.setPaused(false),
                ),
              ),
            // what was heard / sent: under the top bar, clear of the view switch
            Positioned(
              left: 10,
              right: 68,
              top: topH + alertH + 10,
              child: CallStrip(game: g),
            ),
            // the dock: the picked flight's short card, the flights in a row, the radio. One surface, bottom to the edge.
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: _Dock(
                game: g,
                radar: _radar,
                onSelect: _select,
                fleet: widget.fleet,
                expanded: _expanded,
                cardH: cardH,
                onExpand: (on) {
                  if (on != _expanded) Sfx.I.ui(on ? 'open' : 'close');
                  setState(() => _expanded = on);
                },
                onType: () => _typeSheet(context),
                onNoVoice: widget.onSpeechModel,
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _selectByCallsign(String? cs) {
    if (cs == null) return;
    final a = g.frame?.aircraft.where((x) => x.callsign == cs).firstOrNull;
    if (a != null) _select(a.id);
  }

  Future<void> _typeSheet(BuildContext context) {
    final card = g.ui?.card;
    return showTypeSheet(context, prefill: card != null ? '${card.callsign} ' : '', onSend: (t) => g.type(t));
  }

  Future<void> _menu(BuildContext context) async {
    Sfx.I.ui('open');
  await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _Menu(
        game: g,
        onLeave: () {
          Navigator.pop(ctx);
          widget.onLeave();
        },
        onSpeechModel: () {
          Navigator.pop(ctx);
          widget.onSpeechModel();
        },
        onLog: () {
          Navigator.pop(ctx);
          _log(context);
        },
        onRunways: () {
          Navigator.pop(ctx);
          showRunways(context, g);
        },
      ),
    );
  }

  Future<void> _log(BuildContext context) async {
    final lines = (await g.fullRadio()).reversed.toList();
    if (!context.mounted) return;
    Sfx.I.ui('open');
  await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        maxChildSize: 0.95,
        builder: (ctx, s) => ListView.builder(
          controller: s,
          padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
          itemCount: lines.length + 1,
          itemBuilder: (_, i) => i == 0
              ? const Padding(
                  padding: EdgeInsets.only(bottom: 12),
                  child: Text('Radio log', style: AtcType.title),
                )
              : _RadioLineTile(line: lines[i - 1], wall: g.ui?.wallMs, now: g.ui?.time),
        ),
      ),
    );
  }
}

// ── pieces ──────────────────────────────────────────────────────────────────

/// The keyboard: type a call ("UAL214 runway 28L cleared to land").
Future<void> showTypeSheet(BuildContext context, {String prefill = '', required void Function(String) onSend}) async {
  final ctl = TextEditingController(text: prefill);
  Sfx.I.ui('open');
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) {
      void send(String t) {
        if (t.trim().isNotEmpty) onSend(t);
        Navigator.pop(ctx);
      }

      return Padding(
        padding: EdgeInsets.only(left: 18, right: 18, bottom: MediaQuery.viewInsetsOf(ctx).bottom + 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Type a call', style: AtcType.title),
            const SizedBox(height: 4),
            const Text('Callsign first: UAL214 runway 28L cleared to land', style: AtcType.bodyMuted),
            const SizedBox(height: 14),
            TextField(
              controller: ctl,
            onChanged: (_) => Sfx.I.ui('key'),
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              style: AtcType.data.copyWith(fontSize: 16),
              cursorColor: AtcColors.accent,
              decoration: InputDecoration(
                filled: true,
                fillColor: AtcColors.raise,
                contentPadding: const EdgeInsets.fromLTRB(14, 16, 6, 16),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: AtcColors.line),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: AtcColors.accent, width: 1.5),
                ),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.send_rounded, color: AtcColors.accent),
                  tooltip: 'Send',
                  onPressed: () => send(ctl.text),
                ),
              ),
              onSubmitted: send,
            ),
          ],
        ),
      );
    },
  );
}

/// Which ends departures and arrivals use (the web's runway button): one tap applies.
Future<void> showRunways(BuildContext context, GameController game) async {
  Sfx.I.ui('open');
  await showModalBottomSheet<void>(context: context, isScrollControlled: true, builder: (_) => _RunwaySheet(game: game));
}

class _RunwaySheet extends StatefulWidget {
  const _RunwaySheet({required this.game});
  final GameController game;
  @override
  State<_RunwaySheet> createState() => _RunwaySheetState();
}

class _RunwaySheetState extends State<_RunwaySheet> {
  RunwaysState? _s;
  String _why = '';

  @override
  void initState() {
    super.initState();
    _read();
  }

  Future<void> _read() async {
    final s = await widget.game.runways();
    if (mounted) setState(() => _s = s);
  }

  Future<void> _do(Future<String> Function() change) async {
    HapticFeedback.selectionClick();
    final why = await change();
    if (!mounted) return;
    _why = why;
    await _read();
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    Widget cell(RunwayEnd r, String role) {
      final on = role == 'dep' ? r.dep : r.arr;
      final colour = role == 'dep' ? AtcColors.accent : AtcColors.air;
      return Expanded(
        child: Semantics(
          button: true,
          toggled: on,
          label: role == 'dep' ? 'Departures from ${r.name}' : 'Arrivals to ${r.name}',
          excludeSemantics: true,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: r.open ? () => _do(() => widget.game.toggleRunway(r.name, role)) : null,
            child: Container(
              height: 44,
              margin: const EdgeInsets.only(left: 8),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: on ? colour : AtcColors.raise,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: on ? colour : AtcColors.line),
              ),
              child: Icon(
                role == 'dep' ? Icons.flight_takeoff_rounded : Icons.flight_land_rounded,
                size: 20,
                color: on ? AtcColors.accentInk : r.open ? AtcColors.muted : AtcColors.raise2,
              ),
            ),
          ),
        ),
      );
    }

    // each strip's two ends together, the one into the wind first
    final refs = <String>{for (final r in s?.ends ?? const <RunwayEnd>[]) r.ref};
    final w = s?.wind;
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 14),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Expanded(child: Text('Runways in use', style: AtcType.title)),
                if (w != null) Text('${w.$1.toString().padLeft(3, '0')}° ${w.$2} kt', style: AtcType.data.copyWith(color: AtcColors.text2)),
              ],
            ),
            const SizedBox(height: 12),
            const Row(
              children: [
                SizedBox(width: 124, child: Text('Runway', style: AtcType.label)),
                Expanded(child: Text('Departures', style: AtcType.label, textAlign: TextAlign.center)),
                Expanded(child: Text('Arrivals', style: AtcType.label, textAlign: TextAlign.center)),
              ],
            ),
            for (final ref in refs) ...[
              const Divider(height: 16),
              for (final r in [...s!.ends.where((x) => x.ref == ref)]..sort((a, b) => b.head - a.head))
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 124,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(r.name, style: AtcType.callsign.copyWith(fontSize: 17)),
                            Text(
                              r.open ? '${r.head >= 0 ? 'head' : 'tail'} ${r.head.abs()} · cross ${r.cross}' : r.status,
                              style: AtcType.data.copyWith(fontSize: 11.5, color: r.head < -5 || !r.open ? AtcColors.warn : AtcColors.muted),
                            ),
                          ],
                        ),
                      ),
                      cell(r, 'dep'),
                      cell(r, 'arr'),
                    ],
                  ),
                ),
            ],
            const SizedBox(height: 8),
            Text(
              _why.isNotEmpty ? _why : 'Applies at once. Cleared flights keep theirs.',
              style: AtcType.bodyMuted.copyWith(color: _why.isNotEmpty ? AtcColors.warn : AtcColors.muted),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: s == null ? null : () => _do(widget.game.runwaysIntoWind),
              icon: const Icon(Icons.air_rounded, size: 18),
              label: const Text('Into the wind'),
            ),
          ],
        ),
      ),
    );
  }
}

/// A solid panel (kept for the tutorial screen; the name is historical, there is no glass any more).
class Glass extends StatelessWidget {
  const Glass({super.key, required this.child, this.radius = 16, this.padding});
  final Widget child;
  final double radius;
  final EdgeInsets? padding;
  @override
  Widget build(BuildContext context) => Container(
    padding: padding,
    decoration: BoxDecoration(
      color: AtcColors.surface,
      borderRadius: BorderRadius.circular(radius),
      border: Border.all(color: AtcColors.line),
      boxShadow: const [BoxShadow(color: Color(0x80000000), offset: Offset(0, 6), blurRadius: 18)],
    ),
    child: child,
  );
}

String _clock(double? wallMs) {
  if (wallMs == null || wallMs <= 0) return '--:--';
  final d = DateTime.fromMillisecondsSinceEpoch(wallMs.toInt());
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

String _clockAt(double simT, double? nowT, double? wallMs) => wallMs == null || nowT == null ? '--:--' : _clock(wallMs + (simT - nowT) * 1000);

/// 1234 -> 1,234; 12345 -> 12.3k (the bar has room for about six characters).
String _compact(int n) {
  final a = n.abs(), sign = n < 0 ? '−' : '';
  if (a >= 100000) return '$sign${(a / 1000).round()}k';
  if (a >= 10000) return '$sign${(a / 1000).toStringAsFixed(1)}k';
  return '$sign${a >= 1000 ? '${a ~/ 1000},${(a % 1000).toString().padLeft(3, '0')}' : a}';
}

String _mmss(int s) => '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';

/// Seat switch, score and clock, menu: one solid bar under the status bar.
class _TopBar extends StatelessWidget {
  const _TopBar({required this.ui, required this.position, required this.ai, required this.onSeat, required this.onAi, required this.onMenu});
  final UiState? ui;
  final String position;

  /// The AI runs the player's own seat too (the other seat is always the AI's).
  final bool ai;
  final void Function(String) onSeat;
  final VoidCallback onAi, onMenu;

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    final s = ui?.score;
    final tower = position != 'approach';
    Widget seat(String label, bool on, String p) => Expanded(
      child: Semantics(
        selected: on,
        button: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: on ? null : () => onSeat(p),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOutCubic,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: on ? AtcColors.text : Colors.transparent, borderRadius: BorderRadius.circular(9)),
            child: Text(
              label,
              style: TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w800, fontSize: 13, color: on ? AtcColors.accentInk : AtcColors.text2),
            ),
          ),
        ),
      ),
    );
    final points = s?.points ?? 0;
    return Container(
      padding: EdgeInsets.fromLTRB(10, pad.top + 8, 4, 8),
      decoration: const BoxDecoration(
        color: AtcColors.surface,
        border: Border(bottom: BorderSide(color: AtcColors.line)),
      ),
      child: SizedBox(
        height: kTopBarH - 16,
        child: Row(
          children: [
            Container(
              width: 156,
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(color: AtcColors.raise2, borderRadius: BorderRadius.circular(12)),
              child: Row(children: [seat('Tower', tower, 'tower'), seat('Approach', !tower, 'approach')]),
            ),
            const SizedBox(width: 8),
            _AiButton(on: ai, onTap: onAi),
            const Spacer(),
            Icon(Icons.star_rounded, size: 16, color: points < 0 ? AtcColors.bad : AtcColors.accent),
            const SizedBox(width: 3),
            Text(_compact(points), style: AtcType.data.copyWith(fontSize: 15, color: points < 0 ? AtcColors.bad : AtcColors.text)),
            if ((ui?.rate ?? 1) > 1) Text(' ×${ui!.rate}', style: AtcType.data.copyWith(fontSize: 13, color: AtcColors.accent)),
            IconButton(
              onPressed: onMenu,
              icon: const Icon(Icons.menu_rounded, color: AtcColors.text),
              tooltip: 'Menu',
              visualDensity: VisualDensity.compact,
            ),
          ],
        ),
      ),
    );
  }
}

/// Who runs the seat you are in: you (AI OFF), or the AI as well (AI ON, solid green). One tap flips it.
class _AiButton extends StatelessWidget {
  const _AiButton({required this.on, required this.onTap});
  final bool on;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    toggled: on,
    label: on ? 'AI runs your seat. Tap to take it back' : 'You run your seat. Tap to hand it to the AI',
    child: GestureDetector(
      onTap: () {
        HapticFeedback.mediumImpact();
        onTap();
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOutCubic,
        height: kTopBarH - 18,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: on ? AtcColors.good : Colors.transparent,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: on ? AtcColors.good : AtcColors.lineStrong, width: 1.4),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(on ? Icons.smart_toy_rounded : Icons.smart_toy_outlined, size: 17, color: on ? AtcColors.accentInk : AtcColors.text2),
            const SizedBox(width: 5),
            Text(
              on ? 'AI ON' : 'AI OFF',
              style: TextStyle(
                fontFamily: AtcFonts.sans,
                fontWeight: FontWeight.w800,
                fontSize: 12,
                letterSpacing: 0.5,
                color: on ? AtcColors.accentInk : AtcColors.text2,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// The current alert, full width under the bar: red for a conflict or an emergency, amber for the rest.
class _AlertBar extends StatelessWidget {
  const _AlertBar({required this.alert, required this.onTap});
  final AlertItem alert;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final crit = alert.severity == 'critical' || alert.severity == 'high';
    final ink = crit ? Colors.white : AtcColors.accentInk;
    return Material(
      color: crit ? AtcColors.bad : AtcColors.warn,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 58,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            children: [
              Icon(crit ? Icons.report_rounded : Icons.warning_amber_rounded, color: ink, size: 24),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      alert.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w800, fontSize: 15, color: ink),
                    ),
                    if (alert.detail.isNotEmpty)
                      Text(
                        alert.detail,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w600, fontSize: 12.5, color: ink.withValues(alpha: 0.85)),
                      ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right_rounded, color: ink),
            ],
          ),
        ),
      ),
    );
  }
}

/// The three views as one vertical control on the right edge; the one showing is solid white.
class _ViewSwitch extends StatelessWidget {
  const _ViewSwitch({required this.radar, required this.paused, required this.on3d, required this.onRadar, required this.onTop, required this.onResume});
  final bool radar, paused;
  final VoidCallback on3d, onRadar, onTop, onResume;

  Widget _b(IconData icon, String tip, bool on, VoidCallback tap) => Tooltip(
    message: tip,
    child: Material(
      color: on ? AtcColors.text : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () {
          HapticFeedback.selectionClick();
          tap();
        },
        child: SizedBox(width: 44, height: 44, child: Icon(icon, size: 22, color: on ? AtcColors.accentInk : AtcColors.text)),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Glass(
          radius: 13,
          padding: const EdgeInsets.all(3),
          child: Column(
            children: [
              _b(Icons.view_in_ar_rounded, '3D airfield', !radar, on3d),
              const SizedBox(height: 3),
              _b(Icons.radar_rounded, 'Radar', radar, onRadar),
              if (!radar) ...[const SizedBox(height: 3), _b(Icons.map_outlined, 'Top-down view', false, onTop)],
            ],
          ),
        ),
        if (paused) ...[
          const SizedBox(height: 10),
          Material(
            color: AtcColors.accent,
            borderRadius: BorderRadius.circular(13),
            child: InkWell(
              borderRadius: BorderRadius.circular(13),
              onTap: onResume,
              child: const SizedBox(width: 50, height: 50, child: Icon(Icons.play_arrow_rounded, color: AtcColors.accentInk, size: 28)),
            ),
          ),
        ],
      ],
    );
  }
}

/// The bottom of the screen, one solid surface: the picked flight's short card (who, what to say, Send, expand), the
/// flights in a row (chips on the airfield, strips on the scope), and the radio bar.
class _Dock extends StatelessWidget {
  const _Dock({
    required this.game,
    required this.radar,
    required this.fleet,
    required this.expanded,
    required this.cardH,
    required this.onSelect,
    required this.onExpand,
    required this.onType,
    this.onNoVoice,
  });
  final GameController game;
  final Fleet fleet;
  final bool radar, expanded;
  final double cardH;
  final void Function(int?) onSelect;
  final void Function(bool) onExpand;
  final VoidCallback onType;
  final VoidCallback? onNoVoice;

  @override
  Widget build(BuildContext context) {
    final g = game;
    final u = g.ui;
    final card = u?.card;
    final Widget? top = !g.ready
        ? Padding(
            key: const ValueKey('loading'),
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Text(g.loadError ?? 'Opening the tower…', style: AtcType.bodyMuted),
          )
        : card == null
        ? null
        : expanded
        ? SizedBox(
            key: const ValueKey('pager'),
            height: cardH,
            child: _CardPager(game: g, radar: radar, fleet: fleet, onSelect: onSelect, onCollapse: () => onExpand(false)),
          )
        : GestureDetector(
            key: ValueKey(card.id),
            // swipe for the flight beside it in the row; pull up for the whole card
            onHorizontalDragEnd: (d) {
              final v = d.primaryVelocity ?? 0;
              if (v.abs() < 200) return;
              final ids = radar ? [for (final a in stripOrder(g.radarFrame.value)) a['id'] as int] : [for (final r in railOrder(u!)) r.id];
              final i = ids.indexOf(card.id) + (v < 0 ? 1 : -1);
              if (i >= 0 && i < ids.length) {
                HapticFeedback.selectionClick();
                onSelect(ids[i]);
              }
            },
            onVerticalDragEnd: (d) {
              if ((d.primaryVelocity ?? 0) < -150) onExpand(true);
            },
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _Handle(expanded: false, onToggle: () => onExpand(true)),
                _Peek(card: card, game: g, onClose: () => onSelect(null)),
              ],
            ),
          );
    return Container(
      decoration: const BoxDecoration(
        color: AtcColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        border: Border(top: BorderSide(color: AtcColors.lineStrong)),
        boxShadow: [BoxShadow(color: Color(0x99000000), offset: Offset(0, -6), blurRadius: 20)],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedSize(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutCubic,
            alignment: Alignment.bottomCenter,
            // one flight to the next: the old card fades out as the new one slides in a touch from the right
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              layoutBuilder: (current, previous) => Stack(alignment: Alignment.bottomCenter, children: [...previous, ?current]),
              transitionBuilder: (child, anim) => FadeTransition(
                opacity: anim,
                child: SlideTransition(
                  position: Tween(begin: const Offset(0.04, 0), end: Offset.zero).animate(anim),
                  child: child,
                ),
              ),
              child: top == null
                  ? const SizedBox(key: ValueKey('none'), width: double.infinity)
                  : Column(
                      key: top.key,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        top,
                        const Divider(height: 1, thickness: 1, color: AtcColors.line, indent: 14, endIndent: 14),
                      ],
                    ),
            ),
          ),
          const SizedBox(height: 10),
          if (radar) StripRail(frame: g.radarFrame, onSelect: onSelect) else FlightRail(ui: u, selectedId: card?.id, onTap: onSelect),
          RadioBar(game: g, onType: onType, onNoVoice: onNoVoice, docked: true),
        ],
      ),
    );
  }
}

/// The grab bar on the dock's card: drag it (or the card) up for the whole card, down for the short one; a tap flips it.
class _Handle extends StatelessWidget {
  const _Handle({required this.expanded, required this.onToggle});
  final bool expanded;
  final VoidCallback onToggle;
  @override
  Widget build(BuildContext context) => Tooltip(
    message: expanded ? 'Smaller' : 'Full card',
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onToggle,
      onVerticalDragEnd: (d) {
        final v = d.primaryVelocity ?? 0;
        if (expanded ? v > 120 : v < -120) onToggle();
      },
      child: SizedBox(
        height: 22,
        width: double.infinity,
        child: Center(
          child: Container(
            width: 42,
            height: 4,
            decoration: BoxDecoration(color: AtcColors.lineStrong, borderRadius: BorderRadius.circular(2)),
          ),
        ),
      ),
    ),
  );
}

/// The picked flight's whole card, pulled up over the map; swiping left / right moves to the flight beside it in the row
/// (the chips, the camera and the selection follow). The order is kept while it is open, so the pages do not reshuffle
/// under a finger as urgencies change; flights that leave drop out, new ones join the end.
class _CardPager extends StatefulWidget {
  const _CardPager({required this.game, required this.radar, required this.fleet, required this.onSelect, required this.onCollapse});
  final GameController game;
  final bool radar;
  final Fleet fleet;
  final void Function(int?) onSelect;
  final VoidCallback onCollapse;
  @override
  State<_CardPager> createState() => _CardPagerState();
}

typedef _Lite = ({int id, String callsign, String airline, String type});

class _CardPagerState extends State<_CardPager> {
  List<_Lite> _order = [];
  late PageController _ctl;
  bool _moving = false; // paging to a flight picked elsewhere (a chip): the pages passed on the way do not select
  int? _pending; // swiped to, its card not here yet: the old selection must not page back
  DateTime _pendingAt = DateTime(0);

  List<_Lite> _now() {
    final g = widget.game;
    if (widget.radar) {
      return [
        for (final a in stripOrder(g.radarFrame.value))
          (id: a['id'] as int, callsign: a['cs'] as String, airline: (a['cs'] as String).substring(0, 3), type: a['ty'] as String? ?? ''),
      ];
    }
    final u = g.ui;
    return u == null ? [] : [for (final r in railOrder(u)) (id: r.id, callsign: r.callsign, airline: r.airline, type: r.type)];
  }

  void _merge() {
    final now = _now();
    final ids = {for (final l in now) l.id};
    final kept = [
      for (final l in _order)
        if (ids.contains(l.id)) now.firstWhere((x) => x.id == l.id),
    ];
    final have = {for (final l in kept) l.id};
    _order = [...kept, ...now.where((l) => !have.contains(l.id))];
    final sel = widget.game.ui?.card;
    if (sel != null && !_order.any((l) => l.id == sel.id)) _order.add((id: sel.id, callsign: sel.callsign, airline: sel.airline, type: sel.type));
  }

  int get _selIndex => math.max(0, _order.indexWhere((l) => l.id == widget.game.ui?.card?.id));

  @override
  void initState() {
    super.initState();
    _merge();
    _ctl = PageController(initialPage: _selIndex);
    widget.game.addListener(_onGame);
  }

  @override
  void dispose() {
    widget.game.removeListener(_onGame);
    _ctl.dispose();
    super.dispose();
  }

  void _onGame() {
    if (!mounted) return;
    final dragging = _ctl.hasClients && _ctl.position.isScrollingNotifier.value;
    final shown = _ctl.hasClients ? (_ctl.page ?? 0).round() : null;
    final shownId = shown != null && shown < _order.length ? _order[shown].id : null;
    _merge();
    final card = widget.game.ui?.card;
    if (_pending != null && (card?.id == _pending || DateTime.now().difference(_pendingAt) > const Duration(milliseconds: 1500))) _pending = null;
    if (shown != null && !dragging && !_moving) {
      final at = _order.indexWhere((l) => l.id == shownId);
      if (at >= 0 && at != shown) {
        _ctl.jumpToPage(at); // flights left before it: the same flight stays in view
      } else if (_pending == null && _selIndex != (at >= 0 ? at : shown)) {
        // a flight picked from the row: page to it
        _moving = true;
        _ctl.animateToPage(_selIndex, duration: const Duration(milliseconds: 320), curve: Curves.easeOutCubic).whenComplete(() => _moving = false);
      }
    }
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final g = widget.game;
    final card = g.ui?.card;
    return Column(
      children: [
        _Handle(expanded: true, onToggle: widget.onCollapse),
        Expanded(child: _pages(card, g)),
      ],
    );
  }

  Widget _pages(FlightCardData? card, GameController g) {
    return PageView.builder(
      controller: _ctl,
      itemCount: _order.length,
      onPageChanged: (i) {
        if (_moving || i >= _order.length) return;
        HapticFeedback.selectionClick();
        _pending = _order[i].id;
        _pendingAt = DateTime.now();
        widget.onSelect(_order[i].id);
      },
      itemBuilder: (context, i) {
        final l = _order[i];
        final full = card != null && card.id == l.id;
        // pulled down past its top: the card goes back to the short one
        return NotificationListener<OverscrollNotification>(
          onNotification: (n) {
            if (n.overscroll < -4 && n.dragDetails != null && n.metrics.axis == Axis.vertical) widget.onCollapse();
            return false;
          },
          child: SingleChildScrollView(
            physics: const ClampingScrollPhysics(),
            padding: const EdgeInsets.only(bottom: 8),
            child: full
                ? _FlightCard(card: card, ui: g.ui!, game: g, fleet: widget.fleet, onClose: widget.onCollapse)
                : _CardStub(lite: l, fleet: widget.fleet, onClose: widget.onCollapse),
          ),
        );
      },
    );
  }
}

/// A neighbour's page while its card is on its way (a moment after the swipe settles): who it is and its picture.
class _CardStub extends StatelessWidget {
  const _CardStub({required this.lite, required this.fleet, required this.onClose});
  final _Lite lite;
  final Fleet fleet;
  final VoidCallback onClose;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 6, 16, 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            AirlineBadge(code: lite.airline, size: 44),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(lite.callsign, style: AtcType.callsign.copyWith(fontSize: 22)),
                  const SizedBox(height: 3),
                  Text(lite.type, style: AtcType.bodyMuted),
                ],
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(top: 10, bottom: 4),
          child: SizedBox(
            height: 96,
            child: Image.asset(fleet.pictureFor(lite.type, lite.airline), fit: BoxFit.contain, errorBuilder: (_, _, _) => const SizedBox.shrink()),
          ),
        ),
      ],
    ),
  );
}

/// The picked flight, short: who it is, where it is in its flight, what to say and Send. Expand for the whole card.
class _Peek extends StatelessWidget {
  const _Peek({required this.card, required this.game, required this.onClose});
  final FlightCardData card;
  final GameController game;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = card;
    final stageColor = switch (c.tone) {
      'warn' => AtcColors.warn,
      'air' => AtcColors.air,
      'go' => AtcColors.good,
      _ => AtcColors.text2,
    };
    final sub = [
      c.type.isNotEmpty ? c.type : null,
      '${c.from} → ${c.to}',
      c.airborne
          ? '${c.altFt} ft'
          : c.stand.isNotEmpty
          ? 'Stand ${c.stand}'
          : null,
    ].whereType<String>().join('  ·  ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 0, 6, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              AirlineBadge(code: c.airline, size: 36),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(c.callsign, style: AtcType.callsign.copyWith(fontSize: 17)),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            c.stage.toUpperCase(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontFamily: AtcFonts.sans, color: stageColor, fontWeight: FontWeight.w800, fontSize: 11, letterSpacing: 0.6),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      sub,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AtcType.data.copyWith(fontSize: 12.5, color: AtcColors.muted),
                    ),
                  ],
                ),
              ),
              IconButton(
                onPressed: onClose,
                icon: const Icon(Icons.close_rounded, color: AtcColors.text2),
                tooltip: 'Close',
              ),
            ],
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: c.nextWait != null
                ? Text(
                    'Nothing to say yet. ${c.nextWait}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AtcType.body.copyWith(fontSize: 14, color: AtcColors.text2),
                  )
                : Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (!c.mine)
                              const Padding(
                                padding: EdgeInsets.only(bottom: 3),
                                child: Text(
                                  'The AI works this one',
                                  style: TextStyle(fontFamily: AtcFonts.sans, color: AtcColors.good, fontSize: 12.5, fontWeight: FontWeight.w800),
                                ),
                              ),
                            if (c.nextSay != null)
                              Text(
                                '“${c.nextSay}”',
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontFamily: AtcFonts.sans,
                                  fontSize: 15.5,
                                  height: 1.3,
                                  fontWeight: FontWeight.w700,
                                  color: AtcColors.text,
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (c.mine && c.nextCmd != null) ...[
                        const SizedBox(width: 12),
                        FilledButton.icon(
                          onPressed: () {
                            HapticFeedback.mediumImpact();
                            game.type(c.nextCmd!);
                          },
                          icon: const Icon(Icons.send_rounded, size: 17),
                          label: const Text('Send'),
                          style: FilledButton.styleFrom(minimumSize: const Size(0, 48), padding: const EdgeInsets.symmetric(horizontal: 18)),
                        ),
                      ],
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

class _FlightCard extends StatelessWidget {
  const _FlightCard({required this.card, required this.ui, required this.game, required this.fleet, required this.onClose});
  final Fleet fleet;
  final FlightCardData card;
  final UiState ui;
  final GameController game;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = card;
    final stageColor = switch (c.tone) {
      'warn' => AtcColors.warn,
      'air' => AtcColors.air,
      'go' => AtcColors.good,
      _ => AtcColors.text2,
    };
    // only what a controller acts on: where it is and where it is going next. Times show only when they are off.
    final f = c.fin;
    final stats = f != null
        ? [
            ('Runway', f.runway, AtcColors.air),
            ('Out', '${f.nm.toStringAsFixed(1)} NM', null),
            ('Touchdown', _mmss(f.seconds), f.seconds < 120 ? AtcColors.accent : null),
          ]
        : c.airborne
        ? [('Altitude', '${c.altFt} ft', null), ('Speed', '${c.knots} kt', null), ('Runway', c.runway, null)]
        : [('Stand', c.stand, null), ('Runway', c.runway, null)];
    final off = c.timeTone == 'late'
        ? '${c.lateMin.abs()} min late'
        : c.timeTone == 'early'
        ? '${c.lateMin.abs()} min early'
        : null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              AirlineBadge(code: c.airline, size: 40),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(c.callsign, style: AtcType.callsign.copyWith(fontSize: 22)),
                    const SizedBox(height: 2),
                    Text('${c.airlineName} · ${c.model}', maxLines: 1, overflow: TextOverflow.ellipsis, style: AtcType.bodyMuted.copyWith(fontSize: 13)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          // where it is in its flight, and its route (the delay only when there is one)
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: c.stage.toUpperCase(),
                  style: TextStyle(color: stageColor, fontWeight: FontWeight.w800, letterSpacing: 0.6, fontSize: 12),
                ),
                const TextSpan(text: '   '),
                TextSpan(
                  text: '${c.from} → ${c.to}',
                  style: const TextStyle(fontFamily: AtcFonts.mono, color: AtcColors.text, fontSize: 13.5),
                ),
                TextSpan(
                  text: '  ${c.departure ? c.toCity : c.fromCity}',
                  style: const TextStyle(color: AtcColors.muted, fontSize: 13),
                ),
                if (off != null)
                  TextSpan(
                    text: '   $off',
                    style: TextStyle(color: c.timeTone == 'late' ? AtcColors.bad : AtcColors.air, fontWeight: FontWeight.w700, fontSize: 12.5),
                  ),
              ],
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontFamily: AtcFonts.sans),
          ),
          // the aircraft in its airline's livery, side on (the game's own model, baked to a picture)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: SizedBox(
              height: 88,
              child: Image.asset(
                fleet.pictureFor(c.type, c.airline),
                fit: BoxFit.contain,
                gaplessPlayback: true,
                errorBuilder: (_, _, _) => const SizedBox.shrink(),
              ),
            ),
          ),
          _NextCall(card: c, game: game, position: ui.position),
          const SizedBox(height: 12),
          // the numbers that matter now, one quiet strip
          Container(
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(color: AtcColors.raise, borderRadius: BorderRadius.circular(12)),
            child: IntrinsicHeight(
              child: Row(
                children: [
                  for (var i = 0; i < stats.length; i++) ...[
                    if (i > 0) const VerticalDivider(width: 1, thickness: 1, color: AtcColors.line),
                    Expanded(
                      child: Column(
                        children: [
                          Text(
                            stats[i].$2,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AtcType.data.copyWith(fontSize: 17, color: stats[i].$3 ?? AtcColors.text),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            stats[i].$1,
                            style: const TextStyle(fontFamily: AtcFonts.sans, fontSize: 11.5, fontWeight: FontWeight.w600, color: AtcColors.muted),
                          ),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          if (c.lines.isNotEmpty) ...[
            const SizedBox(height: 14),
            for (final l in c.lines.reversed.take(4)) _RadioLineTile(line: l, wall: ui.wallMs, now: ui.time),
          ],
        ],
      ),
    );
  }
}

/// What to say next: the words as said on the radio, the line as typed, and Send.
class _NextCall extends StatelessWidget {
  const _NextCall({required this.card, required this.game, required this.position});
  final FlightCardData card;
  final GameController game;
  final String position;
  @override
  Widget build(BuildContext context) {
    final c = card;
    final seat = position == 'approach' ? 'Tower' : 'Approach';
    if (c.nextWait != null) {
      return Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: AtcColors.raise, borderRadius: BorderRadius.circular(14)),
        child: Row(
          children: [
            const Icon(Icons.hourglass_top_rounded, color: AtcColors.muted, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Text('Nothing to say yet. ${c.nextWait}', style: AtcType.body.copyWith(color: AtcColors.text2, fontSize: 14)),
            ),
          ],
        ),
      );
    }
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
      decoration: BoxDecoration(
        color: AtcColors.raise,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: c.mine ? AtcColors.accent.withValues(alpha: 0.55) : AtcColors.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(c.mine ? Icons.record_voice_over_rounded : Icons.smart_toy_outlined, size: 17, color: c.mine ? AtcColors.accent : AtcColors.good),
              const SizedBox(width: 7),
              Text(
                c.mine ? 'Say' : 'The AI works this one ($seat)',
                style: TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w800, fontSize: 13, color: c.mine ? AtcColors.accent : AtcColors.good),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (c.nextSay != null)
            Text(
              '“${c.nextSay}”',
              style: const TextStyle(fontFamily: AtcFonts.sans, fontSize: 18, height: 1.3, fontWeight: FontWeight.w700, color: AtcColors.text),
            ),
          if (c.mine && c.nextCmd != null) ...[
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: () {
                HapticFeedback.mediumImpact();
                game.type(c.nextCmd!);
              },
              icon: const Icon(Icons.send_rounded, size: 18),
              label: const Text('Send'),
            ),
          ],
          if (c.nextCmd != null) ...[const SizedBox(height: 10), Text(c.nextCmd!, style: AtcType.data.copyWith(fontSize: 13, color: AtcColors.muted))],
          if (c.nextWhy != null) ...[const SizedBox(height: 4), Text(c.nextWhy!, style: AtcType.bodyMuted.copyWith(fontSize: 13))],
        ],
      ),
    );
  }
}

class _RadioLineTile extends StatelessWidget {
  const _RadioLineTile({required this.line, required this.wall, required this.now});
  final RadioLine line;
  final double? wall, now;
  @override
  Widget build(BuildContext context) {
    final l = line;
    final you = l.who == 'ATC';
    final who = you
        ? 'You'
        : l.who == 'AI'
        ? 'AI ${l.aiPos ?? ''}'.trim()
        : l.who == 'SYS'
        ? 'System'
        : (l.callsign ?? 'Pilot');
    final bad = l.status == 'unable' || l.status == 'error' || l.status == 'mismatch';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 48,
            child: Text(_clockAt(l.at.toDouble(), now, wall), style: AtcType.data.copyWith(fontSize: 12, color: AtcColors.muted)),
          ),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: '$who  ',
                    style: TextStyle(
                      fontWeight: FontWeight.w800,
                      color: you
                          ? AtcColors.accent
                          : l.who == 'AI'
                          ? AtcColors.good
                          : AtcColors.text2,
                      fontSize: 13.5,
                    ),
                  ),
                  TextSpan(
                    text: l.text,
                    style: TextStyle(color: bad ? AtcColors.bad : AtcColors.text, fontSize: 14, height: 1.35),
                  ),
                ],
              ),
              style: const TextStyle(fontFamily: AtcFonts.sans),
            ),
          ),
        ],
      ),
    );
  }
}

/// What the recogniser is hearing, then what was sent (or why not), and the game's own notices, for a few seconds.
class CallStrip extends StatefulWidget {
  const CallStrip({super.key, required this.game});
  final GameController game;
  @override
  State<CallStrip> createState() => _CallStripState();
}

class _CallStripState extends State<CallStrip> {
  Timer? _t;
  int _seenToast = -1;

  /// The newest notice says what the alert bar already says.
  bool _repeatsAlert(UiState u) {
    final t = u.toasts.last.text.toLowerCase();
    return u.alerts.any((a) => t.contains(a.title.toLowerCase()) || a.title.toLowerCase().contains(t));
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final g = widget.game;
    final listening = g.voice.state == VoiceState.listening || g.voice.state == VoiceState.thinking;
    final last = g.lastCall;
    // a call with something wrong in it stays long enough to read and to tap the fix
    final stay = Duration(seconds: last != null && last.outcome.faults.isNotEmpty ? 14 : 5);
    final fresh = last != null && DateTime.now().difference(last.at) < stay;
    if (fresh) {
      _t?.cancel();
      _t = Timer(stay, () => mounted ? setState(() {}) : null);
    }
    Widget? child;
    Color edge = AtcColors.lineStrong;
    if (listening) {
      edge = AtcColors.bad;
      child = Row(
        children: [
          const _Pulse(),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              g.partial.isEmpty ? (g.voice.state == VoiceState.thinking ? 'Reading it…' : 'Listening…') : g.partial,
              style: AtcType.body.copyWith(fontSize: 16, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      );
    } else if (!fresh && g.ui != null && g.ui!.toasts.isNotEmpty && g.ui!.toasts.last.key != _seenToast && !_repeatsAlert(g.ui!)) {
      final t = g.ui!.toasts.last;
      edge = t.kind == 'error'
          ? AtcColors.bad
          : t.kind == 'attention'
          ? AtcColors.warn
          : AtcColors.lineStrong;
      child = Row(
        children: [
          Icon(
            t.kind == 'error'
                ? Icons.error_outline_rounded
                : t.kind == 'success'
                ? Icons.check_circle_rounded
                : Icons.info_outline_rounded,
            color: t.kind == 'error'
                ? AtcColors.bad
                : t.kind == 'attention'
                ? AtcColors.warn
                : AtcColors.text2,
            size: 20,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(t.text, style: AtcType.body.copyWith(fontSize: 14), maxLines: 2, overflow: TextOverflow.ellipsis),
          ),
          GestureDetector(
            onTap: () => setState(() => _seenToast = t.key),
            child: const Padding(
              padding: EdgeInsets.all(4),
              child: Icon(Icons.close_rounded, size: 18, color: AtcColors.muted),
            ),
          ),
        ],
      );
    } else if (fresh) {
      final o = last.outcome;
      edge = o.ok ? AtcColors.good : AtcColors.bad;
      child = Row(
        children: [
          Icon(
            o.ok
                ? Icons.check_circle_rounded
                : o.sayAgain
                ? Icons.replay_rounded
                : Icons.error_outline_rounded,
            color: o.ok ? AtcColors.good : AtcColors.bad,
            size: 22,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (o.line.isNotEmpty) Text(o.line, style: AtcType.data.copyWith(fontSize: 14)),
                if (!o.ok && o.faults.isNotEmpty)
                  for (final f in o.faults.take(2)) ...[
                    Text(f.title, style: AtcType.body.copyWith(fontSize: 14, fontWeight: FontWeight.w700, color: AtcColors.bad)),
                    Text(f.text, style: AtcType.bodyMuted.copyWith(fontSize: 13, color: AtcColors.text2), maxLines: 4, overflow: TextOverflow.ellipsis),
                    if (f.fixes.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 6, bottom: 4),
                        child: Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            for (final x in f.fixes)
                              OutlinedButton(
                                onPressed: () => g.type(x.$2),
                                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 38), padding: const EdgeInsets.symmetric(horizontal: 12)),
                                child: Text(x.$1, style: AtcType.data.copyWith(fontSize: 13)),
                              ),
                          ],
                        ),
                      ),
                  ]
                else if (!o.ok && o.error != null)
                  Text(o.error!, style: AtcType.bodyMuted.copyWith(fontSize: 13), maxLines: 2, overflow: TextOverflow.ellipsis),
                if (o.ok && o.heard != null && !last.typed)
                  Text('heard “${o.heard}”', style: AtcType.bodyMuted.copyWith(fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
              ],
            ),
          ),
        ],
      );
    }
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 180),
      child: child == null
          ? const SizedBox.shrink()
          : Container(
              key: ValueKey(listening ? 'l' : last?.at),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: AtcColors.surface,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: edge, width: 1.4),
                boxShadow: const [BoxShadow(color: Color(0x80000000), offset: Offset(0, 6), blurRadius: 18)],
              ),
              child: child,
            ),
    );
  }
}

class _Pulse extends StatefulWidget {
  const _Pulse();
  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
    opacity: Tween(begin: 0.35, end: 1.0).animate(_c),
    child: const Icon(Icons.mic_rounded, color: AtcColors.bad),
  );
}

/// The last line on the frequency, the keyboard, and hold to talk.
class RadioBar extends StatelessWidget {
  const RadioBar({super.key, required this.game, required this.onType, this.highlight = false, this.onNoVoice, this.docked = false});

  /// Inside the game's dock: no surface or edge of its own.
  final bool docked;
  final GameController game;
  final VoidCallback onType;

  /// The tutorial points at it ("your radio").
  final bool highlight;

  /// The mic pressed with no speech model on the phone (opens the download).
  final VoidCallback? onNoVoice;

  @override
  Widget build(BuildContext context) {
    final g = game;
    final pad = MediaQuery.paddingOf(context).bottom;
    final last = g.radio.isNotEmpty ? g.radio.last : null;
    final vs = g.voice.state;
    final talking = vs == VoiceState.listening;
    final canTalk = g.voice.available;
    final offline = vs == VoiceState.off || vs == VoiceState.error;
    final label = switch (vs) {
      VoiceState.listening => 'Release to send',
      VoiceState.thinking => 'Reading it…',
      VoiceState.loading => 'Loading speech…',
      VoiceState.error => onNoVoice != null ? 'Get the speech model' : 'Speech unavailable',
      VoiceState.off => onNoVoice != null ? 'Get the speech model' : 'No speech model',
      VoiceState.ready => 'Hold to talk',
    };
    final bg = talking
        ? AtcColors.bad
        : canTalk
        ? AtcColors.accent
        : AtcColors.raise2;
    final ink = talking
        ? Colors.white
        : canTalk
        ? AtcColors.accentInk
        : AtcColors.text;
    return Container(
      padding: EdgeInsets.fromLTRB(12, 10, 12, 10 + pad),
      decoration: docked
          ? null
          : BoxDecoration(
              color: AtcColors.bg,
              border: Border(
                top: BorderSide(color: highlight ? AtcColors.accent : AtcColors.lineStrong, width: highlight ? 2 : 1),
              ),
            ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            height: 26,
            child: last == null
                ? const SizedBox.shrink()
                : Row(
                    children: [
                      Icon(
                        last.who == 'ATC' ? Icons.north_east_rounded : Icons.south_west_rounded,
                        size: 14,
                        color: last.who == 'ATC'
                            ? AtcColors.accent
                            : last.who == 'AI'
                            ? AtcColors.good
                            : AtcColors.muted,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        last.who == 'ATC'
                            ? 'You'
                            : last.who == 'AI'
                            ? 'AI'
                            : last.who == 'SYS'
                            ? ''
                            : (last.callsign ?? 'Pilot'),
                        style: AtcType.data.copyWith(fontSize: 12.5, color: last.who == 'ATC' ? AtcColors.accent : AtcColors.text2),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          last.text,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AtcType.body.copyWith(fontSize: 13.5, color: AtcColors.text2),
                        ),
                      ),
                    ],
                  ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Material(
                color: AtcColors.raise,
                borderRadius: BorderRadius.circular(16),
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: onType,
                  child: const SizedBox(
                    width: 58,
                    height: 58,
                    child: Tooltip(
                      message: 'Type a call',
                      child: Icon(Icons.keyboard_rounded, color: AtcColors.text),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Listener(
                  onPointerDown: canTalk
                      ? (_) => g.pttDown()
                      : offline && onNoVoice != null
                      ? (_) => onNoVoice!()
                      : null,
                  onPointerUp: canTalk ? (_) => g.pttUp() : null,
                  onPointerCancel: canTalk ? (_) => g.pttUp() : null,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 120),
                    height: 58,
                    alignment: Alignment.center,
                    transform: Matrix4.diagonal3Values(talking ? 0.98 : 1, talking ? 0.98 : 1, 1),
                    transformAlignment: Alignment.center,
                    decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(16)),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          talking
                              ? Icons.graphic_eq_rounded
                              : canTalk
                              ? Icons.mic_rounded
                              : Icons.download_rounded,
                          color: ink,
                          size: 24,
                        ),
                        const SizedBox(width: 10),
                        Text(
                          label.toUpperCase(),
                          style: TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w800, fontSize: 15, letterSpacing: 0.8, color: ink),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// How loud: the airfield (aircraft, the place) and the interface (buttons, alerts, the radio's clicks).
class _Volumes extends StatefulWidget {
  const _Volumes();
  @override
  State<_Volumes> createState() => _VolumesState();
}

class _VolumesState extends State<_Volumes> {
  Widget _one(IconData icon, String name, double v, void Function(double) set, VoidCallback heard) => Row(
    children: [
      const SizedBox(width: 4),
      Icon(v <= 0 ? Icons.volume_off_rounded : icon, size: 22, color: v <= 0 ? AtcColors.muted : AtcColors.text2),
      const SizedBox(width: 14),
      SizedBox(
        width: 118,
        child: Text(name, style: AtcType.body.copyWith(fontWeight: FontWeight.w700)),
      ),
      Expanded(
        child: Slider(
          value: v,
          label: name,
          activeColor: AtcColors.accent,
          inactiveColor: AtcColors.raise2,
          semanticFormatterCallback: (x) => '$name ${(x * 100).round()} percent',
          onChanged: (x) => setState(() => set(x)),
          onChangeEnd: (_) {
            heard();
            Sfx.I.saveVolumes();
          },
        ),
      ),
    ],
  );

  @override
  Widget build(BuildContext context) => Column(
    children: [
      _one(Icons.flight_takeoff_rounded, 'Aircraft', Sfx.I.airfield, (x) => Sfx.I.setVolumes(airfield: x), () {}),
      _one(Icons.touch_app_rounded, 'Buttons & radio', Sfx.I.interface, (x) => Sfx.I.setVolumes(interface: x), () => Sfx.I.ui('readback')),
    ],
  );
}

class _Menu extends StatelessWidget {
  const _Menu({required this.game, required this.onLeave, required this.onSpeechModel, required this.onLog, required this.onRunways});
  final GameController game;
  final VoidCallback onLeave, onSpeechModel, onLog, onRunways;
  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: game,
      builder: (context, _) {
        final u = game.ui;
        final paused = u?.paused ?? false;
        final rate = u?.rate ?? 1;
        Widget row(IconData icon, String title, {String? sub, Widget? trailing, VoidCallback? onTap, Color? color}) => InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
            child: Row(
              children: [
                Icon(icon, color: color ?? AtcColors.text2, size: 22),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: AtcType.body.copyWith(fontWeight: FontWeight.w700, color: color ?? AtcColors.text),
                      ),
                      if (sub != null) Text(sub, style: AtcType.bodyMuted.copyWith(fontSize: 12.5)),
                    ],
                  ),
                ),
                ?trailing,
              ],
            ),
          ),
        );
        Widget speed(int r) => Expanded(
          child: GestureDetector(
            onTap: () => game.setRate(r),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: rate == r ? AtcColors.text : Colors.transparent, borderRadius: BorderRadius.circular(9)),
              child: Text('$r×', style: AtcType.data.copyWith(fontSize: 15, color: rate == r ? AtcColors.accentInk : AtcColors.text2)),
            ),
          ),
        );
        return SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: () => game.setPaused(!paused),
                        icon: Icon(paused ? Icons.play_arrow_rounded : Icons.pause_rounded),
                        label: Text(paused ? 'Resume' : 'Pause'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton.icon(onPressed: onLog, icon: const Icon(Icons.forum_outlined), label: const Text('Radio log')),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    const Text('Speed', style: AtcType.label),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Container(
                        padding: const EdgeInsets.all(3),
                        decoration: BoxDecoration(color: AtcColors.raise2, borderRadius: BorderRadius.circular(12)),
                        child: Row(children: [speed(1), speed(2), speed(4)]),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                row(
                  Icons.add_road_rounded,
                  'Runways in use',
                  sub: u == null ? null : 'Departures ${u.depRunways.join(' ')} · arrivals ${u.arrRunways.join(' ')}',
                  trailing: const Icon(Icons.chevron_right_rounded, color: AtcColors.muted),
                  onTap: onRunways,
                ),
                if (!game.course)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            const Icon(Icons.signpost_outlined, color: AtcColors.text2, size: 22),
                            const SizedBox(width: 14),
                            Expanded(child: Text('Taxiway and stand names', style: AtcType.body.copyWith(fontWeight: FontWeight.w700))),
                          ],
                        ),
                        const SizedBox(height: 8),
                        SegmentedButton<String>(
                          segments: const [
                            ButtonSegment(value: 'auto', label: Text('Auto')),
                            ButtonSegment(value: 'real', label: Text('Real')),
                            ButtonSegment(value: 'simple', label: Text('Simple')),
                          ],
                          selected: {game.core['naming'] as String? ?? 'auto'},
                          showSelectedIcon: false,
                          onSelectionChanged: (s) => game.setNaming(s.first),
                        ),
                      ],
                    ),
                  ),
                const Divider(height: 20),
                const _Volumes(),
                row(
                  Icons.record_voice_over_outlined,
                  'Pilot voices',
                  trailing: Switch(value: game.config.voices, onChanged: game.setVoices),
                  onTap: () => game.setVoices(!game.config.voices),
                ),
                row(
                  Icons.hearing_rounded,
                  'Hear ground in Tower',
                  sub: 'Off: only the tower frequency and answers to your calls',
                  trailing: Switch(value: game.core['hearGround'] == true, onChanged: game.setHearGround),
                  onTap: () => game.setHearGround(game.core['hearGround'] != true),
                ),
                row(
                  Icons.mic_none_rounded,
                  'Speech model',
                  sub: game.voice.available ? game.voice.label : 'Not on this phone yet',
                  trailing: const Icon(Icons.chevron_right_rounded, color: AtcColors.muted),
                  onTap: onSpeechModel,
                ),
                const Divider(height: 20),
                row(
                  Icons.restart_alt_rounded,
                  'New shift',
                  onTap: () {
                    Navigator.pop(context);
                    game.restart();
                  },
                ),
                row(Icons.logout_rounded, 'Leave the tower', color: AtcColors.bad, onTap: onLeave),
              ],
            ),
          ),
        );
      },
    );
  }
}
