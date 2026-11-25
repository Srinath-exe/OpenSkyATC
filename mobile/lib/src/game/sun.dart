// The map's light for the sim clock: the sun's elevation at the airport, as the web map does (lightFor in
// src/components/atc/MapboxMap/layers.ts): day above 8 degrees, dawn or dusk down to -5, night below.

import 'dart:math' as math;

({double elevation, double azimuth}) sunPosition(DateTime utc, double lat, double lng) {
  final d = utc.toUtc();
  final day = d.difference(DateTime.utc(d.year)).inMinutes / 1440.0;   // fractional day of the year
  final g = 2 * math.pi / 365 * (day - 1 + (d.hour - 12) / 24);
  final decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g);
  final eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g));
  final tst = d.hour * 60 + d.minute + d.second / 60 + eqt + 4 * lng;   // true solar time, minutes
  final ha = (tst / 4 - 180) * math.pi / 180;
  final phi = lat * math.pi / 180;
  final cosZen = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(ha);
  final zen = math.acos(cosZen.clamp(-1.0, 1.0));
  // from south, west positive; + 180 = from north (afternoon > 180)
  final az = (math.atan2(math.sin(ha), math.cos(ha) * math.sin(phi) - math.tan(decl) * math.cos(phi)) * 180 / math.pi + 180) % 360;
  return (elevation: 90 - zen * 180 / math.pi, azimuth: az);
}

/// Mapbox Standard light preset: 'dawn' | 'day' | 'dusk' | 'night'.
String lightPresetFor(DateTime utc, double lat, double lng) {
  final s = sunPosition(utc, lat, lng);
  if (s.elevation > 8) return 'day';
  if (s.elevation > -5) return s.azimuth < 180 ? 'dawn' : 'dusk';
  return 'night';
}
