'use client'
/* Settings > Voice & input: the microphone (browser permission, which mic, a live level), the audio output, and a
   push-to-talk test with practice lines: hold, say the line, see what the recogniser heard. A line read back word for
   word (numbers compared as digits, so "two one four" = "214") moves on to the next by itself. */
import * as React from 'react'
import { ListRow, Select, Button, Icon } from '@/design'
import { askMic, canPickOutput, applySink, listDevices, micConstraints, micDeviceId, micPermission, outDeviceId, setMicDevice, setOutDevice, EV_AUDIO_DEVICES, type MicPermission } from '@/lib/audioDevices'
import { createBrowserRecognizer, createLocalRecognizer, createNativeRecognizer, defaultAccent, type Recognizer, type VoiceEngine } from '@/lib/voice/recognizer'
import { createServerRecognizer } from '@/lib/voice/asr-server'
import { sttWords, wordsToDigits } from '@/lib/voice/verify'
import { useModels, useVoicePrefs } from '@/lib/models/manager'
import { LS, readJson } from '../persist'
import { Group } from './SettingsTabs'
import s from './SettingsTabs.module.css'

// ── devices ──
export function AudioDevices() {
  const [perm, setPerm] = React.useState<MicPermission>('prompt')
  const [mics, setMics] = React.useState<MediaDeviceInfo[]>([])
  const [outs, setOuts] = React.useState<MediaDeviceInfo[]>([])
  const [mic, setMic] = React.useState('')
  const [out, setOut] = React.useState('')
  const [level, setLevel] = React.useState(0)
  const refresh = React.useCallback(async () => {
    setPerm(await micPermission()); const d = await listDevices(); setMics(d.mics); setOuts(d.outs); setMic(micDeviceId()); setOut(outDeviceId())
  }, [])
  React.useEffect(() => {
    void refresh()
    const md = navigator.mediaDevices; md?.addEventListener?.('devicechange', refresh)
    let ps: PermissionStatus | null = null
    void navigator.permissions?.query({ name: 'microphone' as PermissionName }).then((p) => { ps = p; p.onchange = () => void refresh() }).catch(() => {})
    return () => { md?.removeEventListener?.('devicechange', refresh); if (ps) ps.onchange = null }
  }, [refresh])
  // live level of the chosen microphone while this page is open (so you can see it hears you)
  React.useEffect(() => {
    if (perm !== 'granted') return
    let stream: MediaStream | null = null, ctx: AudioContext | null = null, raf = 0, dead = false
    void navigator.mediaDevices.getUserMedia({ audio: micConstraints(true) }).then((st) => {
      if (dead) { st.getTracks().forEach((t) => t.stop()); return }
      stream = st; ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(st).connect(an)
      const buf = new Float32Array(an.fftSize)
      const tick = () => { an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p += v * v; setLevel(Math.min(1, Math.sqrt(p / buf.length) * 6)); raf = requestAnimationFrame(tick) }
      tick()
    }).catch(() => {})
    return () => { dead = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); void ctx?.close() }
  }, [perm, mic])

  const allow = async () => { await askMic(); await refresh() }
  const testTone = () => {
    const ctx = new AudioContext(); applySink(ctx)
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.connect(g); g.connect(ctx.destination)
    const t = ctx.currentTime; o.frequency.setValueAtTime(660, t); o.frequency.setValueAtTime(880, t + 0.18)
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.02); g.gain.setValueAtTime(0.25, t + 0.34); g.gain.linearRampToValueAtTime(0, t + 0.4)
    o.start(t); o.stop(t + 0.42); o.onended = () => void ctx.close()
  }
  const permText = perm === 'granted' ? 'Allowed: push-to-talk can hear you'
    : perm === 'denied' ? 'Blocked by the browser. Click the lock (or tune) icon left of the address, set Microphone to Allow, then press Check again'
    : perm === 'unsupported' ? 'This browser cannot record audio here (it needs a secure https page)'
    : 'Not allowed yet: the browser will ask the first time you talk'
  const micOpts = [{ value: '', label: 'System default' }, ...mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))]
  const outOpts = [{ value: '', label: 'System default' }, ...outs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Output ${i + 1}` }))]
  return (
    <Group title="Microphone and speakers" hint="What push-to-talk records from and where the radio plays">
      <ListRow flush title="Microphone access" subtitle={permText} trailing={
        perm === 'granted' ? <span className={s.permOk}><Icon name="check" size={14} /> Allowed</span>
          : <Button variant={perm === 'denied' ? 'secondary' : 'accent'} size="sm" onClick={() => void allow()} testId="mic-allow">{perm === 'denied' ? 'Check again' : 'Allow microphone'}</Button>
      } />
      <ListRow flush title="Microphone" subtitle={perm === 'granted' ? 'Speak: the bar should move' : 'Allow the microphone to see your devices by name'} meta={perm === 'granted' ? <span className={s.meter} aria-label="Microphone level"><i style={{ transform: `scaleX(${level.toFixed(3)})` }} /></span> : undefined}
        trailing={<Select size="m" ariaLabel="Microphone" options={micOpts} value={micOpts.some((o) => o.value === mic) ? mic : ''} onChange={(v) => { setMicDevice(v); setMic(v) }} className={s.select} testId="set-mic" />} />
      <ListRow flush title="Audio output" subtitle={canPickOutput() ? 'Pilot voices, radio clicks and alerts' : 'This browser always plays through the system output'}
        trailing={<span className={s.instBtns}>
          {canPickOutput() ? <Select size="m" ariaLabel="Audio output" options={outOpts} value={outOpts.some((o) => o.value === out) ? out : ''} onChange={(v) => { setOutDevice(v); setOut(v) }} className={s.select} testId="set-output" /> : null}
          <Button variant="ghost" size="sm" iconLeft={<Icon name="volume-2" size={14} />} onClick={testTone} testId="output-test">Test</Button>
        </span>} />
    </Group>
  )
}

// ── push-to-talk test ──
const LINES = [
  'United two one four, climb and maintain five thousand',
  'Delta forty, turn left heading two seven zero',
  'Alaska three three one, descend and maintain three thousand',
  'Speedbird two eight five, reduce speed to two one zero',
  'Southwest twenty two ten, contact tower',
  'JetBlue nine one five, cleared to land runway two eight left',
  'Cathay eight seven three, squawk four five one two',
  'American seventeen, hold short runway one left',
  'Qantas seventy four, line up and wait runway two eight right',
  'Emirates two two five, cleared for takeoff runway one right',
  'Skywest fifty five twenty one, taxi to runway one left via alpha',
  'Air Canada seven five nine, turn right heading three six zero',
]
/** Words of a line for comparing: lower case, numbers as digits ("two one four" = "214"), "28L" = "28 left". */
const toks = (t: string) => wordsToDigits(sttWords(t.replace(/\b(\d{1,2})\s*([lrc])\b/gi, (_m, d: string, x: string) => `${d} ${({ l: 'left', r: 'right', c: 'center' } as Record<string, string>)[x.toLowerCase()]}`)))
/** Score of what was heard against the line (LCS over words, joined so "jet blue" = "jetblue"), and which line words were matched. */
function compare(line: string, heard: string): { exact: boolean; score: number; hit: boolean[] } {
  const A = toks(line), B = toks(heard)
  const exact = A.join('') === B.join('') && B.length > 0
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0))
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const hit = new Array(A.length).fill(false); let i = 0, j = 0
  while (i < A.length && j < B.length) { if (A[i] === B[j]) { hit[i] = true; i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++ }
  return { exact, score: exact ? 1 : dp[0][0] / Math.max(A.length, B.length, 1), hit }
}

export function VoiceTest() {
  const { engine } = useVoicePrefs()
  const { states } = useModels()
  const recs = React.useRef<Partial<Record<VoiceEngine, Recognizer>>>({})
  const [held, setHeld] = React.useState(false)
  const [partial, setPartial] = React.useState('')
  const [heard, setHeard] = React.useState<{ text: string; ms: number } | null>(null)
  const [err, setErr] = React.useState('')
  const [idx, setIdx] = React.useState(() => Math.floor(Math.random() * LINES.length))
  const [streak, setStreak] = React.useState(0)
  const t0 = React.useRef(0), holding = React.useRef(false)
  const line = LINES[idx]
  const rec = (): Recognizer | null => {
    const have = recs.current[engine]; if (have) return have
    const r = engine === 'native' ? createNativeRecognizer() : engine === 'server' ? createServerRecognizer() : engine === 'local' ? createLocalRecognizer() : createBrowserRecognizer(readJson<string>(LS.voiceAccent, defaultAccent()))
    if (r) recs.current[engine] = r
    return r
  }
  const down = () => {
    if (holding.current) return
    const r = rec(); if (!r) { setErr('Speech recognition is not available in this browser'); return }
    holding.current = true; setHeld(true); setErr(''); setHeard(null); setPartial('Listening…')
    r.onPartial = (t) => setPartial(t); r.onError = (m) => setErr(m)
    r.setHints?.([]); r.start()
  }
  const up = async () => {
    if (!holding.current) return
    holding.current = false; setHeld(false); t0.current = performance.now()
    const r = recs.current[engine]; if (!r) return
    setPartial('Transcribing…')
    const text = (await r.stop()) || ''
    setPartial(''); setHeard({ text, ms: Math.round(performance.now() - t0.current) })
  }
  // read word for word: next line by itself
  const result = heard ? compare(line, heard.text) : null
  React.useEffect(() => {
    if (!result?.exact) return
    const t = window.setTimeout(() => { setIdx((i) => (i + 1 + Math.floor(Math.random() * (LINES.length - 1))) % LINES.length); setHeard(null); setStreak((n) => n + 1) }, 1400)
    return () => window.clearTimeout(t)
  }, [result?.exact])   // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => () => { for (const r of Object.values(recs.current)) { if (r) { r.onPartial = null; r.onError = null } } }, [])
  // the engine changed in the menu above: use the new one next press
  React.useEffect(() => { const f = () => { recs.current = {} }; window.addEventListener(EV_AUDIO_DEVICES, f); return () => window.removeEventListener(EV_AUDIO_DEVICES, f) }, [])

  const words = line.split(' ')
  const lineToks = toks(line)
  // colour the line's words by whether they were heard (token positions mapped back roughly word by word)
  const hitWord = (wi: number) => { if (!result) return undefined; const k = Math.min(lineToks.length - 1, Math.round(wi * lineToks.length / words.length)); return result.hit[k] }
  const notReady = engine === 'local' && states.stt.state !== 'ready'
  return (
    <Group title="Test your voice" hint="Hold the button, read the line out like on the radio, let go. Read it word for word and the next line comes up by itself">
      <div className={s.vt} data-testid="voice-test">
        <p className={s.vtSay}>Say{streak ? <span className={s.vtStreak}>{streak} in a row</span> : null}</p>
        <p className={s.vtLine} data-testid="voice-test-line">
          {words.map((w, i) => <span key={i} data-hit={hitWord(i) === undefined ? undefined : hitWord(i) ? 'y' : 'n'}>{w} </span>)}
        </p>
        <button type="button" className={s.vtHold} data-held={held || undefined} disabled={notReady}
          onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); down() }} onPointerUp={() => void up()} onPointerCancel={() => void up()}
          onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); down() } }} onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') void up() }}
          data-testid="voice-test-hold">
          <Icon name="radio" size={18} />{notReady ? 'Download the model above first' : held ? 'Listening… release to send' : 'Hold to talk'}
        </button>
        <div className={s.vtOut} aria-live="polite">
          {partial ? <p className={s.vtPartial}>{partial}</p> : null}
          {heard ? (
            <>
              <p className={s.vtHeard} data-testid="voice-test-heard">“{heard.text || 'nothing heard'}”</p>
              <p className={s.vtScore} data-ok={result?.exact || undefined}>
                {result?.exact ? <><Icon name="circle-check" size={14} /> 100 % word for word, next line…</> : `${Math.round((result?.score ?? 0) * 100)} % of the words · try again`}
                <span className={s.vtMs}> · text {heard.ms} ms after release</span>
              </p>
            </>
          ) : null}
          {err ? <p className={s.err}>{err}</p> : null}
        </div>
        <button type="button" className={s.vtSkip} onClick={() => { setIdx((i) => (i + 1) % LINES.length); setHeard(null) }} data-testid="voice-test-skip">Another line</button>
      </div>
    </Group>
  )
}
