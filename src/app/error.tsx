'use client';
import * as React from 'react';
import { Button } from '@/design';
import { PageFrame } from './_lib/PageFrame';
import s from './not-found.module.css';

/** A page that broke: say so, and offer the ways on. (The crash itself is reported by lib/report.ts.) */
export default function PageError({ error, reset }: { error: Error; reset: () => void }) {
  React.useEffect(() => { console.error(error); window.dispatchEvent(new ErrorEvent('error', { message: `page: ${error.message}`, error })); }, [error]);
  return (
    <PageFrame testId="page-error" crumb="Something broke" width="narrow">
      <div className={s.wrap}><div className={s.err}>
        <h1>Something broke on this page</h1>
        <p>It has been reported. Try it again; if it keeps happening, tell us what you were doing.</p>
        <span className={s.actions}><Button variant="accent" onClick={reset}>Try again</Button><Button variant="ghost" onClick={() => { window.location.href = '/start'; }}>Start page</Button><Button variant="ghost" onClick={() => { window.location.href = '/contact?topic=bug'; }}>Tell us</Button></span>
      </div></div>
    </PageFrame>
  );
}
