'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Icon, IconButton, Pill, Segmented, Toggle, Input, Tooltip, LogoMark,
  IconArrowRight, IconChevronLeft, IconSettings, IconWind, IconPlay, cx,
} from '@/design';
import type { WeightClass } from '@/lib/sim/aircraftDB';
import type { RunwayEnd, RunwayPair } from '@/lib/runwayManifest';
import { preferredEnds } from '@/lib/sim/weather';
import { StateMirror } from '../_lib/PageFrame';
import { LegalLinks } from '../_lib/SiteFooter';
import {
  AIRPORTS, AIRPORT_BY_ICAO, LISTED_AIRPORTS, runwaysOf, sanitiseRef, windComponents, MAX_TAILWIND_KT, formatFeet, feetToMetres,
  type AirportMeta,
} from '../_lib/airports';
import {
  useSettings, updateSettings, useHighScore, useSessionRunning, writeStartConfig, applyPrefsToDocument,
  type Difficulty, type Position, type StartConfig,
} from '../_lib/persist';
import { sectorAi, sectorPatch } from '@/components/atc/simSettings';
import { openReport } from '@/game/Report/Report';
import { RunwayDiagram } from './RunwayDiagram';
import { Setup, setupDone } from '@/game/Tutorial/Setup';
import { AirportPicker, MapBackdrop } from './AirportPicker';
import s from './home.module.css';

const WEIGHTS: WeightClass[] = ['L', 'M', 'H', 'S'];
const WEIGHT_LABEL: Record<WeightClass, string> = { L: 'Light', M: 'Medium', H: 'Heavy', S: 'Super' };
/** What the player works: one seat. The other is always run by the AI (Tower = ground + runway, the 'airfield' sector). */
type Role = 'airfield' | 'approach';
const ROLES: { id: Role; label: string; hint: string; ai: string }[] = [
  { id: 'airfield', label: 'Tower', hint: 'Ground and runways: push, taxi, take off, land.', ai: 'The AI works Approach' },
  { id: 'approach', label: 'Approach', hint: 'The radar: line arrivals up on the ILS.', ai: 'The AI works Tower' },
];
const DIFFICULTIES: { id: Difficulty; label: string }[] = [{ id: 'low', label: 'Low' }, { id: 'normal', label: 'Normal' }, { id: 'high', label: 'High' }];

/** Default weight classes per end by runway length (05 §4.1 H3). */
function defaultWeights(lengthFt: number): WeightClass[] {
  if (lengthFt >= 10000) return ['L', 'M', 'H', 'S'];
  if (lengthFt >= 7500) return ['L', 'M', 'H'];
  if (lengthFt >= 5500) return ['L', 'M'];
  return ['L'];
}

interface EndCfg { on: boolean; weights: WeightClass[] }
type RunwayCfg = Record<string, EndCfg>; // keyed by end name

function initialCfg(icao: string): RunwayCfg {
  const cfg: RunwayCfg = {};
  // the ends in use for the field's prevailing wind (the rest can be switched on by hand)
  const meta = AIRPORTS.find((a) => a.icao === icao);
  const on = new Set(meta ? preferredEnds(runwaysOf(icao).flatMap((r) => r.ends), meta.wind.dir, meta.wind.kts) : []);
  for (const r of runwaysOf(icao)) for (const e of r.ends) cfg[e.name] = { on: on.size ? on.has(e.name) : true, weights: defaultWeights(r.lengthFt) };
  return cfg;
}

// ---------------------------------------------------------------------------
//  Page: a full-bleed night shift. The airport at dusk moves behind everything (a blurred loop rendered from the
//  game's own 3D map), the set-up floats over it: the field and the call to action on the left, the runways on the
//  right as a radar console.
// ---------------------------------------------------------------------------
export default function HomePage() {
  const router = useRouter();
  // one airport listed: its set-up is the page. More: the list first, and the set-up as the second step (/start?icao=KJFK)
  const single = LISTED_AIRPORTS.length === 1 ? LISTED_AIRPORTS[0].icao : null;
  const [icao, setIcao] = React.useState<string | null>(single);
  const [flown, setFlown] = React.useState(false);   // came through the list: the airport's map is what the drop opened on to
  React.useEffect(() => {
    if (single) return;
    const read = () => { const q = new URLSearchParams(window.location.search).get('icao')?.toUpperCase() ?? ''; const ok = LISTED_AIRPORTS.some((x) => x.icao === q); setIcao(ok ? q : null); if (!ok) setFlown(false); };
    read(); window.addEventListener('popstate', read); return () => window.removeEventListener('popstate', read);
  }, [single]);
  const pickAirport = (next: string | null) => { window.history.pushState(null, '', next ? `/start?icao=${next}` : '/start'); setFlown(!!next); setIcao(next); };
  const running = useSessionRunning();
  const highScore = useHighScore();
  const [ready, setReady] = React.useState(false);
  const [setup, setSetup] = React.useState(false);
  React.useEffect(() => { applyPrefsToDocument(); setReady(true); setSetup(!setupDone()); }, []);

  return (
    <div className={s.shell} data-start-shell data-mode={icao ? 'set' : 'pick'} data-testid="page-home" data-ready={ready ? 'true' : undefined}>
      {!icao ? <AirportPicker onPick={pickAirport} /> : icao === 'KSFO' ? <Backdrop /> : null}
      {icao && (flown || icao !== 'KSFO') ? <MapBackdrop key={icao} icao={icao} fade={icao === 'KSFO'} /> : null}
      <header className={s.topbar}>
        <button type="button" className={s.brand} data-testid="nav-brand" aria-label="OpenATC home" onClick={() => router.push('/')}>
          <LogoMark size={28} /><span>OpenATC</span>
        </button>
        <div className={s.topRight}>
          {highScore > 0 ? <span className={s.best} data-testid="home-highscore"><small>Best</small><b className="tabular">{highScore.toLocaleString('en')}</b></span> : null}
          {running ? <Button variant="secondary" iconLeft={<IconPlay size={16} />} onClick={() => router.push('/play')} testId="home-resume">Resume shift</Button> : null}
          <IconButton label="Report something on this screen" icon={<Icon name="report" size={20} />} size={40} variant="glass" onClick={openReport} testId="report-btn" data-report-anchor="" />
          <IconButton label="Settings" icon={<IconSettings />} size={40} variant="glass" onClick={() => router.push('/settings')} testId="home-settings-link" />
        </div>
      </header>
      <footer className={s.foot}><span>Maps © <a href="https://www.mapbox.com/about/maps" target="_blank" rel="noopener noreferrer">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a></span><LegalLinks /></footer>
      {setup ? <Setup onDone={() => setSetup(false)} /> : null}
      {icao ? <Stage><Detail key={icao} airport={AIRPORT_BY_ICAO[icao]} onBack={single ? null : () => pickAirport(null)} /></Stage> : null}
    </div>
  );
}

function Stage({ children }: { children: React.ReactNode }) {
  const stageRef = React.useRef<HTMLElement>(null), fitRef = React.useRef<HTMLDivElement>(null);
  useFitToScreen(stageRef, fitRef);
  return <main className={s.stage} ref={stageRef}><div className={s.fit} ref={fitRef}>{children}</div></main>;
}

/** Desktop: the whole set-up fits the screen, any size, no scrolling. The content is measured at full size and
 *  zoomed down to the height there is (its width grows by the same factor, so it still spans the screen). Narrow
 *  screens (phones, small tablets) scroll as usual. */
function useFitToScreen(outer: React.RefObject<HTMLElement | null>, inner: React.RefObject<HTMLDivElement | null>) {
  React.useLayoutEffect(() => {
    const o = outer.current, el = inner.current; if (!o || !el) return;
    let raf = 0;
    const fit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (window.innerWidth < 1100) { el.style.zoom = ''; el.style.width = ''; return; }
        el.style.zoom = '1'; el.style.width = '100%';
        const cs = getComputedStyle(o);
        const have = o.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        const z = Math.max(0.5, Math.min(1, have / el.scrollHeight));
        el.style.zoom = z.toFixed(4); el.style.width = `${100 / z}%`;
      });
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(o);
    const mo = new MutationObserver(fit); mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    window.addEventListener('resize', fit);
    return () => { ro.disconnect(); mo.disconnect(); window.removeEventListener('resize', fit); cancelAnimationFrame(raf); };
  }, [outer, inner]);
}

/** The airport at dusk, blurred, looping; a still while it loads (and for reduced motion). */
function Backdrop() {
  const [still, setStill] = React.useState(false);
  React.useEffect(() => { try { setStill(window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { /* */ } }, []);
  return (
    <div className={s.backdrop} aria-hidden="true">
      {still ? <img src="/media/start-backdrop.jpg" alt="" className={s.backdropMedia} />
        : <video className={s.backdropMedia} src="/media/start-backdrop.mp4" poster="/media/start-backdrop.jpg" autoPlay muted loop playsInline preload="auto" />}
      <span className={s.backdropVeil} />
      <span className={s.backdropGrain} />
    </div>
  );
}

function UtcClock() {
  const [t, setT] = React.useState<string>('');
  React.useEffect(() => {
    const tick = () => { const d = new Date(); setT(`${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}Z`); };
    tick(); const id = window.setInterval(tick, 1000); return () => window.clearInterval(id);
  }, []);
  return <span className={s.clock}><i />{t || '--:--:--Z'}</span>;
}

// seat glyphs (24px, stroke)
const SEAT_ICON: Record<Role, React.ReactNode> = {
  airfield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22V12" /><path d="M8 12h8l-1-4H9z" /><path d="M9.5 8 12 3l2.5 5" /><path d="M6 22h12" /></svg>,
  approach: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="M12 12l6.4-6.4" /><circle cx="15.5" cy="7.5" r="1.1" fill="currentColor" /></svg>,
};

// ---------------------------------------------------------------------------
//  Detail: the shift set-up
// ---------------------------------------------------------------------------
function Detail({ airport, onBack }: { airport: AirportMeta; onBack: (() => void) | null }) {
  const router = useRouter();
  const settings = useSettings();
  const runways = runwaysOf(airport.icao);
  const [cfg, setCfg] = React.useState<RunwayCfg>(() => initialCfg(airport.icao));
  const [wind, setWind] = React.useState(airport.wind);
  const [role, setRole] = React.useState<Role>(() => {
    const air = sectorAi(settings, 'airfield'), app = sectorAi(settings, 'approach');
    return air && !app ? 'approach' : 'airfield';
  });
  const position: Position = role === 'approach' ? 'approach' : 'tower';
  const [difficulty, setDifficulty] = React.useState<Difficulty>(settings.difficulty);
  const [seed, setSeed] = React.useState('');
  const [starting, setStarting] = React.useState(false);
  const [hover, setHover] = React.useState<string | null>(null);

  const toggleEnd = (end: string) => setCfg((c) => ({ ...c, [end]: { ...c[end], on: !c[end].on } }));
  const toggleWeight = (end: string, w: WeightClass) => setCfg((c) => {
    const cur = c[end].weights;
    const next = cur.includes(w) ? cur.filter((x) => x !== w) : WEIGHTS.filter((x) => x === w || cur.includes(x));
    return { ...c, [end]: { ...c[end], weights: next } };
  });

  const activeEnds = runways.flatMap((r) => r.ends.filter((e) => cfg[e.name]?.on).map((e) => e.name));
  const anyOn = activeEnds.length > 0;

  /** Pick the into-wind end of every pair (for the wind given, or the one set). */
  const applyWind = (w: { dir: number; kts: number } = wind) => setCfg((c) => {
    const next = { ...c };
    for (const r of runways) {
      const [a, b] = r.ends;
      const ha = windComponents(a.hdg, w.dir, w.kts).headKt;
      const hb = windComponents(b.hdg, w.dir, w.kts).headKt;
      const favour = ha >= hb ? a : b;
      const other = favour === a ? b : a;
      next[favour.name] = { ...next[favour.name], on: true };
      next[other.name] = { ...next[other.name], on: false };
    }
    return next;
  });

  const seedNum = seed.trim() === '' ? undefined : Number(seed.trim());
  const seedError = seedNum !== undefined && (!Number.isFinite(seedNum) || !Number.isInteger(seedNum) || seedNum < 0) ? 'Whole number' : undefined;

  const start = () => {
    if (!anyOn || seedError || starting) return;
    const weights: Record<string, WeightClass[]> = {};
    for (const end of activeEnds) weights[end] = [...cfg[end].weights];
    const startCfg: StartConfig = {
      icao: airport.icao, ends: activeEnds, weights, difficulty, position, spawn: 'default',
      wind: { dir: wind.dir, kts: wind.kts },
      ...(seedNum !== undefined ? { seed: seedNum } : {}),
    };
    updateSettings({ difficulty, ...sectorPatch('airfield', role === 'approach'), ...sectorPatch('approach', role === 'airfield') });
    writeStartConfig(startCfg);
    setStarting(true);
    router.push('/play');
  };

  const summary = `${role === 'airfield' ? 'Tower' : 'Approach'} · ${activeEnds.join(' ') || 'no runway'} · ${DIFFICULTIES.find((d) => d.id === difficulty)?.label} traffic`;
  return (
    <div className={s.detail} data-testid="home-detail" data-icao={airport.icao}>
      {/* the shift, as the game's flight board: one row per setting, Start as the last row */}
      <section className={s.board} aria-label={`${airport.name}: your shift`} data-testid="home-shift">
        <header className={s.boardHead}>
          <div>
            {onBack ? <Button variant="secondary" size="sm" iconLeft={<IconChevronLeft size={16} />} onClick={onBack} testId="home-change-airport">Change airport</Button> : null}
            <h1 className={s.boardTitle} data-testid="home-detail-title">{airport.name}</h1>
            <p className={s.boardSub}><span className="tabular">{airport.icao}</span> · <span className="tabular">{airport.iata}</span> · {airport.city} · elevation <span className="tabular">{formatFeet(airport.elevationFt)}</span></p>
          </div>
          <UtcClock />
        </header>

        <div className={s.row}>
          <span className={s.rowLabel}>Seat</span>
          <div className={s.rowBody}>
            <div className={s.seats} role="radiogroup" aria-label="You control" data-testid="home-role">
              {ROLES.map((r) => (
                <button key={r.id} type="button" role="radio" aria-checked={role === r.id} className={s.seat} onClick={() => setRole(r.id)} data-testid={`home-role-${r.id}`}>
                  <span className={s.seatTop}><span className={s.seatIcon} aria-hidden="true">{SEAT_ICON[r.id]}</span><span className={s.seatName}>{r.label}</span></span>
                  <span className={s.seatHint}>{r.hint}</span>
                </button>
              ))}
            </div>
            <p className={s.aiLine} data-testid="home-role-hint"><i aria-hidden="true" />{ROLES.find((r) => r.id === role)?.ai}. Switch seats any time in the game.</p>
          </div>
        </div>

        <div className={s.row}>
          <span className={s.rowLabel}>Runways</span>
          <div className={s.rowBody}>
            <div className={s.ends}>
              {runways.flatMap((r) => r.ends).map((e) => (
                <button key={e.name} type="button" className={s.endChip} aria-pressed={!!cfg[e.name]?.on} onClick={() => toggleEnd(e.name)} data-testid={`board-end-${e.name}`}
                  onMouseEnter={() => setHover(runways.find((r) => r.ends.some((x) => x.name === e.name))?.ref ?? null)} onMouseLeave={() => setHover(null)}>{e.name}</button>
              ))}
            </div>
            <p className={s.rowNote}><span className="tabular" data-testid="home-active-count">{activeEnds.length}</span> {activeEnds.length === 1 ? 'end' : 'ends'} in use. Set by the wind, or pick on the map.</p>
          </div>
        </div>

        <div className={s.row}>
          <span className={s.rowLabel}>Wind</span>
          <div className={s.rowBody}><WindControl key={`${wind.dir}/${wind.kts}`} wind={wind} onChange={setWind} onApply={() => applyWind()} /></div>
        </div>

        <div className={s.row}>
          <span className={s.rowLabel}>Traffic</span>
          <div className={s.rowBody}><Segmented ariaLabel="Difficulty" value={difficulty} onChange={(v) => setDifficulty(v as Difficulty)} items={DIFFICULTIES} testId="home-difficulty" /></div>
        </div>

        <div className={s.row}>
          <span className={s.rowLabel}>Sound</span>
          <div className={cx(s.rowBody, s.switches)}>
            <StateMirror state={settings.sound ? 'on' : 'off'}>
              <Toggle checked={settings.sound} onChange={(v) => updateSettings({ sound: v })} label="Radio and alerts" labelPosition="left" testId="home-sound" />
            </StateMirror>
            <StateMirror state={settings.tts ? 'on' : 'off'}>
              <Toggle checked={settings.tts} onChange={(v) => updateSettings({ tts: v })} label="Pilot voices" labelPosition="left" testId="home-tts" />
            </StateMirror>
          </div>
        </div>

        <footer className={s.boardFoot}>
          <button type="button" className={s.go} disabled={!anyOn || Boolean(seedError) || starting} onClick={start} data-testid="home-start" aria-describedby="home-start-hint">
            <span className={s.goText}>{starting ? 'Starting…' : 'Start shift'}</span>
            <span className={s.goMeta} id="home-start-hint" data-testid="home-start-hint">{anyOn ? summary : 'Switch on a runway end first'}</span>
            <IconArrowRight size={22} />
          </button>
          <button type="button" className={s.learn} onClick={() => router.push('/learn')} data-testid="home-learn">New here? Learn it in 10 minutes <IconArrowRight size={16} /></button>
        </footer>
      </section>

      {/* the runways, docked over the airport: drag the wind, click a runway near the end traffic lands on */}
      <section className={s.rwyPanel} data-testid="home-runways" aria-label="Runways in use">
        <header className={s.rwyHead}>
          <h2>Runways in use</h2>
          <p>Drag the wind. Click a runway near the end traffic lands on.</p>
        </header>
        <div className={s.diagramWrap}>
          <RunwayDiagram runways={runways} on={(e) => !!cfg[e]?.on} wind={wind} hover={hover} onHover={setHover} onToggle={toggleEnd}
            onFlow={(end, other) => setCfg((c) => ({ ...c, [end]: { ...c[end], on: !c[end].on || c[other].on }, [other]: { ...c[other], on: false } }))}
            onWind={(w) => { setWind(w); applyWind(w); }} />
        </div>
        <details className={s.advanced}>
          <summary>Wake categories and seed</summary>
          <ul className={s.rwyList} aria-label="Runways">
            {runways.map((r) => (
              <RunwayRow key={r.ref} pair={r} cfg={cfg} wind={wind} onToggleEnd={toggleEnd} onToggleWeight={toggleWeight} hover={hover === r.ref} onHover={setHover} />
            ))}
          </ul>
          <Input label="Seed" placeholder="Random" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value)} error={seedError}
            helper={seedError ? undefined : 'Same seed, same traffic. Leave empty for a fresh shift.'} tabular size="m" fullWidth testId="home-seed" />
        </details>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Wind control (header of the runway card)
// ---------------------------------------------------------------------------
function WindControl({ wind, onChange, onApply }: { wind: { dir: number; kts: number }; onChange: (w: { dir: number; kts: number }) => void; onApply: () => void }) {
  const [dir, setDir] = React.useState(String(wind.dir).padStart(3, '0'));
  const [kts, setKts] = React.useState(String(wind.kts));
  const commit = () => {
    const d = ((parseInt(dir, 10) % 360) + 360) % 360;
    const k = Math.max(0, Math.min(99, parseInt(kts, 10)));
    const next = { dir: Number.isFinite(d) ? d : wind.dir, kts: Number.isFinite(k) ? k : wind.kts };
    setDir(String(next.dir).padStart(3, '0'));
    setKts(String(next.kts));
    if (next.dir !== wind.dir || next.kts !== wind.kts) onChange(next);
  };
  return (
    <div className={s.wind} role="group" aria-label="Wind">
      <span className={s.windIcon}><IconWind size={16} /></span>
      <span className={cx('body-s', s.windLabel)}>Wind</span>
      <Input size="m" tabular value={dir} onChange={(e) => setDir(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }} aria-label="Wind direction, degrees true" inputMode="numeric" wrapClassName={s.windInput} testId="home-wind-dir" />
      <span className={cx('body-s', s.windSep)}>/</span>
      <Input size="m" tabular value={kts} onChange={(e) => setKts(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }} aria-label="Wind speed, knots" inputMode="numeric" wrapClassName={s.windInputS} testId="home-wind-kts" />
      <span className={cx('body-s', s.windUnit)}>kt</span>
      <Tooltip content="Select the into-wind end of every runway">
        <Button variant="ghost" size="sm" onClick={onApply} testId="home-wind-apply">Into wind</Button>
      </Tooltip>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Runway row
// ---------------------------------------------------------------------------
function RunwayRow({ pair, cfg, wind, onToggleEnd, onToggleWeight, hover, onHover }: {
  pair: RunwayPair; cfg: RunwayCfg; wind: { dir: number; kts: number };
  onToggleEnd: (end: string) => void; onToggleWeight: (end: string, w: WeightClass) => void; hover: boolean; onHover: (ref: string | null) => void;
}) {
  const ref = sanitiseRef(pair.ref);
  const anyOn = pair.ends.some((e) => cfg[e.name]?.on);
  return (
    <li className={cx(s.rwyRow, !anyOn && s.rwyRowOff)} data-hover={hover || undefined} onMouseEnter={() => onHover(pair.ref)} onMouseLeave={() => onHover(null)} data-testid={`rwy-row-${ref}`} data-ref={pair.ref} data-active={anyOn ? 'true' : 'false'}>
      <div className={s.rwyId}>
        <span className={cx('title-m', 'tabular', s.rwyRef)}>{pair.ends[0].name} <span className={s.rwySlash}>/</span> {pair.ends[1].name}</span>
        <span className={cx('label-xs', 'tabular', s.rwyLen)}>{formatFeet(pair.lengthFt)} · {feetToMetres(pair.lengthFt).toLocaleString('en')} m</span>
      </div>
      {pair.ends.map((e) => (
        <EndBlock key={e.name} end={e} cfg={cfg[e.name]} wind={wind} onToggle={() => onToggleEnd(e.name)} onWeight={(w) => onToggleWeight(e.name, w)} />
      ))}
    </li>
  );
}

function EndBlock({ end, cfg, wind, onToggle, onWeight }: { end: RunwayEnd; cfg: EndCfg; wind: { dir: number; kts: number }; onToggle: () => void; onWeight: (w: WeightClass) => void }) {
  const wc = windComponents(end.hdg, wind.dir, wind.kts);
  const tail = wc.headKt < 0;
  const bad = tail && -wc.headKt > MAX_TAILWIND_KT;
  return (
    <div className={cx(s.end, !cfg.on && s.endOff)} data-end={end.name}>
      <div className={s.endHead}>
        <Pill size="m" tone={cfg.on ? 'outline' : 'dim'} selected={cfg.on} aria-pressed={cfg.on} interactive onClick={onToggle} tabular testId={`rwy-end-${end.name}`} aria-label={`Runway ${end.name} ${cfg.on ? 'active' : 'inactive'}`}>
          {end.name}
        </Pill>
        <span className={cx('label-xs', 'tabular', s.windPreview, bad && s.windBad)} data-testid={`rwy-wind-${end.name}`} data-head={wc.headKt} data-cross={wc.crossKt} title={`Runway heading ${Math.round(end.hdg).toString().padStart(3, '0')}° true`}>
          {wind.kts === 0 ? 'Calm' : (
            <>
              <span className={s.windPart}>{tail ? 'TW' : 'HW'} {Math.abs(wc.headKt)}</span>
              <span className={s.windDot}>·</span>
              <span className={s.windPart}>XW {wc.crossKt}{wc.crossFrom ? ` ${wc.crossFrom}` : ''}</span>
            </>
          )}
        </span>
      </div>
      <div className={s.weights} role="group" aria-label={`Weight classes for ${end.name}`}>
        {WEIGHTS.map((w) => {
          const on = cfg.weights.includes(w);
          return (
            <Tooltip key={w} content={WEIGHT_LABEL[w]} delay={500}>
              <Pill size="xs" tone={on ? 'orange' : 'dim'} selected={on} aria-pressed={on} interactive disabled={!cfg.on} onClick={() => onWeight(w)} testId={`rwy-weight-${end.name}-${w}`} aria-label={`${WEIGHT_LABEL[w]} on ${end.name}`} className={s.weightChip}>
                {w}
              </Pill>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
