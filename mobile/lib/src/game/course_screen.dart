// The tutorial on the phone: the web course (/learn) on the live SFO map, in portrait. The five parts across the top;
// the card at the bottom (a tour step's lines appear one by one, then its little diagram; a mission shows the
// objective and the call as a button); the map shows what the card is about (camera, lit routes, marks, a ring on the
// aircraft); the radio bar below, so every call can also be typed or said. The narrator speaks between radio calls.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../ui/theme.dart';
import 'airport_map.dart';
import 'fleet.dart';
import 'game_controller.dart';
import 'game_screen.dart' show CallStrip, Glass, RadioBar, showTypeSheet;

class CourseScreen extends StatefulWidget {
  const CourseScreen({super.key, required this.game, required this.fleet, required this.onExit, required this.onPlay, this.mapOverride, this.onSpeechModel});
  final GameController game;
  final Fleet fleet;
  final VoidCallback onExit;

  /// "Start a shift at SFO" on the last step.
  final VoidCallback onPlay;

  /// The mic pressed with no speech model: open the download.
  final VoidCallback? onSpeechModel;

  /// Stands in for the Mapbox map (tests render the screen without a GPU map).
  final Widget? mapOverride;

  @override
  State<CourseScreen> createState() => _CourseScreenState();
}

class _CourseScreenState extends State<CourseScreen> {
  final _map = AirportMapController();
  GameController get g => widget.game;
  String _stepId = '';
  int _shown = 1;
  final List<Timer> _beats = [];
  bool _freePlay = false;

  @override
  void initState() {
    super.initState();
    g.addListener(_changed);
    // the step already open when the screen appears reveals its lines too
    final st = g.courseState;
    final id = (st?['step'] as Map?)?['id'] as String?;
    if (st != null && id != null) {
      _stepId = id;
      _revealLines(st);
    }
  }

  @override
  void dispose() {
    g.removeListener(_changed);
    for (final t in _beats) {
      t.cancel();
    }
    super.dispose();
  }

  void _changed() {
    final st = g.courseState;
    final id = (st?['step'] as Map?)?['id'] as String?;
    if (id != null && id != _stepId) {
      _stepId = id;
      _revealLines(st!);
    }
    if (mounted) setState(() {});
  }

  /// A tour step's lines appear one by one (Course.tsx: 400 ms, then a beat of 900 ms each).
  void _revealLines(Map<String, dynamic> st) {
    for (final t in _beats) {
      t.cancel();
    }
    _beats.clear();
    final step = st['step'] as Map<String, dynamic>;
    final body = (step['body'] as List).length;
    _shown = 1;
    if (step['mission'] != null) return;
    for (var k = 1; k < body; k++) {
      _beats.add(Timer(Duration(milliseconds: 400 + 900 * k), () => mounted ? setState(() => _shown = math.max(_shown, k + 1)) : null));
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = g.courseState;
    final pad = MediaQuery.paddingOf(context);
    final step = st?['step'] as Map<String, dynamic>?;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        backgroundColor: AtcColors.bg,
        resizeToAvoidBottomInset: false,
        body: Stack(children: [
          Positioned.fill(child: widget.mapOverride ?? AirportMap(game: g, fleet: widget.fleet, controller: _map, onTapAircraft: g.select)),
          Positioned(left: 10, right: 10, top: pad.top + 6, child: st == null ? const SizedBox.shrink() : _Parts(state: st, onSection: g.courseSection, onExit: widget.onExit)),
          if (!g.ready || st == null)
            Positioned.fill(child: Center(child: Glass(padding: const EdgeInsets.all(20), child: Text(g.loadError ?? 'Opening the tower…'))))
          else if (!_freePlay)
            Positioned(
              left: 10, right: 10, bottom: 92 + pad.bottom,
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.46),
                child: _Card(
                  state: st,
                  shown: step?['mission'] != null ? 99 : _shown,
                  game: g,
                  onMore: () => setState(() => _shown = 99),
                  onPlay: widget.onPlay,
                  onFreePlay: () {
                    g.courseFreePlay();
                    setState(() => _freePlay = true);
                  },
                ),
              ),
            )
          else
            Positioned(
              left: 10, right: 10, bottom: 92 + pad.bottom,
              child: Glass(
                padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
                child: Row(children: [
                  const Expanded(child: Text('Free play: traffic is on. Work it, or start a real shift.', style: TextStyle(fontSize: 13))),
                  TextButton(onPressed: widget.onPlay, child: const Text('Start a shift')),
                ]),
              ),
            ),
          Positioned(left: 12, right: 12, bottom: 92 + pad.bottom + (_freePlay ? 64 : 0), child: _freePlay ? CallStrip(game: g) : const SizedBox.shrink()),
          Positioned(
            left: 0, right: 0, bottom: 0,
            child: RadioBar(
              game: g,
              highlight: step?['point'] == 'cmd',
              onNoVoice: widget.onSpeechModel,
              onType: () {
                final ph = ((st?['mission'] as Map?)?['cur'] as Map?)?['phrase'] as String?;
                showTypeSheet(context, prefill: ph ?? '', onSend: (t) => g.courseSend(t));
              },
            ),
          ),
        ]),
      ),
    );
  }
}

const _short = {'airport': 'Airport', 'radio': 'Radio', 'ground': 'Ground', 'tower': 'Tower', 'approach': 'Approach'};

/// The five parts of the course, with how far into each you are, and the way out.
class _Parts extends StatelessWidget {
  const _Parts({required this.state, required this.onSection, required this.onExit});
  final Map<String, dynamic> state;
  final void Function(String) onSection;
  final VoidCallback onExit;
  @override
  Widget build(BuildContext context) {
    final secs = (state['sections'] as List).cast<Map<String, dynamic>>();
    return Glass(
      radius: 16,
      padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
      child: Row(children: [
        for (final s in secs)
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => onSection(s['id'] as String),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(_short[s['id']] ?? s['title'] as String, maxLines: 1, overflow: TextOverflow.fade, softWrap: false, style: TextStyle(fontFamily: AtcFonts.sans, fontSize: 11.5, letterSpacing: -0.1, fontWeight: FontWeight.w800, color: s['on'] == true ? AtcColors.text : AtcColors.muted)),
                  const SizedBox(height: 5),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(2),
                    child: LinearProgressIndicator(value: ((s['frac'] as num?) ?? 0).toDouble().clamp(0.0, 1.0), minHeight: 4, backgroundColor: AtcColors.raise2, color: AtcColors.accent),
                  ),
                ]),
              ),
            ),
          ),
        IconButton(onPressed: onExit, icon: const Icon(Icons.close_rounded, size: 20), tooltip: 'Skip tutorial', visualDensity: VisualDensity.compact),
      ]),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.state, required this.shown, required this.game, required this.onMore, required this.onPlay, required this.onFreePlay});
  final Map<String, dynamic> state;
  final int shown;
  final GameController game;
  final VoidCallback onMore, onPlay, onFreePlay;

  @override
  Widget build(BuildContext context) {
    final step = state['step'] as Map<String, dynamic>;
    final body = (step['body'] as List).cast<String>();
    final mission = state['mission'] as Map<String, dynamic>?;
    final isMission = step['mission'] != null;
    final done = state['done'] == true;
    final allShown = shown >= body.length;
    final first = state['i'] == 0, last = state['last'] == true;
    final visual = step['visual'] as String?;
    return Glass(
      radius: 20,
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Flexible(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 220),
              child: Column(key: ValueKey(step['id']), crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(child: Text(step['title'] as String, style: AtcType.display.copyWith(fontSize: 23))),
                  const SizedBox(width: 10),
                  Padding(padding: const EdgeInsets.only(top: 4), child: Text((step['kicker'] as String).split(' · ').last, style: AtcType.data.copyWith(fontSize: 13, color: AtcColors.muted))),
                ]),
                const SizedBox(height: 10),
                if (isMission)
                  Text(body.first, style: AtcType.body.copyWith(color: AtcColors.text2))
                else
                  for (final (k, line) in body.indexed)
                    AnimatedOpacity(
                      duration: const Duration(milliseconds: 300),
                      opacity: k < shown ? 1 : 0,
                      child: Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(line, style: AtcType.body.copyWith(fontSize: 16))),
                    ),
                if (visual != null && allShown && !isMission) ...[
                  const SizedBox(height: 10),
                  _Aid(visual: visual, routeNames: (state['routeNames'] as List).cast<String>(), onPlay: onPlay, onFreePlay: onFreePlay, onRestart: game.courseRestart),
                ],
                if (isMission) ...[const SizedBox(height: 10), _Mission(mission: mission, game: game)],
              ]),
            ),
          ),
        ),
        const Divider(height: 1, color: AtcColors.line),
        Padding(
          padding: const EdgeInsets.fromLTRB(6, 4, 8, 6),
          child: Row(children: [
            TextButton.icon(onPressed: first ? null : game.courseBack, icon: const Icon(Icons.arrow_back_rounded, size: 18), label: const Text('Back')),
            const Spacer(),
            if (!last)
              isMission && !done
                  ? TextButton(onPressed: game.courseNext, child: const Text('Skip'))
                  : FilledButton(
                      onPressed: () {
                        HapticFeedback.selectionClick();
                        if (!isMission && !allShown) {
                          onMore();
                        } else {
                          game.courseNext();
                        }
                      },
                      child: Text(allShown ? 'Next' : 'More'),
                    ),
          ]),
        ),
      ]),
    );
  }
}

/// A live mission: the objectives as dots, the current one, the call as a button (Course.tsx Mission).
class _Mission extends StatelessWidget {
  const _Mission({required this.mission, required this.game});
  final Map<String, dynamic>? mission;
  final GameController game;
  @override
  Widget build(BuildContext context) {
    final m = mission;
    if (m == null || m['live'] != true) return const Text('Getting the aircraft ready…', style: AtcType.bodyMuted);
    final goals = (m['goals'] as List).cast<Map<String, dynamic>>();
    final cur = m['cur'] as Map<String, dynamic>?;
    final note = m['note'] as Map<String, dynamic>?;
    final phrase = cur?['phrase'] as String?;
    final spoken = cur?['spoken'] as String?;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        for (final gl in goals)
          Container(
            width: gl['now'] == true ? 18 : 8, height: 8, margin: const EdgeInsets.only(right: 5),
            decoration: BoxDecoration(color: gl['met'] == true ? AtcColors.good : gl['now'] == true ? AtcColors.accent : AtcColors.raise, borderRadius: BorderRadius.circular(4)),
          ),
        const Spacer(),
        if (m['fast'] == true) const Row(children: [Icon(Icons.fast_forward_rounded, size: 16, color: AtcColors.muted), SizedBox(width: 4), Text('Fast-forward', style: TextStyle(fontFamily: AtcFonts.sans, fontSize: 12.5, fontWeight: FontWeight.w700, color: AtcColors.muted))]),
      ]),
      const SizedBox(height: 10),
      if (m['stage'] == 'done')
        const Row(children: [Icon(Icons.check_circle_rounded, color: AtcColors.good), SizedBox(width: 8), Text('Done', style: TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w800, fontSize: 17, color: AtcColors.good))])
      else if (cur == null)
        const Text('Watch the aircraft…', style: AtcType.bodyMuted)
      else ...[
        Text(cur['title'] as String, style: AtcType.title),
        if ((cur['why'] as String).isNotEmpty) Padding(padding: const EdgeInsets.only(top: 3), child: Text(cur['why'] as String, style: AtcType.bodyMuted)),
        const SizedBox(height: 10),
        if (phrase != null) ...[
          Material(
            color: AtcColors.accent,
            borderRadius: BorderRadius.circular(14),
            child: InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: () {
                HapticFeedback.mediumImpact();
                game.courseSend(phrase);
              },
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
                child: Row(children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(spoken ?? phrase, style: const TextStyle(fontFamily: AtcFonts.sans, fontSize: 17, fontWeight: FontWeight.w800, height: 1.25, color: AtcColors.accentInk)),
                      if (spoken != null) Padding(padding: const EdgeInsets.only(top: 3), child: Text(phrase, style: const TextStyle(fontFamily: AtcFonts.mono, fontSize: 12.5, color: Color(0xB3111111)))),
                    ]),
                  ),
                  const SizedBox(width: 8),
                  const Text('SEND', style: TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w800, letterSpacing: 0.8, color: AtcColors.accentInk)),
                  const SizedBox(width: 6),
                  const Icon(Icons.send_rounded, size: 18, color: AtcColors.accentInk),
                ]),
              ),
            ),
          ),
          const SizedBox(height: 6),
          const Text('Or type it, or hold the talk button and say it', style: AtcType.bodyMuted),
        ] else
          const Text('Watch the aircraft…', style: AtcType.bodyMuted),
      ],
      if (note != null) ...[
        const SizedBox(height: 10),
        GestureDetector(
          onTap: () => game.courseDismiss(note['id'] as int),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: note['tone'] == 'warn' ? const Color(0x33E5534B) : const Color(0x22FFFFFF), borderRadius: BorderRadius.circular(10)),
            child: Text(note['text'] as String, style: const TextStyle(fontSize: 13, height: 1.3)),
          ),
        ),
      ],
    ]);
  }
}

// ── the small diagrams on reading steps (Course.tsx Aid) ──

const _nato = {'A': 'Alpha', 'B': 'Bravo', 'C': 'Charlie', 'D': 'Delta', 'E': 'Echo', 'F': 'Foxtrot', 'G': 'Golf', 'H': 'Hotel', 'I': 'India', 'J': 'Juliett', 'K': 'Kilo', 'L': 'Lima', 'M': 'Mike', 'N': 'November', 'O': 'Oscar', 'P': 'Papa', 'Q': 'Quebec', 'R': 'Romeo', 'S': 'Sierra', 'T': 'Tango', 'U': 'Uniform', 'V': 'Victor', 'W': 'Whiskey', 'X': 'X-ray', 'Y': 'Yankee', 'Z': 'Zulu'};
const _digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
String _sayName(String n) {
  final words = n.split('').map((ch) => _nato[ch] ?? (int.tryParse(ch) != null ? _digits[int.parse(ch)] : ch)).toList();
  return [for (final (k, w) in words.indexed) k == 0 ? w : '${w[0].toUpperCase()}${w.substring(1)}'].join(' ');
}

class _Aid extends StatelessWidget {
  const _Aid({required this.visual, required this.routeNames, required this.onPlay, required this.onFreePlay, required this.onRestart});
  final String visual;
  final List<String> routeNames;
  final VoidCallback onPlay, onFreePlay, onRestart;

  Widget _chip(String b, String rest, {Color? tone}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(color: (tone ?? Colors.white).withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10), border: Border.all(color: (tone ?? Colors.white).withValues(alpha: 0.3))),
        child: Text.rich(TextSpan(children: [TextSpan(text: '$b ', style: const TextStyle(fontWeight: FontWeight.w800)), TextSpan(text: rest)]), style: const TextStyle(fontSize: 13)),
      );

  Widget _table(List<(String, String)> rows) => Column(children: [
        for (final r in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(flex: 5, child: Text(r.$1, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5))),
              Expanded(flex: 5, child: Text(r.$2, style: const TextStyle(color: AtcColors.muted, fontSize: 13.5))),
            ]),
          ),
      ]);

  @override
  Widget build(BuildContext context) {
    const go = Color(0xFF3BEA7A), arr = Color(0xFF5AA8FF);
    switch (visual) {
      case 'journey':
        return Wrap(spacing: 6, runSpacing: 6, children: [
          for (final (k, x) in ['Gate', 'Taxi', 'Takeoff', 'Radar', 'Landing'].indexed) _chip('${k + 1}', x, tone: k < 3 ? go : arr),
        ]);
      case 'plan':
        return Wrap(spacing: 8, runSpacing: 6, children: [_chip('Take off', '01L · 01R', tone: go), _chip('Land', '28L · 28R', tone: arr)]);
      case 'compass':
        return SizedBox(height: 96, child: Row(children: [const SizedBox(width: 96, height: 96, child: CustomPaint(painter: _CompassPainter())), const SizedBox(width: 14), const Text('280° → 28', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800))]));
      case 'taxiways':
        final names = routeNames.isNotEmpty ? routeNames : ['A', 'M', 'M1'];
        return Wrap(spacing: 6, runSpacing: 6, children: [for (final n in names) _chip(n, _sayName(n))]);
      case 'words':
        return _table(const [('Pushback approved', 'Back out of the gate'), ('Taxi to runway…', 'Drive there, by this route'), ('Hold position', 'Stop now'), ('Cross runway…', 'Drive across it'), ('Contact tower', 'Talk to the next controller'), ('Cleared for takeoff', 'Go'), ('Cleared to land', 'Land')]);
      case 'numbers':
        return _table(const [('M1', 'Mike One'), ('01R', 'zero one right'), ('9', 'niner'), ('5000 ft', 'five thousand')]);
      case 'anatomy':
        final via = routeNames.take(3).toList();
        Widget part(String k, String v, Color c) => Expanded(
              child: Container(
                margin: const EdgeInsets.only(right: 6),
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(color: c.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(k, style: TextStyle(fontSize: 10.5, color: c, fontWeight: FontWeight.w800)), Text(v, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700))]),
              ),
            );
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [part('WHO', 'DLH455', AtcColors.accent), part('WHAT', 'taxi to runway 01R', go), part('WHERE', 'via ${via.isNotEmpty ? via.join(' ') : 'A M'}', arr)]),
          const SizedBox(height: 8),
          Text('Pilot: “Taxi runway zero one right via ${via.isNotEmpty ? via.map(_sayName).join(', ') : 'Alpha, Mike'}, Lufthansa four five five.”', style: const TextStyle(color: AtcColors.muted, fontSize: 13, height: 1.35)),
        ]);
      case 'finish':
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          FilledButton(onPressed: onPlay, style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)), child: const Text('Start a shift at SFO')),
          const SizedBox(height: 6),
          Row(children: [
            Expanded(child: OutlinedButton(onPressed: onFreePlay, child: const Text('Free play here'))),
            const SizedBox(width: 8),
            Expanded(child: OutlinedButton(onPressed: onRestart, child: const Text('Start over'))),
          ]),
        ]);
    }
    return const SizedBox.shrink();
  }
}

class _CompassPainter extends CustomPainter {
  const _CompassPainter();
  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero), r = size.width / 2 - 4;
    canvas.drawCircle(c, r, Paint()..style = PaintingStyle.stroke..strokeWidth = 2..color = AtcColors.muted);
    for (final (k, d) in ['N', 'E', 'S', 'W'].indexed) {
      final a = k * math.pi / 2;
      final tp = TextPainter(text: TextSpan(text: d, style: const TextStyle(fontSize: 11, color: AtcColors.muted, fontWeight: FontWeight.w700)), textDirection: TextDirection.ltr)..layout();
      tp.paint(canvas, c + Offset(math.sin(a) * (r - 11), -math.cos(a) * (r - 11)) - Offset(tp.width / 2, tp.height / 2));
    }
    final a = 280 * math.pi / 180;
    canvas.drawLine(c, c + Offset(math.sin(a) * (r - 2), -math.cos(a) * (r - 2)), Paint()..strokeWidth = 3..strokeCap = StrokeCap.round..color = AtcColors.accent);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
