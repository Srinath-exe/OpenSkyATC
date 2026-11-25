import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Start a shift', description: 'Choose an airport and a seat, set the wind, the runways and the traffic, and start your shift.', alternates: { canonical: '/start' } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
