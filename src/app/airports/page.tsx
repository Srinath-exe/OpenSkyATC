import type { Metadata } from 'next';
import Link from 'next/link';
import { InfoPage } from '../_lib/InfoPage';
import { AIRPORT_PAGES } from '../_lib/airportPages';

export const metadata: Metadata = { title: 'Airports', description: 'The airports you can control in OpenATC: San Francisco, New York JFK, Paris, Dubai, Singapore and Tokyo.', alternates: { canonical: '/airports' } };

export default function AirportsPage() {
  return (
    <InfoPage testId="page-airports" title="Airports" lead="Six real fields, each with its own runways, taxiways, stands and airlines.">
      {AIRPORT_PAGES.map((a) => (
        <section key={a.code}>
          <h2><Link href={`/airports/${a.code}`}>{a.name}</Link></h2>
          <p>{a.meta.city}, {a.meta.iata} / {a.meta.icao}. {a.runways.length} runways, the longest {Math.max(...a.runways.map((r) => r.m)).toLocaleString('en')} m. {a.what[0]}</p>
        </section>
      ))}
    </InfoPage>
  );
}
