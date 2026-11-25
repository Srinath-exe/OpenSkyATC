import * as React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { InfoPage } from '../_lib/InfoPage';
import { JsonLd } from '../_lib/JsonLd';
import { SocialLinks } from '../_lib/SocialLinks';
import { HF_URL, MAKER, RELEASES_URL, REPO_URL } from '../_lib/site';

export const metadata: Metadata = { title: 'About', description: 'OpenATC is a free air traffic control simulator in the browser: six real airports, real phraseology, your voice, and an AI on the other seat.', alternates: { canonical: '/about' } };

const FAQ: Array<[string, string]> = [
  ['Is it free?', 'Yes. No account, no ads, nothing to buy.'],
  ['Do I need to install anything?', 'No. It runs in the browser on a computer. A recent Chrome or Edge works best; Safari and Firefox work too. Phones can open it too; on Android the app is the better way.'],
  ['Do I need to know air traffic control?', 'No. The tutorial takes about ten minutes, and in every shift the flight cards show the next call to make.'],
  ['Do I have to talk?', 'No. Hold Space and speak, or type the same call, or click the one on the card.'],
  ['Is it live traffic?', 'No. The airports are real, the flights are made up by the game.'],
  ['Which airports can I play?', 'San Francisco (SFO), New York JFK, Paris Charles de Gaulle, Dubai, Singapore Changi and Tokyo Haneda.'],
  ['Where does my voice go?', 'To our server while you speak, where it is turned into text and not kept; or nowhere, if you download the model to your device.'],
  ['Can I use it to train for the real thing?', 'No. It is a game: procedures are simplified and can be wrong.'],
];

export default function AboutPage() {
  return (
    <InfoPage testId="page-about" title="About OpenATC" lead="You are the controller. Aircraft call, you answer, they do what you said. Six real airports, in a browser tab.">
      <JsonLd data={{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }} />
      <h2>How a shift works</h2>
      <p>Pick an airport and a seat. <strong>Tower</strong> runs the gates, the taxiways and the runways: push back, taxi, line up, take off, land, taxi in. <strong>Approach</strong> runs the sky around it: turn arrivals on to the final, keep them apart, climb departures out. The AI works the other seat, and you can swap at any time.</p>
      <p>You say it the way a controller would, or close to it. The pilots read it back, question what does not make sense, and fly what you said, including your mistakes.</p>
      <h2>The airports are the real ones</h2>
      <p>Runways, taxiways, hold lines and stands come from OpenStreetMap, and every stand was checked with the aircraft that use it: can it park, push back and taxi out. <Link href="/airports">See the airports</Link>.</p>
      <h2>How the traffic is kept apart</h2>
      <p>Arrivals are lined up the way approach units do it: the order is set early, speed is used before distance, and each aircraft stays a thousand feet above the one ahead until it is on the beam. We test changes by running whole shifts without a screen: before launch, 4,500 sessions with more than 22,000 landings.</p>
      <h2>The voice runs on small models</h2>
      <p>Hearing you, understanding you and speaking for the pilots takes three small models, two of them made for this game. There is no large language model in it. The code is <a href={REPO_URL} target="_blank" rel="noopener noreferrer">on GitHub</a> and the models are <a href={HF_URL} target="_blank" rel="noopener noreferrer">on Hugging Face</a>.</p>
      <h2 id="app">On your phone</h2>
      <p>There is a native Android app, made for holding upright, that hears you without the internet. It is not in an app store: download the APK from <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">the newest release on GitHub</a> and allow your phone to install it. It needs Android 7 or newer on a 64-bit phone. There is no iPhone app; the site opens in Safari.</p>
      <h2 id="maker">Who makes it</h2>
      <p>{MAKER}: the game, the models and the app. Follow for what comes next.</p>
      <SocialLinks names />
      <h2 id="faq">Questions</h2>
      {FAQ.map(([q, a]) => <React.Fragment key={q}><h3>{q}</h3><p>{a}</p></React.Fragment>)}
      <p>Anything else? <Link href="/contact">Ask us</Link>.</p>
    </InfoPage>
  );
}
