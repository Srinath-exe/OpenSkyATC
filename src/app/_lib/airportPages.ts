import { AIRPORT_BY_ICAO, LAUNCH_AIRPORTS, runwaysOf, type AirportMeta } from './airports';

/** What each airport's page says, beside the numbers from its map. */
const TEXT: Record<string, { name: string; what: string[]; tip: string }> = {
  KSFO: { name: 'San Francisco International', what: ['Two pairs of close parallel runways cross in the middle of the field. Arrivals come in over the bay to 28 Left and Right while departures leave across them on 1 Left and Right, so every take-off waits for a gap in the landings.', 'It is the airport the tutorial is set at, and the best one to start with.'], tip: 'Watch the crossing: hold a departure on 1R until the landing on 28R is through the intersection.' },
  KJFK: { name: 'New York John F. Kennedy', what: ['Two pairs of parallel runways at right angles, terminals round a ring of taxiways, and long taxi routes between them.', 'Heavies all day: wake spacing behind a 777 or an A380 decides how many you land.'], tip: 'Taxiways A and B run the ring in opposite directions. Use them that way and nobody meets nose to nose.' },
  LFPG: { name: 'Paris Charles de Gaulle', what: ['Four parallel runways in two close pairs, north and south. The outer ones take the landings, the inner ones the take-offs, so nearly every arrival has a runway to cross.', 'The biggest field in the game.'], tip: 'Cross arrivals over the inner runway in the gaps between departures, a few at a time.' },
  OMDB: { name: 'Dubai International', what: ['Two long parallel runways and a fleet of wide-bodies: A380s, 777s and everything that feeds them.', 'One runway lands, the other launches, and the terminals stand between and beside them.'], tip: 'An A380 needs its own room on the taxiways. Give it the outer one and keep the narrow-bodies clear.' },
  WSSS: { name: 'Singapore Changi', what: ['Three parallel runways far apart, with the terminals between the western two.', 'Long rolls, fast exits, and a steady line of arrivals from the sea.'], tip: 'Plan the exit early: which side the aircraft leaves the runway on decides whether it has to cross another.' },
  RJTT: { name: 'Tokyo Haneda', what: ['Four runways in two directions, one of them built out into the bay, and a domestic rush that never stops.', 'The wind decides which pair lands and which pair launches.'], tip: 'Land on one pair, launch from the other, and look at the crossing traffic before every take-off.' },
};
export interface AirportPage { meta: AirportMeta; code: string; name: string; what: string[]; tip: string; runways: Array<{ ref: string; ft: number; m: number }> }
export const AIRPORT_PAGES: AirportPage[] = LAUNCH_AIRPORTS.map((icao) => {
  const meta = AIRPORT_BY_ICAO[icao];
  return { meta, code: meta.iata.toLowerCase(), ...TEXT[icao], runways: runwaysOf(icao).map((r) => ({ ref: `${r.ends[0].name}/${r.ends[1].name}`, ft: r.lengthFt, m: Math.round(r.lengthFt * 0.3048) })) };
});
export const airportPage = (code: string) => AIRPORT_PAGES.find((a) => a.code === code.toLowerCase() || a.meta.icao === code.toUpperCase());
