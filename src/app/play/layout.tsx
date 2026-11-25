import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Shift', description: 'Your shift.', alternates: { canonical: '/play' }, robots: { index: false, follow: true } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
