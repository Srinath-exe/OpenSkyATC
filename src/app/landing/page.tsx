import type { Metadata } from 'next';
import Landing from './Landing';

export const metadata: Metadata = { alternates: { canonical: '/' }, robots: { index: false, follow: true } };

export default function LandingPage() {
  return <Landing />;
}
