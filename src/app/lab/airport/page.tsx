'use client';
import dynamic from 'next/dynamic';

const AirportLab = dynamic(() => import('@/game/AirportLab/AirportLab').then((m) => m.AirportLab), { ssr: false });

/* /lab/airport: the Mapbox-based airport map experiment. */
export default function AirportLabPage() { return <AirportLab />; }
