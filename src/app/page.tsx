import type { Metadata } from 'next';
import Landing from './landing/Landing';
import { JsonLd } from './_lib/JsonLd';
import { CONTACT_EMAIL, DESCRIPTION, HF_URL, MAKER, MAKER_URL, REPO_URL, SOCIALS, SITE_NAME, SITE_URL, TAGLINE } from './_lib/site';

// The front door is the film (landing/Landing.tsx); "Play" goes on to /start, where the shift is set up.
export const metadata: Metadata = { title: { absolute: `${SITE_NAME}: ${TAGLINE}` }, description: DESCRIPTION, alternates: { canonical: '/' } };

export default function Home() {
  return (
    <>
      <JsonLd data={{ '@context': 'https://schema.org', '@graph': [
        { '@type': 'WebSite', '@id': `${SITE_URL}/#site`, url: SITE_URL, name: SITE_NAME, description: DESCRIPTION, inLanguage: 'en' },
        { '@type': 'Organization', '@id': `${SITE_URL}/#org`, name: SITE_NAME, url: SITE_URL, logo: `${SITE_URL}/brand/openatc-icon-512.png`, email: CONTACT_EMAIL, sameAs: [REPO_URL, HF_URL] },
        { '@type': ['VideoGame', 'WebApplication'], name: SITE_NAME, url: SITE_URL, description: DESCRIPTION, image: `${SITE_URL}/og.jpg`, genre: ['Simulation', 'Air traffic control'], gamePlatform: ['Web browser', 'Android'], operatingSystem: 'Any', applicationCategory: 'GameApplication', playMode: 'SinglePlayer', inLanguage: 'en', isAccessibleForFree: true, author: { '@type': 'Person', name: MAKER, url: MAKER_URL, sameAs: SOCIALS.filter((l) => l.key !== 'mail' && l.key !== 'site').map((l) => l.href) }, publisher: { '@id': `${SITE_URL}/#org` }, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
      ] }} />
      <Landing />
    </>
  );
}
