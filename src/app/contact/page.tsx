import type { Metadata } from 'next';
import * as React from 'react';
import { InfoPage } from '../_lib/InfoPage';
import { CONTACT_EMAIL, REPO_URL } from '../_lib/site';
import { SocialLinks } from '../_lib/SocialLinks';
import { ContactForm } from './ContactForm';

export const metadata: Metadata = { title: 'Contact', description: 'Report a bug, ask a question, or ask about your data.', alternates: { canonical: '/contact' } };

export default function ContactPage() {
  return (
    <InfoPage testId="page-contact" title="Contact" lead="A bug, an idea, a question about your data, a credit we missed: write here.">
      <React.Suspense fallback={null}><ContactForm /></React.Suspense>
      <h2>Other ways</h2>
      <ul>
        <li><strong>In the game:</strong> Pause, then Report a problem (or Ctrl + Shift + U on any page). It can record your screen and sends what the radio said, so bugs are found faster.</li>
        <li><strong>On GitHub:</strong> <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">open an issue</a>, if you want to follow the fix.</li>
        {CONTACT_EMAIL ? <li><strong>By mail:</strong> <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li> : null}
      </ul>
      <h2>Follow</h2>
      <p>For what comes next.</p>
      <SocialLinks names />
    </InfoPage>
  );
}
