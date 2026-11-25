import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InfoPage } from '../../_lib/InfoPage';
import { JsonLd } from '../../_lib/JsonLd';
import { AIRPORT_PAGES, airportPage } from '../../_lib/airportPages';
import { SITE_URL } from '../../_lib/site';

export const dynamicParams = false;
export const generateStaticParams = () => AIRPORT_PAGES.map((a) => ({ code: a.code }));
type P = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const a = airportPage((await params).code); if (!a) return {};
  const title = `${a.name} (${a.meta.iata}) air traffic control game`, description = `Be the controller at ${a.name}: ${a.runways.length} runways, real taxiways and stands, real phraseology, by voice. Free in your browser.`;
  return { title, description, alternates: { canonical: `/airports/${a.code}` }, openGraph: { title: `Control ${a.name} in OpenATC`, description, url: `/airports/${a.code}`, images: ['/og.jpg'] } };
}

export default async function AirportInfo({ params }: P) {
  const a = airportPage((await params).code); if (!a) notFound();
  return (
    <InfoPage testId="page-airport" title={`${a.name}`} lead={`${a.meta.city}, ${a.meta.region}. ${a.meta.iata} to passengers, ${a.meta.icao} on the radio.`}>
      <JsonLd data={{ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Airports', item: `${SITE_URL}/airports` }, { '@type': 'ListItem', position: 2, name: a.name, item: `${SITE_URL}/airports/${a.code}` }] }} />
      {a.what.map((p) => <p key={p}>{p}</p>)}
      <p><Link href={`/play?icao=${a.meta.icao}`}>Start a shift at {a.meta.iata}</Link> or <Link href="/learn">take the tutorial first</Link>.</p>
      <h2>Runways</h2>
      <table><thead><tr><th>Runway</th><th>Metres</th><th>Feet</th></tr></thead><tbody>{a.runways.map((r) => <tr key={r.ref}><td>{r.ref}</td><td>{r.m.toLocaleString('en')} m</td><td>{r.ft.toLocaleString('en')} ft</td></tr>)}</tbody></table>
      <h2>A tip</h2>
      <p>{a.tip}</p>
      <h2>Other airports</h2>
      <ul>{AIRPORT_PAGES.filter((o) => o !== a).map((o) => <li key={o.code}><Link href={`/airports/${o.code}`}>{o.name}</Link></li>)}</ul>
      <p>Layout © OpenStreetMap contributors. Not for real-world navigation. <Link href="/credits">All credits</Link>.</p>
    </InfoPage>
  );
}
