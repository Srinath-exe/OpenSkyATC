import type { Metadata } from 'next';
import Link from 'next/link';
import { InfoPage } from '../_lib/InfoPage';
import { CONTACT_EMAIL, LEGAL_DATE, MAKER } from '../_lib/site';

export const metadata: Metadata = { title: 'Privacy', description: 'What OpenATC stores, what it sends, and what it does not: no accounts, no ads, no tracking.', alternates: { canonical: '/privacy' } };

export default function PrivacyPage() {
  return (
    <InfoPage testId="page-privacy" title="Privacy" lead="No account, no ads, no analytics, nothing sold. Your voice is used to understand your call and is not kept.">
      <p>Last changed {LEGAL_DATE}. OpenATC (this site and the OpenATC app) is run by {MAKER}. For anything about your data, use the <Link href="/contact?topic=privacy">contact form</Link> or write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>

      <h2>Your voice</h2>
      <p>The game listens only while you hold the talk key or button, and only after you allow the microphone. You choose in Settings where speech is turned into text:</p>
      <div><table>
        <thead><tr><th>Setting</th><th>Where your voice goes</th><th>Kept?</th></tr></thead>
        <tbody>
          <tr><td>Server (the default until the model is downloaded)</td><td>To the OpenATC server while you speak, encrypted</td><td>No. It is held in memory while it is read, then gone</td></tr>
          <tr><td>This device, or the phone app</td><td>Nowhere. The model runs on your device</td><td>No</td></tr>
          <tr><td>Browser</td><td>To your browser’s maker (Chrome sends it to Google), under their policy</td><td>Not by us</td></tr>
        </tbody>
      </table></div>
      <p>You can also play without a microphone and type.</p>

      <h2>What stays on your device</h2>
      <p>Settings, scores and shift history, the tutorial’s progress and the downloaded voice models are kept in your browser’s storage, not on our server. Clear them in Settings or by clearing this site’s data in your browser.</p>
      <p>The site sets one kind of cookie of its own, and only if you open the report tool: a random number, so that you can see your own reports again. It is not used to follow you.</p>

      <h2>What reaches our server</h2>
      <ul>
        <li><strong>Page requests.</strong> Like any web server, ours logs your IP address, browser, the page and the time. The logs are deleted after about 14 days.</li>
        <li><strong>Crash reports, sent by themselves.</strong> When the game breaks: the error, the page, your browser, screen size and language, the last radio lines of your shift, the words speech recognition heard, and two display settings. No audio and no name. They are kept for as long as they help fix bugs.</li>
        <li><strong>Reports you send.</strong> What you write, record, screenshot or say in the report tool, with the same technical details. You see it before it goes. Recordings, pictures and voice notes are deleted after 90 days. We may use an AI service (Google Gemini) to sort reports; please leave private things out of them.</li>
        <li><strong>Contact form.</strong> Your message, and your email address if you give one so we can answer.</li>
      </ul>

      <p>The phone app sends no crash reports and has no report tool; it only loads the map, and the voice models and their updates from our server.</p>

      <h2>Others involved</h2>
      <p>Your browser or app loads some parts straight from other services. They see your IP address, as any site does:</p>
      <ul>
        <li><strong>Mapbox</strong> draws the 3D map, and collects usage data about the map itself. See the <a href="https://www.mapbox.com/legal/privacy" target="_blank" rel="noopener noreferrer">Mapbox privacy policy</a>.</li>
        <li><strong>jsDelivr</strong> and <strong>Hugging Face</strong> deliver the software and models for speech on your device, if you choose it.</li>
      </ul>

      <h2>Your choices</h2>
      <p>You can ask what we hold about you, or to have it deleted, through the <Link href="/contact?topic=privacy">contact form</Link>. As there are no accounts, tell us when you wrote or the report’s number so we can find it. Where the law gives you more rights (in the EU, the UK, India or California, for example), we respect them, and you may complain to your data protection authority.</p>
      <p>We use the server logs, crash reports and reports to keep the game running and fix it (our legitimate interest); the microphone and anything you send us only with your consent, which you can take back at any time.</p>

      <h2>Children</h2>
      <p>OpenATC is for everyone, but it is not aimed at children under 13 and we do not knowingly collect their data. If a child has sent us something, tell us and we will delete it.</p>

      <h2>Changes</h2>
      <p>If this changes, the date at the top changes, and anything important is said on the site first.</p>
    </InfoPage>
  );
}
