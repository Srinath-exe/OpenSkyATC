// The web game's visual system (src/design/tokens.css), sharpened for a phone at night: solid surfaces (no glass, the
// map behind must not muddy the text), white text, orange for you / your action, green for AI / OK, red for danger.
// Contrast on bg1: text1 19:1, text2 12:1, text3 7:1 (all above WCAG AA for their sizes).

import 'package:flutter/material.dart';

class AtcColors {
  // surfaces, darkest first
  static const bg = Color(0xFF0B0B0C);        // the app ground
  static const surface = Color(0xFF131315);   // panels: bars, sheets, chips
  static const raise = Color(0xFF1E1E21);     // tiles inside panels, pressed
  static const raise2 = Color(0xFF2A2B2E);    // control tracks, dividers you can see
  static const line = Color(0x24FFFFFF);      // hairlines
  static const lineStrong = Color(0x40FFFFFF);
  // text
  static const text = Color(0xFFFFFFFF);
  static const text2 = Color(0xFFD2D2D4);
  static const muted = Color(0xFFA2A2A7);     // labels, secondary facts
  // roles
  static const accent = Color(0xFFF5933F);    // you: your action, your selection, send
  static const accentInk = Color(0xFF111111); // text on the accent
  static const good = Color(0xFF57CD50);      // AI, live, on time
  static const bad = Color(0xFFFF5A4E);       // danger, emergency, late
  static const warn = Color(0xFFFFC24A);      // wants something, holding
  static const air = Color(0xFF7CB8FF);       // airborne, arrivals
}

class AtcFonts {
  static const sans = 'DMSans';
  static const mono = 'DMMono';
}

/// Type steps used across the app (sizes for a phone held at arm's length, at night).
class AtcType {
  static const tabular = [FontFeature.tabularFigures()];
  static const display = TextStyle(fontFamily: AtcFonts.sans, fontSize: 26, height: 1.05, fontWeight: FontWeight.w800, letterSpacing: -0.4, color: AtcColors.text);
  static const title = TextStyle(fontFamily: AtcFonts.sans, fontSize: 18, height: 1.15, fontWeight: FontWeight.w700, color: AtcColors.text);
  static const body = TextStyle(fontFamily: AtcFonts.sans, fontSize: 15, height: 1.35, fontWeight: FontWeight.w500, color: AtcColors.text);
  static const bodyMuted = TextStyle(fontFamily: AtcFonts.sans, fontSize: 13.5, height: 1.35, fontWeight: FontWeight.w500, color: AtcColors.muted);
  static const label = TextStyle(fontFamily: AtcFonts.sans, fontSize: 12, height: 1.2, fontWeight: FontWeight.w700, letterSpacing: 0.9, color: AtcColors.muted);
  static const data = TextStyle(fontFamily: AtcFonts.mono, fontSize: 14, height: 1.2, fontWeight: FontWeight.w500, color: AtcColors.text, fontFeatures: tabular);
  static const callsign = TextStyle(fontFamily: AtcFonts.mono, fontSize: 15, height: 1.1, fontWeight: FontWeight.w500, letterSpacing: 0.2, color: AtcColors.text);
}

ThemeData atcTheme() {
  final base = ThemeData(brightness: Brightness.dark, useMaterial3: true, colorSchemeSeed: AtcColors.accent, fontFamily: AtcFonts.sans);
  return base.copyWith(
    scaffoldBackgroundColor: AtcColors.bg,
    colorScheme: base.colorScheme.copyWith(primary: AtcColors.accent, onPrimary: AtcColors.accentInk, surface: AtcColors.surface, onSurface: AtcColors.text, secondary: AtcColors.good),
    textTheme: base.textTheme.apply(bodyColor: AtcColors.text, displayColor: AtcColors.text, fontFamily: AtcFonts.sans),
    dividerColor: AtcColors.line,
    textSelectionTheme: const TextSelectionThemeData(cursorColor: AtcColors.accent, selectionColor: Color(0x55F5933F), selectionHandleColor: AtcColors.accent),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AtcColors.accent, foregroundColor: AtcColors.accentInk, minimumSize: const Size(0, 48),
        textStyle: const TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w800, fontSize: 15, letterSpacing: 0.2),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AtcColors.text, minimumSize: const Size(0, 48), side: const BorderSide(color: AtcColors.lineStrong, width: 1.2),
        textStyle: const TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w700, fontSize: 15),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: AtcColors.accent, textStyle: const TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w700, fontSize: 14.5))),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? AtcColors.accentInk : AtcColors.text2),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? AtcColors.accent : AtcColors.raise2),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    bottomSheetTheme: const BottomSheetThemeData(backgroundColor: AtcColors.surface, surfaceTintColor: Colors.transparent, showDragHandle: true, dragHandleColor: AtcColors.lineStrong),
    dialogTheme: const DialogThemeData(backgroundColor: AtcColors.surface, surfaceTintColor: Colors.transparent),
    chipTheme: base.chipTheme.copyWith(backgroundColor: AtcColors.raise, selectedColor: AtcColors.text, side: const BorderSide(color: AtcColors.line), labelStyle: const TextStyle(fontFamily: AtcFonts.sans, fontWeight: FontWeight.w700)),
  );
}
