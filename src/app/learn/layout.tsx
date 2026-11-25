import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Learn the ropes', description: 'A ten-minute guided course: one flight from the gate to the sky, then an arrival from the radar to the runway.', alternates: { canonical: '/learn' } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
