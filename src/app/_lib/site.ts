/* What the public pages say about the site itself, in one place. */
export const SITE_URL = 'https://openatc.aeon-labs.site';
export const SITE_NAME = 'OpenATC';
export const TAGLINE = 'Air traffic control simulator in your browser';
export const DESCRIPTION = 'Be the air traffic controller at San Francisco, New York JFK, Paris, Dubai, Singapore or Tokyo. Push back, taxi, take off, approach and land, by voice. Free, in your browser.';
export const REPO_URL = 'https://github.com/Srinath-exe/OpenSkyATC';
export const HF_URL = 'https://huggingface.co/srinath-exe';
export const MAKER = 'Srinath H';
/** The day the privacy policy and the terms were last changed. */
export const LEGAL_DATE = '25 November 2026';
/** The public address for mail (the one on the maker's own site). */
export const CONTACT_EMAIL = '1406srinath@gmail.com';
export const MAKER_URL = 'https://srinath.aeon-labs.site';
/** The newest phone app: OpenATC-android.apk, attached to the newest release of the public repository. */
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const APK_URL = `${RELEASES_URL}/download/OpenATC-android.apk`;

export type SocialKey = 'github' | 'huggingface' | 'x' | 'linkedin' | 'site' | 'mail';
/** Where to find the maker; the phone app has the same list (mobile/lib/src/ui/about_screen.dart). */
export const SOCIALS: Array<{ key: SocialKey; label: string; handle: string; href: string }> = [
  { key: 'github', label: 'GitHub', handle: 'Srinath-exe', href: 'https://github.com/Srinath-exe' },
  { key: 'huggingface', label: 'Hugging Face', handle: 'srinath-exe', href: HF_URL },
  { key: 'x', label: 'X (Twitter)', handle: '@srinath_exe', href: 'https://x.com/srinath_exe' },
  { key: 'linkedin', label: 'LinkedIn', handle: 'srinath-exe', href: 'https://www.linkedin.com/in/srinath-exe' },
  { key: 'site', label: 'Portfolio', handle: 'srinath.aeon-labs.site', href: MAKER_URL },
  { key: 'mail', label: 'Email', handle: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}` },
];

export const FOOTER: Array<{ title: string; links: Array<{ href: string; label: string; out?: boolean }> }> = [
  { title: 'Play', links: [{ href: '/start', label: 'Start a shift' }, { href: '/learn', label: 'Learn the ropes' }, { href: '/hangar', label: 'Hangar' }, { href: '/settings', label: 'Settings' }] },
  { title: 'Airports', links: [{ href: '/airports/sfo', label: 'San Francisco' }, { href: '/airports/jfk', label: 'New York JFK' }, { href: '/airports/cdg', label: 'Paris' }, { href: '/airports/dxb', label: 'Dubai' }, { href: '/airports/sin', label: 'Singapore' }, { href: '/airports/hnd', label: 'Tokyo' }] },
  { title: 'OpenATC', links: [{ href: '/about', label: 'About' }, { href: '/credits', label: 'Credits' }, { href: '/contact', label: 'Contact' }, { href: '/contact?topic=bug', label: 'Report a bug' }] },
  { title: 'Open source', links: [{ href: REPO_URL, label: 'Source on GitHub', out: true }, { href: RELEASES_URL, label: 'Android app (APK)', out: true }, { href: HF_URL, label: 'Models on Hugging Face', out: true }, { href: '/credits#licences', label: 'Licences' }] },
];
export const LEGAL_LINKS = [{ href: '/privacy', label: 'Privacy' }, { href: '/terms', label: 'Terms' }, { href: '/credits', label: 'Credits' }, { href: '/contact', label: 'Contact' }];
export const NOT_REAL = 'A game, not for real-world navigation or training. Not affiliated with any airport, airline, manufacturer or authority.';
