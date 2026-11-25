// "A better model is ready": asked on the first screen (never in the middle of a shift) and from the menu.

import 'package:flutter/material.dart';

import '../audio/sfx.dart';
import '../models/updates.dart';
import 'theme.dart';

String _mb(num b) => '${(b / 1e6).toStringAsFixed(b < 10e6 ? 1 : 0)} MB';

Future<void> showModelUpdate(BuildContext context, ModelUpdates updates, List<ModelRelease> list) async {
  Sfx.I.ui('request');
  await showModalBottomSheet<void>(context: context, isScrollControlled: true, builder: (_) => _Sheet(updates: updates, list: list));
}

class _Sheet extends StatefulWidget {
  const _Sheet({required this.updates, required this.list});
  final ModelUpdates updates;
  final List<ModelRelease> list;
  @override
  State<_Sheet> createState() => _SheetState();
}

class _SheetState extends State<_Sheet> {
  bool _done = false, _tried = false;

  Future<void> _go() async {
    setState(() => _tried = true);
    final ok = await widget.updates.install(widget.updates.due.where((r) => widget.list.any((l) => l.id == r.id)).toList());
    if (ok) Sfx.I.ui('done');
    if (mounted) setState(() => _done = ok);
  }

  void _put(bool forever) {
    widget.updates.snooze(widget.list, forever: forever);
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: widget.updates,
        builder: (context, _) {
          final u = widget.updates, busy = u.running != null, p = u.progress, total = widget.list.fold(0, (a, r) => a + r.bytes);
          final failed = _tried && !busy && !_done;
          return SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 18),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(
                  _done ? 'Updated' : busy ? 'Updating' : failed ? 'The update did not finish' : widget.list.length > 1 ? 'Better AI models are ready' : 'A better ${widget.list.first.title.toLowerCase()} is ready',
                  style: AtcType.title.copyWith(fontSize: 20),
                ),
                const SizedBox(height: 12),
                if (_done)
                  const Text('Your next shift uses the new version.', style: AtcType.body)
                else if (busy) ...[
                  ClipRRect(borderRadius: BorderRadius.circular(4), child: LinearProgressIndicator(value: p?.fraction, minHeight: 8, backgroundColor: AtcColors.raise2, color: AtcColors.accent)),
                  const SizedBox(height: 8),
                  Text('${u.running!.title}${p == null ? '' : ' · ${_mb(p.done)} of ${_mb(p.total)}'}', style: AtcType.bodyMuted),
                  const Text('You can close this: the old one works until it is done.', style: AtcType.bodyMuted),
                ] else if (failed) ...[
                  const Text('Your current model still works. Check the connection and try again: it goes on from where it stopped.', style: AtcType.body),
                  if (u.error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(u.error!, maxLines: 2, overflow: TextOverflow.ellipsis, style: AtcType.bodyMuted)),
                ] else
                  for (final r in widget.list)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [
                          Expanded(child: Text(r.title, style: AtcType.body.copyWith(fontWeight: FontWeight.w700))),
                          Text(_mb(r.bytes), style: AtcType.data.copyWith(fontSize: 13, color: AtcColors.muted)),
                        ]),
                        for (final n in r.notes) Text(n, style: AtcType.bodyMuted),
                      ]),
                    ),
                const SizedBox(height: 14),
                if (_done || busy)
                  OutlinedButton(onPressed: () => Navigator.pop(context), child: Text(_done ? 'Done' : 'Close'))
                else ...[
                  FilledButton(onPressed: _go, child: Text(failed ? 'Try again' : 'Update (${_mb(total)})')),
                  const SizedBox(height: 8),
                  Row(children: [
                    Expanded(child: OutlinedButton(onPressed: () => _put(false), child: const Text('Later'))),
                    const SizedBox(width: 10),
                    Expanded(child: TextButton(onPressed: () => _put(true), child: const Text('Skip this version'))),
                  ]),
                  if (total > 20e6) const Padding(padding: EdgeInsets.only(top: 6), child: Text('Best on Wi-Fi.', textAlign: TextAlign.center, style: AtcType.bodyMuted)),
                ],
              ]),
            ),
          );
        },
      );
}
