import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Taxi map', description: 'The running shift as a taxi map, for a second screen.', alternates: { canonical: '/taxi' }, robots: { index: false, follow: true } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
