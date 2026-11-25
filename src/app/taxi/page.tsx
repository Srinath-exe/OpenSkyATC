'use client';
import dynamic from 'next/dynamic';

const TaxiMap = dynamic(() => import('@/game/TaxiMap/TaxiMap').then((m) => m.TaxiMap), { ssr: false });

/* /taxi: the running session's airport as a plain taxi map, for a second screen (opened from the game). */
export default function TaxiPage() { return <TaxiMap />; }
