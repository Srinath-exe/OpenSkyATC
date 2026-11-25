import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Settings', description: 'Voice, sound, display, controls and your data.', alternates: { canonical: '/settings' }, robots: { index: false, follow: true } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
