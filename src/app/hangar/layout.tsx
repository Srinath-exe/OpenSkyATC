import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Hangar', description: 'Every aircraft and livery in OpenATC, in 3D.', alternates: { canonical: '/hangar' } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
