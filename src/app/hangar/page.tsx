'use client';
import * as React from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Button, IconArrowLeft } from '@/design';
import { PageFrame } from '../_lib/PageFrame';

const Hangar = dynamic(() => import('@/game/Hangar/Hangar').then((m) => m.Hangar), { ssr: false });

/* /hangar: browse every aircraft model and livery of the textured fleet. */
export default function HangarPage() {
  const router = useRouter();
  return (
    <PageFrame testId="page-hangar" crumb="Hangar" width="full" right={<Button variant="secondary" iconLeft={<IconArrowLeft size={16} />} onClick={() => router.push('/start')} testId="hangar-back">Home</Button>}>
      <Hangar />
    </PageFrame>
  );
}
