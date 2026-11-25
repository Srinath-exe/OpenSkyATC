import type { Metadata } from 'next';
import { InfoPage } from '../_lib/InfoPage';
import { CREDIT_GROUPS } from '../_lib/credits';
import { HF_URL, MAKER, MAKER_URL, REPO_URL } from '../_lib/site';

export const metadata: Metadata = { title: 'Credits', description: 'The maps, aircraft models, voice models, sounds and software OpenATC is built with, and their licences.', alternates: { canonical: '/credits' } };

export default function CreditsPage() {
  return (
    <InfoPage testId="page-credits" title="Credits" lead="OpenATC stands on work other people shared. Here is all of it, with its licence.">
      {CREDIT_GROUPS.map((g) => (
        <section key={g.title}>
          <h2>{g.title}</h2>
          {g.note ? <p>{g.note}</p> : null}
          <table>
            <thead><tr><th>Who</th><th>What</th><th>Licence</th></tr></thead>
            <tbody>{g.items.map((c) => <tr key={c.title}><td>{c.href ? <a href={c.href} {...(c.href.startsWith('/') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{c.title}</a> : c.title}</td><td>{c.what}</td><td>{c.licence}</td></tr>)}</tbody>
          </table>
        </section>
      ))}
      <h2 id="licences">OpenATC itself</h2>
      <p>Made by <a href={MAKER_URL} target="_blank" rel="noopener noreferrer">{MAKER}</a>, and open source:</p>
      <ul>
        <li><strong>Code:</strong> MIT, on <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>.</li>
        <li><strong>Command model:</strong> Apache-2.0, on <a href={HF_URL} target="_blank" rel="noopener noreferrer">Hugging Face</a>.</li>
        <li><strong>Speech model:</strong> CC BY-NC-SA 4.0. It learned partly from recordings (UWB-ATCC, ATCOSIM) that are not for commercial use, so neither is the model.</li>
        <li><strong>Aircraft models:</strong> GNU GPL v2, as above.</li>
        <li><strong>Landing film and tutorial:</strong> © 2026 {MAKER}, all rights reserved.</li>
      </ul>
      <p>Something missing or wrong here? <a href="/contact?topic=credits">Tell us</a> and we will fix it.</p>
    </InfoPage>
  );
}
