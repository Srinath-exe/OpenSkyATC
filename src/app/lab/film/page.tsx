'use client';
import dynamic from 'next/dynamic';

const FilmCapture = dynamic(() => import('@/game/FilmCapture/FilmCapture').then((m) => m.FilmCapture), { ssr: false });

/* /lab/film: the landing film's 3D part recorded from the Mapbox map (driven by film/mbx-capture.cjs). */
export default function FilmCapturePage() { return <FilmCapture />; }
