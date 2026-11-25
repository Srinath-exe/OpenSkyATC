'use client';
import dynamic from 'next/dynamic';
import { notFound } from 'next/navigation';

const AirportReview = dynamic(() => import('@/game/AirportReview/AirportReview').then((m) => m.AirportReview), { ssr: false });

/* /lab/airports: the airports being worked on, one tab each, whole airport kept loaded, to decide what to cut and fix. The sandbox only. */
export default function AirportsReviewPage() { if (process.env.NODE_ENV === 'production') notFound(); return <AirportReview />; }
