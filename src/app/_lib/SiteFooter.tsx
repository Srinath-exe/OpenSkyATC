import Link from 'next/link';
import { LogoMark } from '@/design/LogoMark';
import { FOOTER, LEGAL_LINKS, MAKER, MAKER_URL, NOT_REAL, REPO_URL } from './site';
import { SocialIcon, SocialLinks } from './SocialLinks';
import s from './SiteFooter.module.css';

/** The site's footer: every public page, the legal links and the map credits. */
export function SiteFooter() {
  return (
    <footer className={s.footer} data-testid="site-footer">
      <div className={s.cols}>
        <div className={s.about}>
          <Link href="/" className={s.brand}><LogoMark size={26} />OpenATC</Link>
          <p>{NOT_REAL}</p>
          <p>Made by <a href={MAKER_URL} target="_blank" rel="noopener noreferrer">{MAKER}</a>. Follow for what comes next.</p>
          <SocialLinks className={s.social} />
        </div>
        {FOOTER.map((c) => (
          <nav key={c.title} aria-label={c.title} className={s.col}>
            <h2>{c.title}</h2>
            <ul>{c.links.map((l) => <li key={l.href}>{l.out ? <a href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a> : <Link href={l.href} prefetch={false}>{l.label}</Link>}</li>)}</ul>
          </nav>
        ))}
      </div>
      <div className={s.base}>
        <p>© 2026 OpenATC. Maps © <a href="https://www.mapbox.com/about/maps" target="_blank" rel="noopener noreferrer">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors.</p>
        <LegalLinks />
      </div>
    </footer>
  );
}

/** The legal links alone, on one line (screens that fill the window). */
export function LegalLinks({ className = '' }: { className?: string }) {
  return <nav aria-label="Legal" className={`${s.legal} ${className}`} data-testid="legal-links">{LEGAL_LINKS.map((l) => <Link key={l.href} href={l.href} prefetch={false}>{l.label}</Link>)}<a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={s.gh}><SocialIcon name="github" size={14} />GitHub</a></nav>;
}
