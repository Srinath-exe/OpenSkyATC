import type { Metadata } from 'next';
import Link from 'next/link';
import { InfoPage } from '../_lib/InfoPage';
import { LEGAL_DATE, MAKER, REPO_URL } from '../_lib/site';

export const metadata: Metadata = { title: 'Terms', description: 'The terms for playing OpenATC: it is a game, it is free, and it is not for real-world aviation.', alternates: { canonical: '/terms' } };

export default function TermsPage() {
  return (
    <InfoPage testId="page-terms" title="Terms" lead="OpenATC is a game, and it is free. Play it, share it, break it and tell us. Never use it for real aviation.">
      <p>Last changed {LEGAL_DATE}. OpenATC is run by {MAKER}. By playing on this site or in the OpenATC app you agree to these terms.</p>

      <h2>It is a game</h2>
      <p><strong>Not for real-world use.</strong> Maps, procedures, phraseology, weather and traffic are simplified, can be wrong or out of date, and must not be used to navigate, to control traffic, to train for a licence, or to make any decision about real aircraft. The traffic is made up by the game; it is not live data.</p>
      <p>OpenATC is not affiliated with, or endorsed by, any airport, airline, aircraft maker, air navigation service or authority. Their names and marks belong to them.</p>

      <h2>What you may do</h2>
      <ul>
        <li>Play for free, as much as you like.</li>
        <li>Stream it, record it and publish your videos, also when you earn money from them. A link back is welcome.</li>
        <li>Use the code under its own licence from <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>. Models, maps and media have their own licences; see <Link href="/credits">Credits</Link>.</li>
      </ul>

      <h2>What we ask</h2>
      <ul>
        <li>Do not attack, overload or scrape the site, or use its speech service for anything but the game.</li>
        <li>Do not send anything illegal, abusive or private to other people through the report tool or the contact form.</li>
        <li>Do not pass OpenATC off as your own service or as something official.</li>
      </ul>
      <p>We may block people who do these things.</p>

      <h2>What you send us</h2>
      <p>You keep the rights to your reports and messages. You let us use them to fix and improve the game.</p>

      <h2>No guarantee</h2>
      <p>OpenATC comes as it is. It may be down, change, lose your scores or stop, and features may come and go. As far as the law allows, we give no warranty and are not liable for loss or damage from using it. Nothing here limits rights that the law says cannot be limited, or your rights as a consumer.</p>

      <h2>Changes</h2>
      <p>We may change these terms; the date at the top shows when. Playing on after a change means you accept it. Questions: <Link href="/contact">contact us</Link>.</p>
    </InfoPage>
  );
}
