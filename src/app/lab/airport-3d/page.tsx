'use client';
import dynamic from 'next/dynamic';

const AirportLab = dynamic(() => import('@/game/AirportLab/AirportLab').then((m) => m.AirportLab), { ssr: false });

/* /lab/airport-3d: the airport lab with Mapbox off - only our own 3D world (WorldMap), no Mapbox base map. */
export default function AirportLab3dPage() { return <AirportLab base="own" />; }
