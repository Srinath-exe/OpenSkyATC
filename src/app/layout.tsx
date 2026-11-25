import type { Metadata, Viewport } from 'next'
import { DM_Sans } from 'next/font/google'
import './globals.css'
import { ReportHost } from '@/game/Report/Report'
import { DESCRIPTION, MAKER, MAKER_URL, SITE_NAME, SITE_URL, TAGLINE } from './_lib/site'

/* A18: DM Sans variable (wght 100-1000 covers the 300/400/500 tokens) with the opsz axis; the metric fallback
   ("DM Sans Fallback") is declared in globals.css. next/font requires weight 'variable' when axes are requested. */
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: 'variable',
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-dm-sans',
  adjustFontFallback: false,
  fallback: ['DM Sans Fallback', 'Outfit', 'Helvetica Neue', 'Arial', 'sans-serif'],
})

export const metadata: Metadata = {
  title: { default: `${SITE_NAME}: ${TAGLINE}`, template: `%s · ${SITE_NAME}` },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  metadataBase: new URL(SITE_URL),
  keywords: ['air traffic control game', 'ATC simulator', 'browser ATC game', 'air traffic controller simulator', 'tower simulator', 'approach control game', 'voice controlled game', 'SFO', 'JFK', 'Paris CDG', 'Dubai', 'Changi', 'Haneda'],
  category: 'game',
  authors: [{ name: MAKER, url: MAKER_URL }],
  creator: MAKER,
  publisher: SITE_NAME,
  formatDetection: { telephone: false, address: false, email: false },
  openGraph: { type: 'website', siteName: SITE_NAME, locale: 'en_US', url: '/', title: `${SITE_NAME}: ${TAGLINE}`, description: DESCRIPTION, images: [{ url: '/og.jpg', width: 1200, height: 630, alt: 'OpenATC: an airport at night, terminal and parked aircraft' }] },
  twitter: { card: 'summary_large_image', title: `${SITE_NAME}: ${TAGLINE}`, description: DESCRIPTION, images: ['/og.jpg'] },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 } },
  appleWebApp: { capable: true, title: SITE_NAME, statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#0b0b0c',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body>{children}<ReportHost /></body>
    </html>
  )
}
