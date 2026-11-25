// What the core returns (mobile/core/core.ts frame() / ui()), as Dart types.

double _d(Object? v) => (v as num?)?.toDouble() ?? 0;
int _i(Object? v) => (v as num?)?.toInt() ?? 0;
bool _b(Object? v) => v == true || v == 1;

class SimAircraft {
  SimAircraft.fromJson(Map<String, dynamic> j)
      : id = _i(j['id']),
        callsign = j['cs'] as String,
        lng = _d(j['lng']),
        lat = _d(j['lat']),
        altM = _d(j['alt']),
        heading = _d(j['hdg']),
        pitch = _d(j['pitch']),
        bank = _d(j['bank']),
        type = j['type'] as String,
        airline = j['al'] as String,
        lengthM = _d(j['len']),
        onGround = _b(j['gnd']),
        phase = j['ph'] as String? ?? '',
        runway = j['rwy'] as String?,
        knots = _i(j['kt']),
        flightLevel = _i(j['fl']),
        mine = _b(j['mine']),
        request = _b(j['req']),
        emergency = _b(j['emg']),
        selected = _b(j['sel']);
  final int id;
  final String callsign;
  final double lng, lat, altM, heading, pitch, bank, lengthM;
  final String type, airline, phase;

  /// An arrival's landing runway (null for departures).
  final String? runway;
  final bool onGround, mine, request, emergency, selected;
  final int knots, flightLevel;
}

class ParkedAircraft {
  ParkedAircraft.fromJson(Map<String, dynamic> j)
      : id = _i(j['id']),
        callsign = j['cs'] as String,
        lng = _d(j['lng']),
        lat = _d(j['lat']),
        heading = _d(j['hdg']),
        type = j['type'] as String,
        airline = j['al'] as String,
        lengthM = _d(j['len']);
  final int id;
  final String callsign, type, airline;
  final double lng, lat, heading, lengthM;
}

class GroundRoute {
  GroundRoute.fromJson(Map<String, dynamic> j)
      : id = _i(j['id']),
        kind = j['kind'] as String,
        selected = _b(j['sel']),
        coords = (j['c'] as List).map((p) => [(p as List)[0] as num, p[1] as num]).toList();
  final int id;
  final String kind;
  final bool selected;
  final List<List<num>> coords;
}

class SimFrame {
  SimFrame.fromJson(Map<String, dynamic> j)
      : time = _d(j['t']),
        wallMs = _d(j['wall']),
        selected = j['sel'] == null ? null : _i(j['sel']),
        aircraft = ((j['ac'] as List?) ?? const []).map((e) => SimAircraft.fromJson(e as Map<String, dynamic>)).toList(),
        routes = ((j['routes'] as List?) ?? const []).map((e) => GroundRoute.fromJson(e as Map<String, dynamic>)).toList(),
        parked = (j['parked'] as List?)?.map((e) => ParkedAircraft.fromJson(e as Map<String, dynamic>)).toList();
  final double time, wallMs;
  final int? selected;
  final List<SimAircraft> aircraft;
  final List<GroundRoute> routes;

  /// Only when the parked population changed since the last frame.
  final List<ParkedAircraft>? parked;
}

class FinalInfo {
  FinalInfo.fromJson(Map<String, dynamic> j) : runway = j['rwy'] as String, nm = _d(j['nm']), seconds = _i(j['sec']);
  final String runway;
  final double nm;
  final int seconds;
}

class BoardRow {
  BoardRow.fromJson(Map<String, dynamic> j)
      : id = _i(j['id']),
        callsign = j['cs'] as String,
        type = j['type'] as String,
        airline = j['al'] as String,
        mid = j['mid'] as String,
        request = _b(j['req']),
        sched = _d(j['sched']),
        est = _d(j['est']),
        tone = j['tone'] as String,
        lateMin = _i(j['late']),
        fin = j['fin'] == null ? null : FinalInfo.fromJson(j['fin'] as Map<String, dynamic>),
        mine = _b(j['mine']),
        emergency = _b(j['emg']);
  final int id, lateMin;
  final String callsign, type, airline, mid, tone;
  final bool request, mine, emergency;
  final double sched, est;
  final FinalInfo? fin;
}

class RadioLine {
  RadioLine.fromJson(Map<String, dynamic> j)
      : key = _i(j['k']),
        who = j['who'] as String,
        aiPos = j['ai'] as String?,
        text = j['text'] as String,
        at = _i(j['at']),
        callsign = j['cs'] as String?,
        position = j['pos'] as String?,
        status = j['st'] as String?;
  final int key, at;
  final String who, text;
  final String? aiPos, callsign, position, status;
}

class FlightCardData {
  FlightCardData.fromJson(Map<String, dynamic> j)
      : id = _i(j['id']),
        callsign = j['cs'] as String,
        airlineName = j['airline'] as String? ?? '',
        model = j['model'] as String? ?? '',
        type = j['type'] as String,
        airline = j['al'] as String,
        stage = j['stage'] as String,
        tone = j['tone'] as String,
        from = (j['route'] as Map)['from'] as String,
        fromCity = (j['route'] as Map)['fromCity'] as String,
        to = (j['route'] as Map)['to'] as String,
        toCity = (j['route'] as Map)['toCity'] as String,
        departure = (j['route'] as Map)['dep'] == true,
        sched = _d(j['sched']),
        est = _d(j['est']),
        actual = j['actual'] == null ? null : _d(j['actual']),
        label = j['label'] as String,
        timeTone = j['timeTone'] as String,
        lateMin = _i(j['late']),
        fin = j['fin'] == null ? null : FinalInfo.fromJson(j['fin'] as Map<String, dynamic>),
        altFt = _i(j['alt']),
        knots = _i(j['kt']),
        airborne = _b(j['air']),
        stand = '${j['stand']}',
        runway = '${j['rwy']}',
        squawk = '${j['squawk']}',
        mine = _b(j['mine']),
        nextCmd = (j['next'] as Map)['cmd'] as String?,
        nextSay = (j['next'] as Map)['say'] as String?,
        nextWhy = (j['next'] as Map)['why'] as String?,
        nextWait = (j['next'] as Map)['wait'] as String?,
        lines = (j['lines'] as List).map((e) => RadioLine.fromJson(e as Map<String, dynamic>)).toList();
  final int id, lateMin, altFt, knots;
  final String callsign, airlineName, model, type, airline, stage, tone, from, fromCity, to, toCity, label, timeTone, stand, runway, squawk;
  final bool departure, airborne, mine;
  final double sched, est;
  final double? actual;
  final FinalInfo? fin;
  final String? nextCmd, nextSay, nextWhy, nextWait;
  final List<RadioLine> lines;
}

class SoundEvent {
  SoundEvent.fromJson(Map<String, dynamic> j)
      : kind = j['kind'] as String,
        text = j['text'] as String?,
        who = j['who'] as String?,
        callsign = j['callsign'] as String?,
        cue = j['cue'] as String?,
        severity = j['severity'] as String?;
  final String kind;
  final String? text, who, callsign, cue, severity;
}

class Toast {
  Toast.fromJson(Map<String, dynamic> j) : key = _i(j['k']), kind = j['kind'] as String, text = j['text'] as String;
  final int key;
  final String kind, text;
}

class AlertItem {
  AlertItem.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        severity = j['sev'] as String,
        title = j['title'] as String,
        detail = j['detail'] as String? ?? '',
        who = ((j['who'] as List?) ?? const []).cast<String>();
  final String id, severity, title, detail;
  final List<String> who;
}

class Score {
  Score.fromJson(Map<String, dynamic> j) : points = _i(j['points']), skill = _i(j['skill']), movements = _i(j['movements']), departures = _i(j['deps']), arrivals = _i(j['arrs']);
  final int points, skill, movements, departures, arrivals;
}

class UiState {
  UiState.fromJson(Map<String, dynamic> j)
      : time = _d(j['t']),
        wallMs = _d(j['wall']),
        position = j['position'] as String? ?? 'tower',
        paused = j['paused'] == true,
        rate = _i(j['rate']),
        departures = (((j['board'] as Map?)?['deps'] as List?) ?? const []).map((e) => BoardRow.fromJson(e as Map<String, dynamic>)).toList(),
        arrivals = (((j['board'] as Map?)?['arrs'] as List?) ?? const []).map((e) => BoardRow.fromJson(e as Map<String, dynamic>)).toList(),
        card = j['card'] == null ? null : FlightCardData.fromJson(j['card'] as Map<String, dynamic>),
        radio = ((j['radio'] as List?) ?? const []).map((e) => RadioLine.fromJson(e as Map<String, dynamic>)).toList(),
        toasts = ((j['toasts'] as List?) ?? const []).map((e) => Toast.fromJson(e as Map<String, dynamic>)).toList(),
        alerts = ((j['alerts'] as List?) ?? const []).map((e) => AlertItem.fromJson(e as Map<String, dynamic>)).toList(),
        score = j['score'] == null ? null : Score.fromJson(j['score'] as Map<String, dynamic>),
        names = j['names'] as String? ?? 'real',
        depRunways = ((j['inUse'] as Map?)?['dep'] as List? ?? const []).cast<String>(),
        arrRunways = ((j['inUse'] as Map?)?['arr'] as List? ?? const []).cast<String>(),
        highScore = _i(j['high']),
        sounds = ((j['sounds'] as List?) ?? const []).map((e) => SoundEvent.fromJson(e as Map<String, dynamic>)).toList();
  final double time, wallMs;
  final String position;
  final bool paused;
  final int rate, highScore;

  /// Which taxiway and stand names are on ('real' / 'simple'); the map's labels follow it.
  final String names;
  final List<String> depRunways, arrRunways;
  final List<BoardRow> departures, arrivals;
  final FlightCardData? card;

  /// New since the previous ui() call.
  final List<RadioLine> radio;
  final List<Toast> toasts;
  final List<AlertItem> alerts;
  final Score? score;
  final List<SoundEvent> sounds;
}

/// One thing wrong with a call that did not work: the words, what is wrong with them, and the call put right.
class CallFault {
  CallFault.fromJson(Map<String, dynamic> j)
      : title = j['title'] as String? ?? '',
        text = j['text'] as String? ?? '',
        fixes = [for (final f in (j['fixes'] as List? ?? const [])) ((f as Map)['label'] as String, f['call'] as String)];
  final String title, text;

  /// (what the button says, the whole call to send)
  final List<(String, String)> fixes;
  static List<CallFault> list(Object? v) => [for (final f in (v as List? ?? const [])) CallFault.fromJson(f as Map<String, dynamic>)];
}

/// A runway end in the runway sheet (core runways()).
class RunwayEnd {
  RunwayEnd.fromJson(Map<String, dynamic> j)
      : name = j['name'] as String,
        ref = j['ref'] as String,
        dep = j['dep'] == true,
        arr = j['arr'] == true,
        head = _i(j['head']),
        cross = _i(j['cross']),
        open = j['open'] == true,
        status = j['status'] as String? ?? '';
  final String name, ref, status;
  final bool dep, arr, open;
  final int head, cross;
}

class RunwaysState {
  RunwaysState.fromJson(Map<String, dynamic> j)
      : ends = [for (final r in (j['rows'] as List)) RunwayEnd.fromJson(r as Map<String, dynamic>)],
        wind = j['wind'] == null ? null : (_i((j['wind'] as Map)['dir']), _i((j['wind'] as Map)['kts']));
  final List<RunwayEnd> ends;
  final (int, int)? wind;
}

class CommandOutcome {
  const CommandOutcome({required this.ok, required this.sent, required this.line, this.heard, this.error, this.sayAgain = false, this.faults = const []});

  /// What exactly was wrong with it (empty when it worked, or there is nothing to add).
  final List<CallFault> faults;
  final bool ok, sent, sayAgain;
  final String line;
  final String? heard, error;
}
