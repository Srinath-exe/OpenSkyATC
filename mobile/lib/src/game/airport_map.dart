// The map: Mapbox Standard (3D buildings, light presets) with the game's layers on top, as the web game's Mapbox
// view draws them (src/components/atc/MapboxMap/layers.ts): aeroway surfaces, taxiway lines and names, stands,
// runway numbers, holds, ground routes; the traffic as the baked 3D fleet (one GLB per type and livery) in a model
// layer, placed, turned, pitched and banked per aircraft from GeoJSON properties; callsign labels at altitude.
//
// Model frame (measured with Mapbox GL headless, same style spec as the native SDK): rotation [0,0,0] points the
// nose west and z turns clockwise, so rotation = [bank, -pitch, heading + 90]. Origin = nose wheel on the ground.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'dart:ui' as ui;
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart';

import '../audio/soundscape.dart' as snd;
import '../core/models.dart';
import '../ui/theme.dart';
import 'airports.dart';
import 'fleet.dart';
import 'game_controller.dart';

const _fontB = ['DIN Pro Bold', 'Arial Unicode MS Bold'];
const _fontM = ['DIN Pro Medium', 'Arial Unicode MS Regular'];

/// A width in metres at the airport's latitude, as a zoom expression (line widths are in pixels).
List<Object> _metresAt(double m, double lat) {
  final k = 156543 * math.cos(lat * math.pi / 180);
  return ['interpolate', ['exponential', 2], ['zoom'], 10, m / (k / 1024), 22, m / (k / 4194304)];
}

/// The real ground (assets/airports/ICAO.ground.json, from the web's public/maps/ground): what is what, and its colour at night.
const _groundFill = {
  'site': '#4a4f4b', 'landside': '#43464b', 'deck': '#6f6c66', 'grass': '#3d5a38', 'parking': '#4f5256', 'apron': '#d9d6d0', 'piers': '#6f6c66',
};

/// How much larger the fleet draws at the widest zoom (13) than up close (15.5 and in).
const _far = 2.2;

/// The camera limits round the airfield: its centre may go this far (m) past the taxiways, and out to this zoom, so
/// the whole field and its corners fit on screen with the dock below.
const _margin = 2000.0, _minZoom = 12.3;

class AirportMapController {
  _AirportMapState? _s;
  void flyToAirport() => _s?._flyHome();
  void flyToApproach() => _s?._flyApproach();
  void flyTopDown() => _s?._flyTopDown();
  void follow(int id) => _s?._follow(id);
  bool get following => _s?._followId != null;
}

class AirportMap extends StatefulWidget {
  const AirportMap({super.key, required this.game, required this.fleet, this.controller, this.onTapAircraft});
  final GameController game;
  final Fleet fleet;
  final AirportMapController? controller;
  final void Function(int? id)? onTapAircraft;

  @override
  State<AirportMap> createState() => _AirportMapState();
}

class _AirportMapState extends State<AirportMap> {
  MapboxMap? _map;
  bool _styled = false;

  /// The cover over the map lifts once the airfield is drawn (the first idle after the layers are in; never later than 6 s).
  bool _shown = false;
  void _reveal() {
    if (!_shown && mounted) setState(() => _shown = true);
  }

  StreamSubscription<SimFrame>? _frameSub;
  StreamSubscription<List<Map<String, dynamic>>>? _cueSub;
  final Map<String, Map<String, Object?>> _cueRoutes = {}, _cueMarks = {};
  final List<List<Map<String, dynamic>>> _cueBacklog = [];
  String _anchorKey = '';
  String _routesJson = '';
  final Set<String> _models = {};
  final Set<String> _pending = {};
  bool _busy = false;
  SimFrame? _latest;
  int? _followId;
  String _light = '';
  DateTime _lightCheckedAt = DateTime(2000);
  List<num> _center = const [-122.379, 37.6213];
  double _bearing = 298;
  int _version = 0;
  List<Object> _metres(double m) => _metresAt(m, _center[1].toDouble());

  @override
  void initState() {
    super.initState();
    widget.controller?._s = this;
    widget.game.addListener(_onGame);
    final c = widget.game.airport?['center'];
    if (c is List && c.length == 2) _center = [c[0] as num, c[1] as num];
    _aim();
    _cueSub = widget.game.cues.listen((c) => unawaited(_applyCues(c)));
    _frameSub = widget.game.frames.listen((f) {
      _latest = f;
      unawaited(_push());
    });
  }

  @override
  void dispose() {
    widget.game.removeListener(_onGame);
    _frameSub?.cancel();
    _cueSub?.cancel();
    widget.controller?._s = null;
    super.dispose();
  }

  /// The opening camera: up the longest runway the way it is in use, over the middle of the field.
  void _aim() {
    final ap = widget.game.airport;
    if (ap == null) return;
    _version = widget.game.airportVersion;
    if (ap['bearing'] is num) _bearing = (ap['bearing'] as num).toDouble();
    if (widget.game.icao != 'KSFO') {
      final b = _airportBounds();
      _center = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    }
  }

  /// How far out the whole field fits (SFO: 14): the field's larger side against SFO's.
  double get _fit {
    if (widget.game.icao == 'KSFO') return 14;
    final b = _airportBounds(), kx = 111320 * math.cos((b[1] + b[3]) / 2 * math.pi / 180);
    final m = math.max((b[2] - b[0]) * kx, (b[3] - b[1]) * 111320) - 2 * _margin;
    return (14 - math.log(m / 4200) / math.ln2 * 0.7).clamp(_minZoom, 14.5);
  }

  /// [west, south, east, north] of the taxiway and runway network, 400 m round it.
  List<double> _airportBounds() {
    var w = double.infinity, so = double.infinity, e = -double.infinity, n = -double.infinity;
    final ap = widget.game.airport;
    for (final key in ['taxi', 'rwyc']) {
      for (final f in ((ap?[key] as Map?)?['features'] as List?) ?? const []) {
        for (final c in ((f as Map)['geometry'] as Map)['coordinates'] as List) {
          final lng = ((c as List)[0] as num).toDouble(), lat = (c[1] as num).toDouble();
          w = math.min(w, lng); e = math.max(e, lng); so = math.min(so, lat); n = math.max(n, lat);
        }
      }
    }
    if (!w.isFinite) return [_center[0] - 0.03, _center[1] - 0.025, _center[0] + 0.03, _center[1] + 0.025].map((v) => v.toDouble()).toList();
    final dLat = _margin / 111320, dLng = _margin / (111320 * math.cos((so + n) / 2 * math.pi / 180));
    return [w - dLng, so - dLat, e + dLng, n + dLat];
  }

  /// The board covers the bottom of the screen: the camera centres what it looks at in the part above it.
  MbxEdgeInsets get _pad {
    final h = mounted ? MediaQuery.sizeOf(context).height : 800.0;
    return MbxEdgeInsets(top: 70, left: 0, bottom: h * 0.38, right: 0);
  }

  CameraOptions get _home => CameraOptions(center: Point(coordinates: Position(_center[0], _center[1])), zoom: _fit, pitch: 50, bearing: _bearing, padding: _pad);

  void _flyHome() {
    _followId = null;
    _map?.flyTo(_home, MapAnimationOptions(duration: 1200));
  }

  /// Straight down, north-ish up the runways: the whole field at once, like a chart.
  void _flyTopDown() {
    _followId = null;
    _map?.flyTo(CameraOptions(center: Point(coordinates: Position(_center[0], _center[1])), zoom: _fit - 0.4, pitch: 0, bearing: _bearing, padding: _pad), MapAnimationOptions(duration: 900));
  }

  void _flyApproach() {
    _followId = null;
    _map?.flyTo(CameraOptions(center: Point(coordinates: Position(_center[0], _center[1])), zoom: 9.6, pitch: 45, bearing: _bearing), MapAnimationOptions(duration: 1400));
  }

  /// Picking a flight glides the camera to it and keeps it there. The view stays as the player set it (pitch, bearing:
  /// top-down stays top-down, 3D stays 3D); the zoom only closes in when it is too far out to see the aircraft.
  /// A flight in the air is miles out, beyond the airport: the camera shows the runway it is landing on instead (a
  /// departure that has left, the airfield), and does not follow it.
  Future<void> _follow(int id) async {
    final map = _map;
    final a = _latest?.aircraft.where((x) => x.id == id).firstOrNull;
    if (map == null || a == null) return;
    final now = (await map.getCameraState()).zoom;
    _gliding = DateTime.now().add(const Duration(milliseconds: 750));
    if (!a.onGround) {
      _followId = null;
      final end = a.runway == null ? null : _runwayEnd(a.runway!);
      await map.easeTo(
        CameraOptions(center: Point(coordinates: Position(end?[0] ?? _center[0], end?[1] ?? _center[1])), zoom: now < 14.2 ? 14.2 : null, padding: _pad),
        MapAnimationOptions(duration: 700),
      );
      return;
    }
    _followId = id;
    await map.easeTo(
      CameraOptions(center: Point(coordinates: Position(a.lng, a.lat)), zoom: now < 15 ? 15 : null, padding: _pad),
      MapAnimationOptions(duration: 700),
    );
  }

  /// The leader line's picture: a thin upright line with a dot where it meets the aircraft (drawn here, 3x).
  Future<void> _addStalk(StyleManager st) async {
    const k = 3.0, w = 8.0, h = 34.0;
    final rec = ui.PictureRecorder();
    final c = Canvas(rec);
    c.drawLine(const Offset(w * k / 2, 3 * k), Offset(w * k / 2, (h - 3) * k), Paint()
      ..color = const Color(0xE6FFFFFF)
      ..strokeWidth = 1.2 * k);
    c.drawCircle(Offset(w * k / 2, (h - 3) * k), 2.6 * k, Paint()..color = const Color(0xFFFFFFFF));
    final img = await rec.endRecording().toImage((w * k).round(), (h * k).round());
    final png = (await img.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
    try {
      await st.addStyleImage('stalk', k, MbxImage(width: (w * k).round(), height: (h * k).round(), data: png), false, [], [], null);
    } catch (e) {
      debugPrint('stalk: $e');
    }
  }

  /// Where a runway end's threshold is ([lng, lat]), from the airport's runway labels.
  List<double>? _runwayEnd(String name) {
    final fs = ((widget.game.airport?['rwyLabels'] as Map?)?['features'] as List?) ?? const [];
    for (final f in fs.cast<Map>()) {
      if ((f['properties'] as Map)['name'] == name) return ((f['geometry'] as Map)['coordinates'] as List).map((v) => (v as num).toDouble()).toList();
    }
    return null;
  }

  /// While the glide to a picked flight runs, the per-frame follow leaves the camera alone (it cut the glide short).
  DateTime _gliding = DateTime(0);

  bool _styleLoaded = false, _settingUp = false;

  /// The style loaded: set up the game's layers once the airport is known too (the core boots on its own thread and
  /// can finish after the style; the setup used to give up then, leaving a day map with no airport and no traffic).
  Future<void> _onStyle(StyleLoadedEventData _) async {
    _styleLoaded = true;
    if (mounted) setState(() {});
    await _setup();
  }

  void _onGame() {
    if (_styleLoaded && !_styled && widget.game.airport != null) unawaited(_setup());
    if (_styled && widget.game.airportVersion != _version) unawaited(_relabel());
  }

  /// The names again on a map that is up (real / simple switched).
  Future<void> _relabel() async {
    final map = _map, ap = widget.game.airport;
    if (map == null || ap == null) return;
    _version = widget.game.airportVersion;
    for (final id in ['taxi', 'stands', 'twyLabels']) {
      try {
        await map.style.setStyleSourceProperty('ap-$id', 'data', jsonEncode(ap[id]));
      } catch (e) {
        debugPrint('relabel $id: $e');
      }
    }
  }

  Future<void> _setup() async {
    final map = _map;
    final ap = widget.game.airport;
    if (map == null || ap == null || _styled || _settingUp) return;
    _settingUp = true;
    final c = ap['center'];
    if (c is List && c.length == 2) _center = [c[0] as num, c[1] as num];
    _aim();
    unawaited(map.setCamera(_home).catchError((Object _) {}));
    final b = _airportBounds();
    unawaited(map.setBounds(CameraBoundsOptions(
      bounds: CoordinateBounds(southwest: Point(coordinates: Position(b[0], b[1])), northeast: Point(coordinates: Position(b[2], b[3])), infiniteBounds: false),
      minZoom: _minZoom, maxZoom: 19.5, maxPitch: 60,
    )).catchError((Object _) {}));
    final st = map.style;
    for (final kv in {'showPointOfInterestLabels': false, 'showTransitLabels': false, 'show3dObjects': true, 'show3dBuildings': false, 'show3dLandmarks': false}.entries) {
      try {
        await st.setStyleImportConfigProperty('basemap', kv.key, kv.value);
      } catch (e) {
        debugPrint('config ${kv.key}: $e');
      }
    }
    await _applyLight(force: true);
    String fc(Object? v) => jsonEncode(v ?? {'type': 'FeatureCollection', 'features': []});
    for (final id in ['taxi', 'lead', 'stands', 'rwyLabels', 'holds', 'twyLabels', 'rwyc']) {
      await st.addStyleSource('ap-$id', jsonEncode({'type': 'geojson', 'data': ap[id]}));
    }
    for (final id in ['ac', 'parked', 'routes']) {
      await st.addStyleSource(id, jsonEncode({'type': 'geojson', 'data': jsonDecode(fc(null))}));
    }
    await st.addStyleSource('ap-streets', jsonEncode({'type': 'vector', 'url': 'mapbox://mapbox.mapbox-streets-v8'}));
    Future<bool> layer(Map<String, Object?> l) async {
      try {
        await st.addStyleLayer(jsonEncode(l), null);
        return true;
      } catch (e) {
        debugPrint('layer ${l['id']}: $e');
        return false;
      }
    }

    // aeroway surfaces (Mapbox Streets) and the game's centrelines, as the web map
    Map<String, Object?> surf(String id, String kind, String color, String geom, [double width = 0]) => geom == 'Polygon'
        ? {'id': id, 'type': 'fill', 'source': 'ap-streets', 'source-layer': 'aeroway', 'slot': 'bottom', 'filter': ['all', ['==', ['get', 'type'], kind], ['==', ['geometry-type'], 'Polygon']], 'paint': {'fill-color': color, 'fill-emissive-strength': 0.35}}
        : {'id': id, 'type': 'line', 'source': 'ap-streets', 'source-layer': 'aeroway', 'slot': 'bottom', 'filter': ['all', ['==', ['get', 'type'], kind], ['==', ['geometry-type'], 'LineString']], 'layout': {'line-cap': 'round', 'line-join': 'round'}, 'paint': {'line-color': color, 'line-width': _metres(width), 'line-emissive-strength': 0.35}};
    // the land, grass and aprons as mapped, under everything else; without the file, the basemap's aprons
    String? ground;
    try {
      ground = await rootBundle.loadString('assets/airports/${widget.game.icao}.ground.json', cache: false);
    } catch (_) {/* none for this airport */}
    if (ground != null) {
      await st.addStyleSource('ap-ground', jsonEncode({'type': 'geojson', 'data': jsonDecode(ground)}));
      for (final k in _groundFill.entries) {
        await layer({'id': 'ap-ground-${k.key}', 'type': 'fill', 'source': 'ap-ground', 'slot': 'bottom', 'filter': ['==', ['get', 'k'], k.key], 'paint': {'fill-color': k.value, 'fill-emissive-strength': 0.35}});
      }
    } else {
      await layer(surf('ap-apron', 'apron', '#d9d6d0', 'Polygon'));
    }
    await layer(surf('ap-twy-poly', 'taxiway', '#3b3d42', 'Polygon'));
    await layer(surf('ap-twy-line', 'taxiway', '#3b3d42', 'LineString', 23));
    await layer(surf('ap-rwy-poly', 'runway', '#2c2e32', 'Polygon'));
    await layer(surf('ap-rwy-line', 'runway', '#2c2e32', 'LineString', 60));
    await layer({'id': 'ap-rwy-centre', 'type': 'line', 'source': 'ap-rwyc', 'slot': 'bottom', 'minzoom': 14, 'paint': {'line-color': '#f4f4f4', 'line-width': _metres(0.9), 'line-dasharray': [12, 8], 'line-emissive-strength': 0.6}});
    await layer({'id': 'ap-rwy-edge', 'type': 'line', 'source': 'ap-rwyc', 'slot': 'bottom', 'minzoom': 14, 'paint': {'line-color': '#f4f4f4', 'line-width': _metres(1), 'line-gap-width': _metres(44), 'line-emissive-strength': 0.6}});
    await layer({'id': 'ap-taxi', 'type': 'line', 'source': 'ap-taxi', 'slot': 'middle', 'paint': {'line-color': '#f2c230', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 1.5, 15, 2, 18, 3.6], 'line-opacity': 0.95, 'line-emissive-strength': 1}});
    await layer({'id': 'ap-lead', 'type': 'line', 'source': 'ap-lead', 'slot': 'middle', 'minzoom': 15, 'paint': {'line-color': '#f2c230', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 15, 0.4, 18, 1.8], 'line-opacity': 0.8, 'line-emissive-strength': 1}});
    await layer({'id': 'ap-holds', 'type': 'circle', 'source': 'ap-holds', 'slot': 'middle', 'minzoom': 16, 'paint': {'circle-color': '#e8443a', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 18, 4], 'circle-emissive-strength': 1}});
    // ground routes: cyan to a runway, magenta to a stand, white for a push; the selected one bright and wide
    final routeColor = ['match', ['get', 'kind'], 'stand', '#ff4fd2', 'push', '#f2f4f7', '#22d6ff'];
    List<Object> sel(num on, num off) => ['case', ['==', ['get', 'sel'], 1], on, off];
    await layer({'id': 'g-route-glow', 'type': 'line', 'source': 'routes', 'slot': 'top', 'filter': ['==', ['get', 'sel'], 1], 'layout': {'line-cap': 'round', 'line-join': 'round'}, 'paint': {'line-color': routeColor, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, 3, 18, 14], 'line-opacity': 0.3, 'line-blur': 2, 'line-emissive-strength': 1}});
    await layer({'id': 'g-route', 'type': 'line', 'source': 'routes', 'slot': 'top', 'layout': {'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sel']}, 'paint': {'line-color': routeColor, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 13, sel(1.6, 0.9), 18, sel(5, 2.6)], 'line-opacity': sel(1, 0.6), 'line-emissive-strength': 1}});
    await layer({'id': 'ap-twy', 'type': 'symbol', 'source': 'ap-twyLabels', 'slot': 'top', 'minzoom': 12, 'layout': {'text-field': ['get', 'name'], 'symbol-sort-key': ['-', 0, ['get', 'near']], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 16, 12, 18, 13.5], 'text-font': _fontB, 'text-padding': 4}, 'paint': {'text-color': '#151515', 'text-halo-color': '#f2c230', 'text-halo-width': 2.2, 'text-emissive-strength': 1}});
    await layer({'id': 'ap-stands', 'type': 'symbol', 'source': 'ap-stands', 'slot': 'top', 'minzoom': 15.2, 'maxzoom': 16.8, 'layout': {'text-field': ['get', 'ref'], 'text-size': ['interpolate', ['linear'], ['zoom'], 15.2, 9, 18, 13], 'text-font': _fontB, 'text-padding': 2, 'text-offset': [0, -1.2]}, 'paint': {'text-color': '#1a1200', 'text-halo-color': '#f6b632', 'text-halo-width': 3, 'text-emissive-strength': 1}});
    await layer({'id': 'ap-rwy', 'type': 'symbol', 'source': 'ap-rwyLabels', 'slot': 'top', 'layout': {'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 17, 18], 'text-font': _fontB, 'text-allow-overlap': true}, 'paint': {'text-color': '#ffffff', 'text-halo-color': '#111', 'text-halo-width': 2, 'text-emissive-strength': 1}});
    // the buildings, ours at every zoom: the basemap's 3D buildings and landmark models are off (its SFO terminal model
    // loads from about 14.5 but blanks the buildings under it from 14, so the terminal vanished in between)
    await layer({
      'id': 'ap-buildings', 'type': 'fill-extrusion', 'source': 'ap-streets', 'source-layer': 'building',
      'filter': ['==', ['get', 'extrude'], 'true'],
      'paint': {
        'fill-extrusion-color': '#565b66', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'min_height'],
        'fill-extrusion-opacity': 0.95, 'fill-extrusion-emissive-strength': 0.35, 'fill-extrusion-ambient-occlusion-intensity': 0.3,
      },
    });
    // traffic: the baked fleet; far out a dot so the arrivals still show at approach zoom
    final model = {
      'model-rotation': ['array', 'number', 3, ['get', 'rot']],
      // zoomed out to the whole field the fleet grows (up to _far x at the widest zoom) so it never shrinks to specks
      'model-scale': ['interpolate', ['linear'], ['zoom'], 13, ['array', 'number', 3, ['get', 'sf']], 15.5, ['array', 'number', 3, ['get', 'sc']]],
      'model-translation': ['array', 'number', 3, ['get', 'tr']],
      'model-type': 'common-3d',
      'model-cast-shadows': true,
      'model-receive-shadows': true,
      'model-emissive-strength': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 0.2],
    };
    // the picked aircraft is the highlight itself: lit as if in daylight (its own light, full strength) against the
    // night field, no ring round it
    final picked = ['==', ['get', 'sel'], 1];
    final lit = {...model, 'model-emissive-strength': ['interpolate', ['linear'], ['zoom'], 12, ['case', picked, 1.0, 0.6], 16, ['case', picked, 0.85, 0.2]]};
    await layer({'id': 'parked-models', 'type': 'model', 'source': 'parked', 'layout': {'model-id': ['get', 'm']}, 'paint': model});
    if (!await layer({'id': 'ac-models', 'type': 'model', 'source': 'ac', 'minzoom': 11.5, 'layout': {'model-id': ['get', 'm']}, 'paint': lit})) {
      await layer({'id': 'ac-models', 'type': 'model', 'source': 'ac', 'minzoom': 11.5, 'layout': {'model-id': ['get', 'm']}, 'paint': model});
    }
    await layer({'id': 'ac-dot', 'type': 'circle', 'source': 'ac', 'slot': 'top', 'maxzoom': 12.5, 'paint': {'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 12.5, 5], 'circle-color': ['case', ['==', ['get', 'sel'], 1], '#ff8a1f', ['==', ['get', 'emg'], 1], '#ff4a3a', ['==', ['get', 'req'], 1], '#ffd23f', '#ffffff'], 'circle-stroke-color': '#0b0d10', 'circle-stroke-width': 1.5, 'circle-pitch-alignment': 'map', 'circle-emissive-strength': 1}});
    await _addStalk(st);
    await layer({
      'id': 'ac-label', 'type': 'symbol', 'source': 'ac', 'slot': 'top',
      'layout': {
        'text-field': ['format', ['get', 'cs'], {'font-scale': 1.0}, '\n', {}, ['get', 'sub'], {'font-scale': 0.82, 'text-font': ['literal', _fontM]}],
        'text-font': _fontB, 'text-size': 12, 'text-anchor': 'bottom', 'text-justify': 'center', 'text-offset': [0, -3.0],
        'text-allow-overlap': true, 'text-ignore-placement': true, 'symbol-sort-key': ['get', 'rank'],
        // a leader line up from the aircraft to its name, upright on screen however the map is tilted
        'icon-image': 'stalk', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
      },
      'paint': {
        'symbol-z-offset': ['get', 'alt'],
        'icon-opacity': ['case', picked, 1.0, ['==', ['get', 'mine'], 1], 0.7, 0.4], 'icon-emissive-strength': 1,
        'text-color': ['case', ['==', ['get', 'sel'], 1], '#ffb15c', ['==', ['get', 'emg'], 1], '#ff6a5c', ['==', ['get', 'req'], 1], '#ffe07a', ['==', ['get', 'mine'], 1], '#ffffff', 'rgba(255,255,255,0.62)'],
        'text-halo-color': 'rgba(10,14,22,0.92)', 'text-halo-width': 3.5, 'text-emissive-strength': 1,
      },
    });
    // the tutorial's cues: lit routes, marks with a label, and a ring on what the card is about
    for (final id in ['cue-routes', 'cue-marks', 'cue-anchor']) {
      await st.addStyleSource(id, jsonEncode({'type': 'geojson', 'data': {'type': 'FeatureCollection', 'features': []}}));
    }
    await layer({'id': 'cue-route-glow', 'type': 'line', 'source': 'cue-routes', 'slot': 'top', 'layout': {'line-cap': 'round', 'line-join': 'round'}, 'paint': {'line-color': ['get', 'color'], 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 6, 18, 26], 'line-opacity': 0.28, 'line-blur': 3, 'line-emissive-strength': 1}});
    await layer({'id': 'cue-route', 'type': 'line', 'source': 'cue-routes', 'slot': 'top', 'layout': {'line-cap': 'round', 'line-join': 'round'}, 'paint': {'line-color': ['get', 'color'], 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 2.5, 18, 9], 'line-opacity': 0.95, 'line-emissive-strength': 1}});
    await layer({'id': 'cue-mark', 'type': 'circle', 'source': 'cue-marks', 'slot': 'top', 'paint': {'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 12, 6, 18, 28], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3, 'circle-stroke-color': ['match', ['get', 'tone'], 'stop', '#ff4a3a', 'go', '#3bea7a', '#ffffff'], 'circle-pitch-alignment': 'map', 'circle-emissive-strength': 1}});
    await layer({'id': 'cue-mark-label', 'type': 'symbol', 'source': 'cue-marks', 'slot': 'top', 'layout': {'text-field': ['get', 'label'], 'text-font': _fontB, 'text-size': 14, 'text-offset': [0, -2.0], 'text-allow-overlap': true, 'text-ignore-placement': true}, 'paint': {'text-color': '#ffffff', 'text-halo-color': 'rgba(10,14,22,0.92)', 'text-halo-width': 4, 'text-emissive-strength': 1}});
    await layer({'id': 'cue-anchor', 'type': 'circle', 'source': 'cue-anchor', 'slot': 'top', 'paint': {'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 11, 10, 18, 52], 'circle-color': 'rgba(245,147,63,0.12)', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#f5933f', 'circle-pitch-alignment': 'map', 'circle-emissive-strength': 1}});
    _styled = true;
    Timer(const Duration(seconds: 6), _reveal);
    if (mounted) setState(() {});   // the cover says what it is waiting for
    for (final c in _cueBacklog) {
      await _applyCues(c);
    }
    _cueBacklog.clear();
    widget.game.parkedChanged = true;
    unawaited(_push());
  }

  Future<void> _applyLight({bool force = false}) async {
    final map = _map;
    if (map == null) return;
    final now = DateTime.now();
    if (!force && now.difference(_lightCheckedAt).inSeconds < 20) return;
    _lightCheckedAt = now;
    const want = 'night';   // the game is always played at night (the user's call): lit aprons, runway lights, dark ground
    if (want == _light) return;
    _light = want;
    try {
      await map.style.setStyleImportConfigProperty('basemap', 'lightPreset', want);
    } catch (e) {
      debugPrint('lightPreset: $e');
    }
    try {
      final imports = await map.style.getStyleImports();
      debugPrint('style imports: ${imports.map((i) => i?.id).join(',')}');
    } catch (e) {
      debugPrint('imports: $e');
    }
  }

  /// Register a fleet GLB with the style the first time an aircraft wears it.
  /// Mapbox reads models from a URI and does not see Flutter's asset bundle the same way on every platform, so the
  /// GLB is copied to app storage once (Fleet.localFile) and given as a file:// URI.
  void _need(String file) {
    if (_models.contains(file) || _pending.contains(file)) return;
    _pending.add(file);
    widget.fleet
        .localFile(file)
        .then((path) => _map?.style.addStyleModel(Fleet.modelId(file), Uri.file(path).toString()))
        .then((_) => _models.add(file), onError: (Object e) {
          debugPrint('model $file: $e');
          return false;
        })
        .whenComplete(() => _pending.remove(file));
  }

  Map<String, Object?> _feature(Map<String, Object?> props, num lng, num lat) => {
        'type': 'Feature',
        'properties': props,
        'geometry': {'type': 'Point', 'coordinates': [lng, lat]},
      };

  String _sub(SimAircraft a) {
    if (a.onGround) return a.knots > 3 ? '${a.type} · ${a.knots} kt' : a.type;
    final alt = a.flightLevel >= 180 ? 'FL${a.flightLevel.toString().padLeft(3, '0')}' : '${(a.flightLevel * 100).toString()} ft';
    return '$alt · ${a.knots} kt';
  }

  Future<void> _push() async {
    final map = _map, f = _latest;
    if (map == null || f == null || !_styled || _busy) return;
    _busy = true;
    try {
      final fleet = widget.fleet;
      final ac = <Object?>[];
      for (final a in f.aircraft) {
        final file = fleet.fileFor(a.type, a.airline, a.lengthM);
        _need(file);
        final s = fleet.scaleFor(file, a.lengthM);
        ac.add(_feature({
          'id': a.id, 'm': Fleet.modelId(file), 'rot': [a.bank, -a.pitch, (a.heading + 90) % 360], 'sc': [s, s, s], 'sf': [s * _far, s * _far, s * _far], 'tr': [0, 0, a.altM],
          'alt': a.altM, 'cs': a.callsign, 'sub': _sub(a), 'sel': a.selected ? 1 : 0, 'mine': a.mine ? 1 : 0, 'req': a.request ? 1 : 0, 'emg': a.emergency ? 1 : 0,
          'rank': a.selected ? 0 : a.emergency ? 1 : a.request ? 2 : a.mine ? 3 : 4,
        }, a.lng, a.lat));
      }
      await map.style.setStyleSourceProperty('ac', 'data', jsonEncode({'type': 'FeatureCollection', 'features': ac}));
      final routes = [
        for (final r in f.routes)
          {'type': 'Feature', 'properties': {'kind': r.kind, 'sel': r.selected ? 1 : 0}, 'geometry': {'type': 'LineString', 'coordinates': r.coords}},
      ];
      final rj = jsonEncode({'type': 'FeatureCollection', 'features': routes});
      if (rj != _routesJson) {   // routes change only when a clearance is given or an aircraft moves along one
        _routesJson = rj;
        await map.style.setStyleSourceProperty('routes', 'data', rj);
      }
      if (widget.game.parkedChanged) {
        widget.game.parkedChanged = false;
        final pk = <Object?>[];
        for (final p in widget.game.parked) {
          final file = fleet.fileFor(p.type, p.airline, p.lengthM);
          _need(file);
          final s = fleet.scaleFor(file, p.lengthM);
          pk.add(_feature({'m': Fleet.modelId(file), 'rot': [0, 0, (p.heading + 90) % 360], 'sc': [s, s, s], 'sf': [s * _far, s * _far, s * _far], 'tr': [0, 0, 0]}, p.lng, p.lat));
        }
        await map.style.setStyleSourceProperty('parked', 'data', jsonEncode({'type': 'FeatureCollection', 'features': pk}));
      }
      final fid = _followId;
      if (fid != null) {
        final a = f.aircraft.where((x) => x.id == fid).firstOrNull;
        if (a == null) {
          _followId = null;
        } else if (DateTime.now().isAfter(_gliding)) {
          await map.setCamera(CameraOptions(center: Point(coordinates: Position(a.lng, a.lat))));
        }
      }
      await _pushAnchor();
      unawaited(_applyLight());
    } catch (e) {
      debugPrint('map push: $e');
    } finally {
      _busy = false;
    }
  }

  /// The course's cues (mobile/core/course.ts): routes and marks by id, 'clear' (one id or all), camera moves.
  Future<void> _applyCues(List<Map<String, dynamic>> list) async {
    final map = _map;
    if (map == null || !_styled) {
      _cueBacklog.add(list);
      return;
    }
    var routes = false, marks = false;
    for (final c in list) {
      switch (c['kind']) {
        case 'clear':
          final id = c['id'] as String?;
          if (id == null) {
            _cueRoutes.clear();
            _cueMarks.clear();
          } else {
            _cueRoutes.remove(id);
            _cueMarks.remove(id);
          }
          routes = marks = true;
        case 'route':
          _cueRoutes[c['id'] as String] = {'type': 'Feature', 'properties': {'color': c['color'] ?? '#3bea7a'}, 'geometry': {'type': 'LineString', 'coordinates': c['c']}};
          routes = true;
        case 'mark':
          _cueMarks[c['id'] as String] = {'type': 'Feature', 'properties': {'label': c['label'] ?? '', 'tone': c['tone'] ?? 'info'}, 'geometry': {'type': 'Point', 'coordinates': c['at']}};
          marks = true;
        case 'camera':
          _cueCamera(c);
      }
    }
    try {
      if (routes) await map.style.setStyleSourceProperty('cue-routes', 'data', jsonEncode({'type': 'FeatureCollection', 'features': _cueRoutes.values.toList()}));
      if (marks) await map.style.setStyleSourceProperty('cue-marks', 'data', jsonEncode({'type': 'FeatureCollection', 'features': _cueMarks.values.toList()}));
    } catch (e) {
      debugPrint('cues: $e');
    }
  }

  /// The web course's 3D camera (distance to the target, yaw = -heading, pitch = elevation above the horizon) as a
  /// Mapbox camera: zoom so that the distance fills the phone's narrow side, the card's height kept clear at the bottom.
  void _cueCamera(Map<String, dynamic> c) {
    final map = _map;
    if (map == null || !mounted) return;
    final at = (c['at'] as List).cast<num>();
    final size = MediaQuery.sizeOf(context);
    final cardH = size.height * 0.42;
    final visible = math.min(size.width, size.height - cardH);
    final dist = (c['dist'] as num).toDouble();
    final mpp = 0.667 * dist / visible;
    final zoom = (math.log(40075016 * math.cos(at[1] * math.pi / 180) / (512 * mpp)) / math.ln2).clamp(9.0, 18.5);
    final pitchRad = (c['pitch'] as num?)?.toDouble();
    final yaw = (c['yaw'] as num?)?.toDouble();
    _followId = c['follow'] as int?;
    map.flyTo(
      CameraOptions(
        center: Point(coordinates: Position(at[0], at[1])),
        zoom: zoom,
        bearing: yaw == null ? null : (-yaw * 180 / math.pi) % 360,
        pitch: pitchRad == null ? null : (90 - pitchRad * 180 / math.pi).clamp(0.0, 78.0),
        padding: MbxEdgeInsets(top: 60, left: 0, bottom: cardH, right: 0),
      ),
      MapAnimationOptions(duration: ((c['ms'] as num?) ?? 1600).toInt()),
    );
  }

  /// The ring on what the course card is about (a place, or the aircraft the call is to).
  Future<void> _pushAnchor() async {
    final map = _map;
    final a = widget.game.courseState?['anchor'] as Map<String, dynamic>?;
    final at = a == null || a['at'] == null ? null : (a['at'] as List);
    final key = at == null ? '' : '${at[0]},${at[1]}';
    if (map == null || key == _anchorKey) return;
    _anchorKey = key;
    final fc = {'type': 'FeatureCollection', 'features': [if (at != null) {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Point', 'coordinates': at}}]};
    await map.style.setStyleSourceProperty('cue-anchor', 'data', jsonEncode(fc));
  }

  Future<void> _onTap(MapContentGestureContext ctx) async {
    final map = _map, f = _latest;
    if (map == null || f == null || f.aircraft.isEmpty) return;
    final pts = [for (final a in f.aircraft) Point(coordinates: Position(a.lng, a.lat))];
    final px = await map.pixelsForCoordinates(pts);
    final t = ctx.touchPosition;
    var best = -1;
    var bestD = 44.0;
    for (var i = 0; i < px.length; i++) {
      final q = px[i];
      if (q == null) continue;
      final d = math.sqrt(math.pow(q.x - t.x, 2) + math.pow(q.y - t.y, 2));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    widget.onTapAircraft?.call(best >= 0 ? f.aircraft[best].id : null);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(fit: StackFit.expand, children: [
      _mapWidget(),
      IgnorePointer(
        ignoring: _shown,
        child: AnimatedOpacity(
          opacity: _shown ? 0 : 1,
          duration: const Duration(milliseconds: 600),
          curve: Curves.easeOut,
          child: _MapCover(icao: widget.game.icao, step: !_styleLoaded ? 'Loading the map' : !_styled ? 'Laying out the airfield' : 'Bringing in the traffic'),
        ),
      ),
    ]);
  }

  Widget _mapWidget() {
    return MapWidget(
      key: const ValueKey('airport-map'),
      styleUri: MapboxStyles.STANDARD,
      cameraOptions: _home,
      onMapCreated: (m) {
        _map = m;
        m.scaleBar.updateSettings(ScaleBarSettings(enabled: false));
        m.compass.updateSettings(CompassSettings(position: OrnamentPosition.TOP_LEFT, marginTop: 128, marginLeft: 14));   // clear of the view buttons on the right
        m.attribution.updateSettings(AttributionSettings(marginBottom: 150));
        m.logo.updateSettings(LogoSettings(marginBottom: 150));
        // touch: no rotating by accident while pinching, pinch and pan together, double-tap / one-finger quick zoom,
        // two-finger drag tilts; the camera stays over the bay area and never tilts to the horizon
        m.gestures.updateSettings(GesturesSettings(
          rotateEnabled: true,
          pitchEnabled: true,
          simultaneousRotateAndPinchToZoomEnabled: false,
          increaseRotateThresholdWhenPinchingToZoom: true,
          pinchPanEnabled: true,
          doubleTapToZoomInEnabled: true,
          doubleTouchToZoomOutEnabled: true,
          quickZoomEnabled: true,
          scrollDecelerationEnabled: true,
          pinchToZoomDecelerationEnabled: true,
          rotateDecelerationEnabled: false,
        ));
        // locked to the airport (the taxiway network plus _margin round it, out to _minZoom), tilted at most 60 degrees
        final b = _airportBounds();
        m.setBounds(CameraBoundsOptions(
          bounds: CoordinateBounds(southwest: Point(coordinates: Position(b[0], b[1])), northeast: Point(coordinates: Position(b[2], b[3])), infiniteBounds: false),
          minZoom: _minZoom,
          maxZoom: 19.5,
          maxPitch: 60,
        ));
      },
      onStyleLoadedListener: _onStyle,
      // ignore: deprecated_member_use
      onTapListener: _onTap,
      // any hand on the map ends following the selected aircraft (it used to pull the camera back mid-pinch)
      onScrollListener: (_) => _followId = null,
      onZoomListener: (_) => _followId = null,
      // the ear follows the camera
      onCameraChangeListener: (d) {
        final c = d.cameraState, p = c.center.coordinates;
        widget.game.ear = snd.Ear.fromCamera(lng: p.lng.toDouble(), lat: p.lat.toDouble(), zoom: c.zoom, bearing: c.bearing, pitch: c.pitch, heightPx: mounted ? MediaQuery.sizeOf(context).height : 800);
      },
      onMapIdleListener: (_) {
        if (_styled) _reveal();
      },
    );
  }
}

/// What shows while the map loads, instead of the bare basemap flashing in day light: the airport, a running bar, and
/// what it is doing.
class _MapCover extends StatefulWidget {
  const _MapCover({required this.icao, required this.step});
  final String icao, step;
  @override
  State<_MapCover> createState() => _MapCoverState();
}

class _MapCoverState extends State<_MapCover> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 4200))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: AtcColors.bg,
      child: Center(
        child: SizedBox(
          width: 288,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            RepaintBoundary(
              child: SizedBox(
                width: 288,
                height: 160,
                child: AnimatedBuilder(animation: _c, builder: (context, _) => CustomPaint(painter: _PixelLanding(_c.value))),
              ),
            ),
            const SizedBox(height: 22),
            Text(widget.icao, style: AtcType.callsign.copyWith(fontSize: 30, letterSpacing: 1)),
            const SizedBox(height: 2),
            Text(airportOf(widget.icao).name, style: AtcType.bodyMuted),
            const SizedBox(height: 14),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 200),
              child: Text(widget.step.toUpperCase(), key: ValueKey(widget.step), style: AtcType.data.copyWith(fontSize: 12, letterSpacing: 1.2, color: AtcColors.accent)),
            ),
          ]),
        ),
      ),
    );
  }
}

/// The loader: a pixel-art night landing on a loop. 72 x 40 pixels of 4 points each: stars, the approach lights'
/// running strobe, the runway edge lights, and a jet on the glide path that flares, touches down and rolls out.
class _PixelLanding extends CustomPainter {
  _PixelLanding(this.t);
  final double t;

  static const _w = 72, _h = 40;
  static const _plane = [
    'W...............',
    'WW..............',
    'WWWWWWWWWWWWWW..',
    'WooooooooooooWW.',
    '.WWWWWWWWWWWWWWW',
    '.....gggg.......',
  ];
  static const _stars = [(3, 4), (11, 9), (17, 2), (26, 6), (33, 12), (41, 3), (49, 8), (57, 4), (64, 11), (69, 2), (8, 15), (22, 17), (37, 19), (53, 16), (61, 20), (30, 1), (45, 14), (14, 21)];
  static const _runwayY = 30, _thr = 26;

  @override
  void paint(Canvas c, ui.Size size) {
    final k = size.width / _w;
    final p = Paint();
    void px(int x, int y, Color col) {
      if (x < 0 || x >= _w || y < 0 || y >= _h) return;
      c.drawRect(Rect.fromLTWH(x * k, y * k, k, k), p..color = col);
    }

    // stars, a few twinkling
    for (var i = 0; i < _stars.length; i++) {
      final (x, y) = _stars[i];
      final tw = (math.sin((t * 2 + i * 0.37) * math.pi * 2) + 1) / 2;
      px(x, y, Color.fromRGBO(255, 255, 255, i % 3 == 0 ? 0.2 + 0.6 * tw : 0.35));
    }
    // the ground and the runway, its edge lights, and the approach lights' strobe running in to the threshold
    for (var x = 0; x < _w; x++) {
      for (var y = _runwayY + 2; y < _h; y++) {
        px(x, y, const Color(0xFF101114));
      }
    }
    for (var x = _thr; x < _w; x++) {
      px(x, _runwayY + 1, const Color(0xFF2A2B2E));
      if ((x - _thr) % 4 == 1) px(x, _runwayY + 1, const Color(0xFF5A5C62));
      if ((x - _thr) % 6 == 0) px(x, _runwayY, const Color(0xFFFFD58A));
    }
    px(_thr, _runwayY, AtcColors.good);
    final rabbit = ((t * 8) % 1 * 10).floor();
    for (var i = 0; i < 10; i++) {
      final x = _thr - 22 + i * 2;
      px(x, _runwayY + 1, i == rabbit ? const Color(0xFFFFFFFF) : const Color(0x55FFFFFF));
    }

    // the jet: down the glide path, a flare, touchdown at the threshold, then the roll-out slowing
    double x, y;
    if (t < 0.62) {
      final a = t / 0.62;
      x = -18 + (_thr + 2 + 18) * a;
      final flare = a > 0.85 ? (a - 0.85) / 0.15 : 0.0;
      y = 2 + (_runwayY - 6 - 2) * a - 1.5 * math.sin(flare * math.pi / 2) * (1 - flare);
    } else {
      final a = (t - 0.62) / 0.38;
      x = _thr + 2 + 34 * (1 - (1 - a) * (1 - a));
      y = (_runwayY - 6).toDouble();
    }
    final ox = x.floor(), oy = y.round();
    for (var r = 0; r < _plane.length; r++) {
      for (var col = 0; col < _plane[r].length; col++) {
        final ch = _plane[r][col];
        if (ch == '.') continue;
        px(ox + col, oy + r, ch == 'o' ? AtcColors.accent : ch == 'g' ? const Color(0xFF8A8D93) : const Color(0xFFECECEE));
      }
    }
    // the tail strobe and the belly beacon
    if ((t * 6) % 1 < 0.18) px(ox, oy - 1, const Color(0xFFFFFFFF));
    if ((t * 3) % 1 < 0.5) px(ox + 8, oy + 5, AtcColors.bad);
    // landing light ahead of it on the way down
    if (t < 0.62) px(ox + 16, oy + 4, const Color(0xFFFFF2C0));
  }

  @override
  bool shouldRepaint(_PixelLanding o) => o.t != t;
}
