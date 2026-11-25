// About OpenATC on the phone: what it is, the legal pages of the site, and everything made by others with its licence.
// The same list as the site's (src/app/_lib/credits.ts), for what the app uses.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'logo_mark.dart';
import 'theme.dart';

const kSite = 'https://openatc.aeon-labs.site';

Future<void> openLink(BuildContext context, String url) async {
  var ok = false;
  try {
    ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  } catch (_) {/* no browser */}
  if (ok || !context.mounted) return;
  await Clipboard.setData(ClipboardData(text: url));
  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('No browser found. Link copied: $url')));
}

void showAbout(BuildContext context, {required String version}) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AboutScreen(version: version)));

const kEmail = '1406srinath@gmail.com';

// The same list as the site's (SOCIALS in src/app/_lib/site.ts).
const _socials = [
  ('GitHub', 'Srinath-exe', 'https://github.com/Srinath-exe'),
  ('Hugging Face', 'srinath-exe', 'https://huggingface.co/srinath-exe'),
  ('X (Twitter)', '@srinath_exe', 'https://x.com/srinath_exe'),
  ('LinkedIn', 'srinath-exe', 'https://www.linkedin.com/in/srinath-exe'),
  ('Portfolio', 'srinath.aeon-labs.site', 'https://srinath.aeon-labs.site'),
];

const _credits = [
  ('Maps and airport data', [
    ('Mapbox', 'The 3D map', '© Mapbox, Mapbox Terms of Service', 'https://www.mapbox.com/about/maps'),
    ('OpenStreetMap contributors', 'Runways, taxiways, stands and the map underneath', '© OpenStreetMap contributors, ODbL 1.0', 'https://www.openstreetmap.org/copyright'),
    ('Endless ATC', 'The airport file format our airspace files follow', 'Format only', 'https://www.endless-atc.com'),
  ]),
  ('Aircraft', [
    ('FlightGear AI aircraft', 'The aircraft and their liveries, by the FlightGear community (Ian Tolosa, Brett Harrison, Innis Cunningham and many more)', 'GNU GPL v2, source and changes in the notice', '$kSite/models/fleet/NOTICE.txt'),
  ]),
  ('Voice', [
    ('ATC-ASR 110M', 'Hears your radio calls on this phone. Our model, fine-tuned from NVIDIA Parakeet TDT-CTC 110M', 'CC BY-NC-SA 4.0 (non-commercial, from its training data)', 'https://huggingface.co/srinath-exe/skycontrol-atc-asr-110m'),
    ('OpenATC command model', 'Turns what you said into a command. Our model', 'Apache-2.0', 'https://huggingface.co/srinath-exe/skycontrol-atc-command-2m'),
    ('sherpa-onnx', 'Runs the speech model', 'Apache-2.0', 'https://github.com/k2-fsa/sherpa-onnx'),
  ]),
  ('Sounds and type', [
    ('USC Cinema and Sunset Editorial libraries', 'Aircraft engine and wind recordings, from archive.org', 'CC0 1.0', 'https://archive.org/details/Red_Library_Aircraft_Jets'),
    ('Kenney Interface Sounds', 'Button sounds', 'CC0 1.0', 'https://kenney.nl/assets/interface-sounds'),
    ('DM Sans and DM Mono by Colophon Foundry', 'Typefaces', 'SIL Open Font License', 'https://fonts.google.com/specimen/DM+Sans'),
  ]),
];

class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key, required this.version});
  final String version;

  @override
  Widget build(BuildContext context) {
    Widget link(String title, String url, {IconData icon = Icons.open_in_new_rounded}) => _Tap(onTap: () => openLink(context, url), child: Row(children: [Expanded(child: Text(title, style: AtcType.body.copyWith(fontWeight: FontWeight.w700))), Icon(icon, size: 18, color: AtcColors.muted)]));
    return Scaffold(
      appBar: AppBar(backgroundColor: AtcColors.bg, surfaceTintColor: Colors.transparent, title: const Text('About', style: AtcType.title)),
      body: ListView(
        padding: EdgeInsets.fromLTRB(20, 8, 20, 32 + MediaQuery.paddingOf(context).bottom),
        children: [
          Row(children: [
            const LogoMark(size: 34),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('OpenATC', style: AtcType.title.copyWith(fontSize: 22)), Text('Version $version', style: AtcType.bodyMuted)])),
          ]),
          const SizedBox(height: 14),
          const Text('Air traffic control at six real airports, with your voice. Free, no account, no ads.', style: AtcType.body),
          const SizedBox(height: 8),
          const Text('A game, not for real-world navigation or training. Not affiliated with any airport, airline, manufacturer or authority.', style: AtcType.bodyMuted),
          const SizedBox(height: 20),
          const _Head('Your data'),
          const Text('Speech is turned into text on this phone; your voice is not sent anywhere. Settings and scores stay on the phone. The map comes from Mapbox, which collects usage data about the map; models and updates come from our site.', style: AtcType.body),
          const SizedBox(height: 10),
          link('Privacy', '$kSite/privacy'),
          link('Terms', '$kSite/terms'),
          link('Contact and bug reports', '$kSite/contact'),
          link('Questions and answers', '$kSite/about'),
          link('Source on GitHub', 'https://github.com/Srinath-exe/OpenSkyATC'),
          const SizedBox(height: 24),
          const _Head('Made by Srinath H'),
          const Text('Open source: the code is MIT. Follow for what comes next.', style: AtcType.body),
          const SizedBox(height: 6),
          for (final (name, handle, url) in _socials) link('$name  ·  $handle', url),
          link('Email  ·  $kEmail', 'mailto:$kEmail', icon: Icons.mail_outline_rounded),
          for (final (title, items) in _credits) ...[
            const SizedBox(height: 24),
            _Head(title),
            for (final (who, what, licence, url) in items)
              _Tap(
                onTap: () => openLink(context, url),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(who, style: AtcType.body.copyWith(fontWeight: FontWeight.w700)),
                    Text(what, style: AtcType.bodyMuted.copyWith(color: AtcColors.text2)),
                    Text(licence, style: AtcType.bodyMuted),
                  ])),
                  const SizedBox(width: 10),
                  const Padding(padding: EdgeInsets.only(top: 3), child: Icon(Icons.open_in_new_rounded, size: 16, color: AtcColors.muted)),
                ]),
              ),
          ],
          const SizedBox(height: 10),
          const Text('Airline names, logos and liveries, and aircraft names, belong to their owners; they appear only to tell aircraft apart, and no owner endorses OpenATC.', style: AtcType.bodyMuted),
          const SizedBox(height: 24),
          const _Head('Software'),
          _Tap(
            onTap: () => showLicensePage(context: context, applicationName: 'OpenATC', applicationVersion: version),
            child: Row(children: [Expanded(child: Text('Flutter and package licences', style: AtcType.body.copyWith(fontWeight: FontWeight.w700))), const Icon(Icons.chevron_right_rounded, color: AtcColors.muted)]),
          ),
          const SizedBox(height: 16),
          const Text('© 2026 Srinath H', style: AtcType.bodyMuted),
        ],
      ),
    );
  }
}

class _Head extends StatelessWidget {
  const _Head(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(text, style: AtcType.title.copyWith(fontSize: 16)));
}

class _Tap extends StatelessWidget {
  const _Tap({required this.onTap, required this.child});
  final VoidCallback onTap;
  final Widget child;
  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: ConstrainedBox(constraints: const BoxConstraints(minHeight: 48), child: Padding(padding: const EdgeInsets.symmetric(vertical: 11), child: Align(alignment: Alignment.centerLeft, child: child))),
      );
}
