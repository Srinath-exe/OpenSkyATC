'use client';
import dynamic from 'next/dynamic';

const AirportLab = dynamic(() => import('@/game/AirportLab/AirportLab').then((m) => m.AirportLab), { ssr: false });

/* /lab/airport-open: the airport lab on open map data (MapLibre GL + OpenStreetMap vector tiles, no Mapbox). */
export default function AirportLabOpenPage() { return <AirportLab base="open" />; }
