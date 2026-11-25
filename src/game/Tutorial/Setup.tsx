'use client'
/* Before the first shift: the game ASKS to put its two models on this device (nothing downloads until the player says
   so; "Not now" plays on with typing and the browser's speech) (ATC-ASR, our speech
   model, 136 MB; the pilot voices, Paradee-8M, 8 MB) and asks for the microphone. Progress is shown; Continue lights
   up when both are in, and after a few seconds the player may go on while they finish in the background. Once speech
   is on the device and fast enough here (its measured time on 2 s of audio), push-to-talk uses it. */
import * as React from 'react'
import { downloadModel, setVoiceEngine, useModels, type ModelId } from '@/lib/models/manager'
import { askMic, micPermission, type MicPermission } from '@/lib/audioDevices'
import s from './Setup.module.css'

const ROWS: { id: ModelId; name: string; what: string; mb: number }[] = [
  { id: 'stt', name: 'ATC-ASR', what: 'Hears your radio calls. Our speech model, trained on air traffic control', mb: 136 },
  { id: 'tts', name: 'Pilot voices', what: 'The pilots who answer you, four voices over the radio', mb: 8 },
]
const SETUP_KEY = 'skycontrol_setup_done'
const allReadyNow = (st: Record<ModelId, { state: string }>) => ROWS.every((r) => st[r.id].state === 'ready')
export const setupDone = () => { try { return localStorage.getItem(SETUP_KEY) === '1' } catch { return false } }

export function Setup({ onDone }: { onDone: () => void }) {
  const { states } = useModels()
  const [mic, setMic] = React.useState<MicPermission>('prompt')
  const [late, setLate] = React.useState(false)
  const started = React.useRef(false)
  const [asked, setAsked] = React.useState(false)
  React.useEffect(() => { void micPermission().then(setMic) }, [])
  const startDownload = () => {
    if (started.current) return; started.current = true; setAsked(true)
    // one after the other, the small one first (pilot voices are ready to speak sooner)
    void (async () => {
      if (states.tts.state !== 'ready') await downloadModel('tts')
      if (states.stt.state !== 'ready') {
        const ok = await downloadModel('stt')
        if (ok) { const ms = JSON.parse(localStorage.getItem('skycontrol_models_v1') || '{}')?.stt?.runMs; if (typeof ms === 'number' && ms < 1500) setVoiceEngine('local') }
      }
    })()
    window.setTimeout(() => setLate(true), 6000)
  }
  const allReady = ROWS.every((r) => states[r.id].state === 'ready')
  const finish = () => { try { localStorage.setItem(SETUP_KEY, '1') } catch { /* */ } onDone() }
  const allow = async () => { await askMic(); setMic(await micPermission()) }
  return (
    <div className={s.wrap} data-testid="setup">
      <div className={s.card}>
        <p className={s.kicker}>Before your first shift</p>
        <h2 className={s.title}>Getting your radio ready</h2>
        <p className={s.sub}>{allReadyNow(states) ? 'Everything is on this device.' : 'The game can put two models on this device, once (about 144 MB). Then it hears you and speaks for the pilots without a server. Nothing downloads until you say so.'}</p>
        <ul className={s.rows}>
          {ROWS.map((r) => {
            const st = states[r.id], pct = st.state === 'ready' ? 100 : Math.round(st.progress * 100)
            return (
              <li key={r.id} className={s.row} data-state={st.state}>
                <div className={s.rowHead}>
                  <span className={s.name}>{r.name}</span>
                  <span className={s.status}>{st.state === 'ready' ? 'Ready' : st.state === 'error' ? 'Failed' : st.state === 'downloading' ? (st.progress >= 0.95 ? 'Checking…' : `${pct} %`) : asked ? 'Waiting' : 'Not downloaded'}</span>
                </div>
                <p className={s.what}>{r.what} · {r.mb} MB</p>
                <div className={s.bar}><span style={{ transform: `scaleX(${(pct / 100).toFixed(3)})` }} /></div>
                {st.state === 'error' ? <button type="button" className={s.retry} onClick={() => void downloadModel(r.id)}>Try again</button> : null}
              </li>
            )
          })}
          <li className={s.row} data-state={mic === 'granted' ? 'ready' : 'none'}>
            <div className={s.rowHead}>
              <span className={s.name}>Microphone</span>
              {mic === 'granted' ? <span className={s.status}>Allowed</span> : <button type="button" className={s.allow} onClick={() => void allow()} data-testid="setup-mic">{mic === 'denied' ? 'Blocked: check again' : 'Allow'}</button>}
            </div>
            <p className={s.what}>{mic === 'denied' ? 'Allow it from the lock icon next to the address, then check again' : 'You talk to the pilots by holding the talk key'}</p>
          </li>
        </ul>
        <div className={s.foot}>
          {allReady ? <><span /><button type="button" className={s.go} onClick={finish} data-testid="setup-continue">Continue</button></>
            : !asked ? <>
              <button type="button" className={s.later} onClick={finish} data-testid="setup-later">Not now, I will type</button>
              <button type="button" className={s.go} onClick={startDownload} data-testid="setup-download">Download {ROWS.filter((r) => states[r.id].state !== 'ready').reduce((n, r) => n + r.mb, 0)} MB</button>
            </> : <>
              {late ? <button type="button" className={s.later} onClick={finish} data-testid="setup-later">Continue while it finishes</button> : <span />}
              <button type="button" className={s.go} disabled data-testid="setup-continue">Downloading…</button>
            </>}
        </div>
      </div>
    </div>
  )
}
