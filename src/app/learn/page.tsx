'use client';
/*
  /learn — the tutorial: the course (src/game/Tutorial/course.ts) on the full live SFO map. The setup step first (the two
  models and the microphone, once), then one card over the map that walks a beginner through the airport, the radio,
  and one flight from gate to sky, then an arrival from the radar.
*/
import * as React from 'react';
import { sim, useSim } from '@/components/atc/simStore';
import { applyPrefsToDocument } from '@/app/_lib/persist';
import { GameShell } from '@/game/GameShell';
import { CourseOverlay } from '@/game/Tutorial/Course';
import { Setup, setupDone } from '@/game/Tutorial/Setup';
import { sound } from '@/game/Tutorial/audio';
import c from '@/game/Tutorial/Course.module.css';

import { forceTimeOfDay } from '@/components/atc/MapboxMap/MapTools'

export default function LearnPage() {
  // the course is at dusk, in clear weather (lessons.ts baseScene clears the weather for every mission)
  React.useState(() => { forceTimeOfDay('dusk'); return null })
  React.useEffect(() => () => forceTimeOfDay(null), [])
  const loading = useSim((st) => st.loading);
  const loadError = useSim((st) => st.loadError);
  const hasEngine = useSim((st) => !!st.engine);
  const [settled, setSettled] = React.useState(false);
  const [setup, setSetup] = React.useState(false);
  const booted = React.useRef(false);
  const load = React.useCallback(() => {
    setSettled(false);
    void sim.load({ icao: 'KSFO', spawn: 'none', position: 'ground', naming: 'real', ends: ['28L', '28R', '01L', '01R'] }).finally(() => setSettled(true));
  }, []);
  React.useEffect(() => {
    applyPrefsToDocument();
    setSetup(!setupDone());
    if (booted.current) return; booted.current = true;
    load();
  }, [load]);
  React.useEffect(() => () => { sim.setPaused(false); sim.stop(); }, []);
  const ready = settled && hasEngine && !setup;
  // the browser lets sound start only after a click: any click on the page will do
  React.useEffect(() => { const u = () => sound.unlock(); window.addEventListener('pointerdown', u); void sound.loadIndex(); return () => window.removeEventListener('pointerdown', u); }, []);
  return (
    <div className={c.page} data-testid="page-learn" data-ready={ready ? 'true' : undefined}>
      <div className={c.game}>
        <GameShell loading={loading} loadError={loadError} onRetry={load} overlay={<CourseOverlay ready={ready} />} minimal />
      </div>
      {setup ? <Setup onDone={() => setSetup(false)} /> : null}
    </div>
  );
}
