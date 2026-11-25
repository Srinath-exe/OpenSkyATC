// The two layouts picked from public/reports/mobile-layouts.html:
//   Rail (the tower seat, on the 3D map): the flights as a row of chips above the radio bar, most urgent first; a tap
//     raises a compact card with the call to send, pulled up for the whole card. The map keeps most of the screen.
//   Scope + strips (the approach seat, on the radar): the scope keeps the screen; the strips run in a row under it.
//   Either way a tap raises a short card above the row (the call to send), expanded for the whole card.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart';
import '../ui/theme.dart';

const _blue = AtcColors.air, _lime = Color(0xFFB8F25C), _green = AtcColors.good;
const _mono = TextStyle(fontFamily: AtcFonts.mono, fontFeatures: AtcType.tabular);

const airlineColors = <String, Color>{
  'UAL': Color(0xFF1B4FA0), 'ASA': Color(0xFF01426A), 'SWA': Color(0xFF304CB2), 'DAL': Color(0xFFC01933), 'AAL': Color(0xFF9DA6AB),
  'SKW': Color(0xFF2F3E5C), 'ANA': Color(0xFF13448F), 'JAL': Color(0xFFCC0000), 'CPA': Color(0xFF006564), 'SIA': Color(0xFFF2A900),
  'BAW': Color(0xFF075AAA), 'JBU': Color(0xFF003876), 'HAL': Color(0xFF5B2A86), 'UAE': Color(0xFFD71A21), 'KLM': Color(0xFF00A1DE),
  'AFR': Color(0xFF002157), 'DLH': Color(0xFF05164D), 'EVA': Color(0xFF00703C), 'KAL': Color(0xFF00A0DF), 'QFA': Color(0xFFE0001B),
};

class AirlineBadge extends StatelessWidget {
  const AirlineBadge({super.key, required this.code, this.size = 26});
  final String code;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
        width: size, height: size, alignment: Alignment.center,
        decoration: BoxDecoration(color: airlineColors[code] ?? const Color(0xFF2A2C31), borderRadius: BorderRadius.circular(size * 0.27)),
        child: Text(code, style: TextStyle(fontFamily: AtcFonts.sans, fontSize: size * 0.3, fontWeight: FontWeight.w800, color: Colors.white, letterSpacing: 0.3)),
      );
}

// ── Rail ─────────────────────────────────────────────────────────────────────

/// Most urgent first: an emergency, a flight asking for something, the next to land, then by time.
List<BoardRow> railOrder(UiState u) {
  final all = [...u.arrivals, ...u.departures];
  int rank(BoardRow r) => r.emergency ? 0 : r.request ? 1 : r.fin != null && r.fin!.seconds < 180 ? 2 : 3;
  all.sort((a, b) {
    final d = rank(a) - rank(b);
    if (d != 0) return d;
    final fa = a.fin?.seconds ?? 1 << 20, fb = b.fin?.seconds ?? 1 << 20;
    return fa != fb ? fa - fb : a.est.compareTo(b.est);
  });
  return all;
}

String _short(BoardRow r) {
  if (r.fin != null) return '${r.fin!.seconds ~/ 60}:${(r.fin!.seconds % 60).toString().padLeft(2, '0')}';
  final m = r.mid.toLowerCase();
  for (final (k, v) in const [('pushback', 'push'), ('ready', 'ready'), ('taxi', 'taxi'), ('start', 'start'), ('cross', 'cross'), ('clearance', 'clnc'), ('checking', 'check in'), ('vacated', 'vacated')]) {
    if (m.contains(k)) return v;
  }
  return r.type;
}

class FlightRail extends StatelessWidget {
  const FlightRail({super.key, required this.ui, required this.selectedId, required this.onTap});
  final UiState? ui;
  final int? selectedId;
  final void Function(int id) onTap;

  @override
  Widget build(BuildContext context) {
    final u = ui;
    final rows = u == null ? const <BoardRow>[] : railOrder(u);
    if (rows.isEmpty) {
      return const SizedBox(height: 54, child: Center(child: Text('No flights on your frequency right now', style: AtcType.bodyMuted)));
    }
    return SizedBox(
      height: 54,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: rows.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (_, i) {
          final r = rows[i];
          final sel = r.id == selectedId;
          // selected: solid white; wants something: amber edge; emergency: red; the rest quiet
          final edge = sel ? AtcColors.text : r.emergency ? AtcColors.bad : r.request ? AtcColors.warn : AtcColors.lineStrong;
          final soon = r.fin != null && r.fin!.seconds < 120;
          final status = _short(r).toUpperCase();
          final statusColor = sel ? AtcColors.accentInk.withValues(alpha: 0.75) : r.emergency ? AtcColors.bad : r.request ? AtcColors.warn : soon ? AtcColors.accent : AtcColors.muted;
          return Semantics(
            button: true,
            selected: sel,
            label: '${r.callsign}, ${r.mid}',
            child: GestureDetector(
              onTap: () {
                HapticFeedback.selectionClick();
                onTap(r.id);
              },
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                padding: const EdgeInsets.fromLTRB(7, 7, 14, 7),
                decoration: BoxDecoration(
                  color: sel ? AtcColors.text : AtcColors.raise,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: edge, width: r.request || r.emergency || sel ? 1.6 : 1),
                ),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  AirlineBadge(code: r.airline, size: 34),
                  const SizedBox(width: 9),
                  Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(r.callsign, style: AtcType.callsign.copyWith(fontSize: 14.5, color: sel ? AtcColors.accentInk : AtcColors.text)),
                    const SizedBox(height: 2),
                    Text(status, style: TextStyle(fontFamily: r.fin != null ? AtcFonts.mono : AtcFonts.sans, fontSize: 11.5, height: 1.1, fontWeight: FontWeight.w800, letterSpacing: r.fin != null ? 0 : 0.6, color: statusColor, fontFeatures: AtcType.tabular)),
                  ]),
                ]),
              ),
            ),
          );
        },
      ),
    );
  }
}

// ── Strips ───────────────────────────────────────────────────────────────────

/// The scope's flights in strip order: mine first (emergencies, then requests), then the others.
List<Map<String, dynamic>> stripOrder(Map<String, dynamic>? f) {
  final ac = ((f?['ac'] as List?) ?? const []).cast<Map<String, dynamic>>().toList();
  int rank(Map<String, dynamic> a) => a['emg'] == 1 ? 0 : a['req'] == 1 && a['mine'] == 1 ? 1 : a['mine'] == 1 ? 2 : 3;
  ac.sort((a, b) {
    final d = rank(a) - rank(b);
    return d != 0 ? d : (a['cs'] as String).compareTo(b['cs'] as String);
  });
  return ac;
}

/// The scope's flights as a row of strips under it: mine first (emergencies, then requests), then the others dimmed.
class StripRail extends StatelessWidget {
  const StripRail({super.key, required this.frame, required this.onSelect});
  final ValueNotifier<Map<String, dynamic>?> frame;
  final void Function(int? id) onSelect;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<Map<String, dynamic>?>(
      valueListenable: frame,
      builder: (context, f, _) {
        final ac = stripOrder(f);
        if (ac.isEmpty) return const SizedBox(height: 54, child: Center(child: Text('Nothing airborne right now', style: AtcType.bodyMuted)));
        return SizedBox(
          height: 54,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            itemCount: ac.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (_, i) => _Strip(a: ac[i], onTap: () {
              HapticFeedback.selectionClick();
              onSelect(ac[i]['sel'] == 1 ? null : ac[i]['id'] as int);
            }),
          ),
        );
      },
    );
  }
}

/// One strip: the bay colour down its left edge, callsign and type, level and cleared level, and what it is doing.
class _Strip extends StatelessWidget {
  const _Strip({required this.a, required this.onTap});
  final Map<String, dynamic> a;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final sel = a['sel'] == 1, mine = a['mine'] == 1, arr = a['arr'] == 1, emg = a['emg'] == 1, req = a['req'] == 1 && mine;
    final dim = !mine && !sel;
    final to = a['to'] as Map?;
    final ink = sel ? AtcColors.accentInk : dim ? AtcColors.muted : AtcColors.text;
    final bay = emg ? AtcColors.bad : arr ? _blue : AtcColors.accent;
    final tagText = emg ? 'EMERG' : req ? 'REQ' : a['tag'] != null ? '→${a['tag']}' : (a['mode'] as String).isNotEmpty ? a['mode'] as String : (a['l4'] as String? ?? '');
    final tagColor = sel ? AtcColors.accentInk.withValues(alpha: 0.7) : emg ? AtcColors.bad : req ? AtcColors.warn : a['tag'] != null ? _green : dim ? AtcColors.muted : _lime;
    return Semantics(
      button: true,
      selected: sel,
      label: '${a['cs']}, ${a['alt']}',
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          constraints: const BoxConstraints(minWidth: 128),
          padding: const EdgeInsets.fromLTRB(10, 6, 12, 6),
          decoration: BoxDecoration(
            color: sel ? AtcColors.text : AtcColors.raise,
            borderRadius: BorderRadius.circular(10),
            border: Border(left: BorderSide(color: bay.withValues(alpha: dim ? 0.45 : 1), width: 5)),   // the strip's bay colour, as on paper
          ),
          foregroundDecoration: req || emg ? BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: emg ? AtcColors.bad : AtcColors.warn, width: 1.4)) : null,
          child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              Text(a['cs'] as String, style: _mono.copyWith(fontSize: 14.5, fontWeight: FontWeight.w500, color: ink)),
              const SizedBox(width: 8),
              Text(a['ty'] as String? ?? '', style: _mono.copyWith(fontSize: 11.5, color: sel ? ink.withValues(alpha: 0.6) : AtcColors.muted)),
            ]),
            const SizedBox(height: 2),
            Row(mainAxisSize: MainAxisSize.min, children: [
              Text(a['alt'] as String, style: _mono.copyWith(fontSize: 13, color: ink)),
              if (to != null) Text(' ${to['up'] == true ? '↑' : '↓'}${to['v']}', style: _mono.copyWith(fontSize: 13, color: sel ? ink : to['pend'] == true ? AtcColors.accent : AtcColors.text2)),
              if (tagText.isNotEmpty) ...[
                const SizedBox(width: 8),
                Text(tagText, style: _mono.copyWith(fontSize: 12, fontWeight: FontWeight.w500, color: tagColor)),
              ],
            ]),
          ]),
        ),
      ),
    );
  }
}
