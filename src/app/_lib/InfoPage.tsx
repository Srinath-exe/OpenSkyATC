import * as React from 'react';
import Link from 'next/link';
import { LogoMark } from '@/design/LogoMark';
import { SiteFooter } from './SiteFooter';
import s from './InfoPage.module.css';

/** A public reading page: top bar, the text, the footer. Rendered on the server, so search engines read it whole. */
export function InfoPage({ title, lead, wide, children, testId }: { title: string; lead?: React.ReactNode; wide?: boolean; children: React.ReactNode; testId: string }) {
  return (
    <div className={s.root} data-testid={testId}>
      <header className={s.top}>
        <Link href="/" className={s.brand} aria-label="OpenATC home"><LogoMark size={26} /><span>OpenATC</span></Link>
        <nav className={s.nav} aria-label="Site"><Link href="/about" prefetch={false}>About</Link><Link href="/airports" prefetch={false}>Airports</Link><Link href="/learn" prefetch={false} className={s.hideS}>Learn</Link><Link href="/start" className={s.play}>Play</Link></nav>
      </header>
      <div className={s.scroll} tabIndex={-1}>
        <main className={s.main} data-wide={wide || undefined}>
          <h1 className={s.h1}>{title}</h1>
          {lead ? <p className={s.lead}>{lead}</p> : null}
          <div className={s.body}>{children}</div>
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
