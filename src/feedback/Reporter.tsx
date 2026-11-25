'use client'
/*
  The reporter: record the screen, take a screenshot or highlight a part, say or type the rest, send.
  One reducer holds where it is (machine.ts); streams and sessions live in refs. Keys come through shield.ts, so the game
  never sees what is typed here. Everything rendered sits under data-feedback-ui: out of screenshots, out of picking.
*/
import * as React from 'react'
import { createPortal } from 'react-dom'
import { Button, Icon, IconButton, IconX, Kbd, Toast, type ToastKind } from '@/design'
import { describeElement, type Box, type PickedElement } from './element'
import { LIMITS, UI_ATTR } from './limits'
import { saysSomething, type Draft, type Mode, type State } from './machine'
import { startPicking, type Picker } from './picker'
import { canRecordScreen, findLength, recordScreen, recordVoice, type Clip, type MicState, type Session } from './recorder'
import { takeScreenshot } from './screenshot'
import { OPEN_EVENT, setKeyHandler } from './shield'
import { collect, filesOf, game, whatIsAt, type Collected } from './collect'
import { markWaiting, onOutbox, outbox } from './transport'
import { Refused } from './outbox'
import s from './Reporter.module.css'

type Act =
  | { t: 'menu' } | { t: 'idle' } | { t: 'picking' } | { t: 'capturing'; mode: Mode; picked: PickedElement | null }
  | { t: 'recording'; mic: MicState } | { t: 'tick'; seconds: number } | { t: 'mic'; mic: MicState }
  | { t: 'compose'; draft: Draft; error?: string | null } | { t: 'edit'; patch: Partial<Draft> } | { t: 'voicing'; seconds: number | null } | { t: 'discard'; ask: boolean } | { t: 'error'; text: string | null } | { t: 'sending' }

function reduce(st: State, a: Act): State {
  switch (a.t) {
    case 'idle': return { phase: 'idle' }
    case 'menu': return st.phase === 'idle' || st.phase === 'capturing' ? { phase: 'menu' } : st
    case 'picking': return st.phase === 'menu' || st.phase === 'composing' ? { phase: 'picking' } : st
    case 'capturing': return st.phase === 'menu' || st.phase === 'picking' || st.phase === 'composing' ? { phase: 'capturing', mode: a.mode, picked: a.picked } : st
    case 'recording': return st.phase === 'capturing' ? { phase: 'recording', seconds: 0, mic: a.mic } : st
    case 'tick': return st.phase === 'recording' ? { ...st, seconds: a.seconds } : st
    case 'mic': return st.phase === 'recording' ? { ...st, mic: a.mic } : st
    case 'compose': return { phase: 'composing', draft: a.draft, voicing: null, confirmDiscard: false, error: a.error ?? null }
    case 'sending': return st.phase === 'composing' ? { phase: 'sending', draft: st.draft } : st
  }
  if (st.phase !== 'composing') return st
  switch (a.t) {
    case 'edit': return { ...st, draft: { ...st.draft, ...a.patch }, error: null, confirmDiscard: false }
    case 'voicing': return { ...st, voicing: a.seconds, error: null }
    case 'discard': return { ...st, confirmDiscard: a.ask }
    case 'error': return { ...st, error: a.text }
  }
}

const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`
const coarse = () => window.matchMedia('(pointer: coarse)').matches
const SEEN = 'skycontrol_feedback_recorded'

function useUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!blob) { setUrl(null); return }
    const u = URL.createObjectURL(blob); setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url
}

/** One frame of the screen, asked of the browser: what a DOM screenshot could not see. */
async function grabFrame(): Promise<Blob | null> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' } as DisplayMediaStreamOptions)
  try {
    const v = document.createElement('video'); v.muted = true; v.srcObject = stream
    await v.play(); await new Promise((r) => setTimeout(r, 700)) // the browser's own dialog leaves the screen first
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight
    c.getContext('2d')?.drawImage(v, 0, 0); v.srcObject = null
    return await new Promise((r) => c.toBlob(r, 'image/png'))
  } finally { stream.getTracks().forEach((t) => t.stop()) }
}

export default function Reporter() {
  const [st, go] = React.useReducer(reduce, { phase: 'menu' })
  const [toast, setToast] = React.useState<{ kind: ToastKind; text: string } | null>(null)
  const [hot, setHot] = React.useState<{ box: Box; label: string } | null>(null)
  const stRef = React.useRef(st); stRef.current = st
  const root = React.useRef<HTMLDivElement>(null)
  const picker = React.useRef<Picker | null>(null)
  const session = React.useRef<Session | null>(null)
  const voice = React.useRef<Session | null>(null)
  const held = React.useRef(false)
  const kept = React.useRef<Draft | null>(null)     // while picking again
  const about = React.useRef<Collected | null>(null)
  const before = React.useRef<HTMLElement | null>(null)
  const point = React.useRef({ x: 0, y: 0 })
  const gone = React.useRef(false)

  const say = React.useCallback((text: string, kind: ToastKind = 'info') => setToast({ text, kind }), [])
  React.useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 6000); return () => window.clearTimeout(t) }, [toast])

  // the shift waits while a part is picked and while the report is written; it goes on if it was us who stopped it
  const hold = () => { const g = game(); if (g?.engine && !g.paused && !window.location.pathname.startsWith('/learn')) { g.setPaused?.(true); held.current = true } }
  const release = () => { if (held.current) { held.current = false; game()?.setPaused?.(false) } }

  const close = React.useCallback(() => {
    voice.current?.cancel(); voice.current = null; kept.current = null; setHot(null)
    go({ t: 'idle' }); release()
    const el = document.querySelector<HTMLElement>('[data-report-anchor]') ?? before.current
    el?.focus?.({ preventScroll: true })
  }, [])

  React.useEffect(() => {
    gone.current = false
    before.current = document.activeElement as HTMLElement | null
    const open = () => {
      const p = stRef.current.phase
      if (p === 'menu') close()
      else if (p === 'idle') { before.current = document.activeElement as HTMLElement | null; go({ t: 'menu' }) }
    }
    window.addEventListener(OPEN_EVENT, open)
    onOutbox({
      sent: (n, failed) => { if (failed.length) say(`#${n}: ${failed.length === 1 ? 'one file' : `${failed.length} files`} couldn't be sent. The report is saved.`, 'attention') },
      refused: (why) => say(`The report wasn't accepted: ${why}`, 'error'),
    })
    void outbox().flush()
    return () => { gone.current = true; window.removeEventListener(OPEN_EVENT, open); picker.current?.cancel(); session.current?.cancel(); voice.current?.cancel(); release() }
  }, [close, say])

  // the app's modals trap focus and close on an outside press: none of it leaves this root
  React.useEffect(() => {
    const el = root.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    const types = ['focusin', 'pointerdown', 'mousedown', 'touchstart', 'wheel']
    types.forEach((t) => el.addEventListener(t, stop))
    return () => types.forEach((t) => el.removeEventListener(t, stop))
  }, [])

  const compose = (d: Draft, error: string | null = null) => { hold(); go({ t: 'compose', draft: d, error }) }
  const empty = (mode: Mode): Draft => ({ mode, picked: null, shot: null, clip: null, voice: null, text: '', pictures: [] })

  // ── the three ways ──
  const shoot = async (mode: Mode, picked: PickedElement | null, base: Draft | null) => {
    about.current = collect()
    hold() // a running shift draws all the time, which makes the picture three times slower
    go({ t: 'capturing', mode, picked })
    const shot = await Promise.race([takeScreenshot(picked?.rect ?? null).catch((e: unknown) => { console.warn("screenshot failed", e); return null }), new Promise<null>((r) => setTimeout(() => r(null), 30_000))])
    if (gone.current) return
    compose({ ...(base ?? empty(mode)), mode, picked, shot }, shot ? null : "The screenshot didn't work. Retake it with screen share, or add a picture.")
  }
  const pick = () => {
    go({ t: 'picking' }); hold(); setHot(null)
    const base = kept.current
    const save = (e: PointerEvent) => { point.current = { x: e.clientX, y: e.clientY } }
    window.addEventListener('pointermove', save, true); window.addEventListener('pointerup', save, true)
    const done = () => { window.removeEventListener('pointermove', save, true); window.removeEventListener('pointerup', save, true); picker.current = null; setHot(null); kept.current = null }
    const big = (el: Element) => { const r = el.getBoundingClientRect(); return (el instanceof HTMLCanvasElement || !!el.closest('.mapboxgl-map')) && r.width * r.height > innerWidth * innerHeight * 0.2 }
    const boxAt = (el: Element): Box => {
      if (big(el)) return { x: point.current.x - 55, y: point.current.y - 55, w: 110, h: 110 }
      const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    picker.current = startPicking({
      target: (el) => setHot({ box: boxAt(el), label: big(el) ? whatIsAt(point.current.x, point.current.y).aircraft ?? 'Here on the map' : (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '').trim().split('\n')[0].slice(0, 40) || el.tagName.toLowerCase() }),
      pick: (el) => {
        done()
        let p: PickedElement | null = null
        if (el) {
          p = describeElement(el)
          if (big(el)) { const b = boxAt(el); const at = whatIsAt(point.current.x, point.current.y); p = { ...p, text: at.aircraft ? `${at.aircraft} on the map` : 'A spot on the map', rect: { x: Math.round(b.x), y: Math.round(b.y), w: b.w, h: b.h }, data: { ...p.data, ...at } } }
        }
        void shoot('highlight', p, base)
      },
      cancel: () => { done(); if (base) compose(base); else close() },
    })
    if (big(document.elementFromPoint(point.current.x, point.current.y) ?? document.body)) setHot(null)
  }
  const record = async () => {
    about.current = null
    go({ t: 'capturing', mode: 'record', picked: null })
    let ses: Session
    try { ses = await recordScreen((seconds) => go({ t: 'tick', seconds })) } catch {
      if (!gone.current) { go({ t: 'menu' }); say("Screen recording didn't start. Allow screen sharing, or take a screenshot instead.", 'attention') }
      return
    }
    if (gone.current) { ses.cancel(); return }
    session.current = ses
    try { localStorage.setItem(SEEN, '1') } catch { /* storage blocked */ }
    go({ t: 'recording', mic: ses.mic })
    const clip = await ses.done
    session.current = null
    if (gone.current) return
    about.current = collect()
    if (!clip) { close(); say('Nothing was recorded. Try again, or take a screenshot.', 'attention'); return }
    compose({ ...empty('record'), clip })
  }
  const speak = async () => {
    const cur = stRef.current
    if (cur.phase !== 'composing') return
    if (voice.current) { voice.current.stop(); return }
    go({ t: 'voicing', seconds: 0 })
    let ses: Session
    try { ses = await recordVoice((n) => { if (voice.current) go({ t: 'voicing', seconds: n }) }) } catch { go({ t: 'voicing', seconds: null }); go({ t: 'error', text: 'The microphone is blocked. Allow it in the address bar, or type it.' }); return }
    if (gone.current || stRef.current.phase !== 'composing') { ses.cancel(); return }
    voice.current = ses
    const clip = await ses.done
    voice.current = null
    if (gone.current) return
    go({ t: 'voicing', seconds: null })
    if (clip) go({ t: 'edit', patch: { voice: clip } })
  }
  const retake = async () => {
    const cur = stRef.current
    if (cur.phase !== 'composing') return
    const d = cur.draft
    go({ t: 'capturing', mode: d.mode, picked: d.picked })
    const shot = await grabFrame().catch(() => null)
    if (!gone.current) compose(shot ? { ...d, shot } : d, shot ? null : "Screen sharing didn't start. Allow it, or add a picture.")
  }

  const send = async () => {
    const cur = stRef.current
    if (cur.phase !== 'composing') return
    let d = cur.draft
    if (voice.current) { // still listening: what was said so far counts
      const v = voice.current; v.stop(); const clip = await v.done
      if (clip) d = { ...d, voice: clip }
      go({ t: 'edit', patch: { voice: d.voice } })
    }
    if (!saysSomething(d)) { go({ t: 'error', text: 'Say it in a voice note, or type what needs to change.' }); return }
    go({ t: 'sending' })
    const report = { mode: d.mode, body: d.text.trim().slice(0, 20_000) || null, element: d.picked, ...(about.current ?? collect()) }
    markWaiting(true)
    const add = outbox().add(report, filesOf(d)).then(
      (r) => say(r.number ? `Thanks, sent as #${r.number}. Its files are uploading.` : "Saved. It will send when you're back online.", 'success'),
      (e: unknown) => { markWaiting(false); if (e instanceof Refused) { say(`The report wasn't accepted: ${e.message}`, 'error'); return 'refused' as const } say("Saved. It will send when you're back online.", 'info') })
    const first = await Promise.race([add, new Promise<'slow'>((r) => setTimeout(() => r('slow'), 800))])
    if (first === 'refused') { compose(d); return }
    close()
  }
  const cancel = () => {
    const cur = stRef.current
    if (cur.phase !== 'composing') { close(); return }
    const d = cur.draft
    if (!cur.confirmDiscard && (d.text.trim() || d.voice || d.clip || d.pictures.length || voice.current)) { go({ t: 'discard', ask: true }); return }
    close()
  }

  // ── keys ──
  const keys = React.useRef<(e: KeyboardEvent) => boolean>(() => false)
  keys.current = (e) => {
    const ui = e.composedPath().some((n) => n instanceof Element && n.hasAttribute(UI_ATTR))
    if (st.phase === 'picking') {
      const p = picker.current
      if (e.key === 'Tab' || (ui && (e.key === 'Enter' || e.key === ' '))) return false
      if (e.key === 'Escape') p?.cancel(); else if (e.key === 'Enter') { if (hot) p?.confirm() } else if (e.key === 'ArrowUp') p?.wider(); else if (e.key === 'ArrowDown') p?.narrower()
      return true
    }
    if (st.phase === 'menu') {
      if (e.key === 'Escape') { close(); return true }
      const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key]
      if (step || e.key === 'Home' || e.key === 'End') {
        const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []); const i = items.indexOf(document.activeElement as HTMLElement)
        items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + step + items.length) % items.length]?.focus(); return true
      }
      return false
    }
    if (st.phase === 'composing') {
      if (e.key === 'Escape') { if (st.confirmDiscard) go({ t: 'discard', ask: false }); else cancel(); return true }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { void send(); return true }
      if (e.key === 'Tab') {
        const f = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-compose] :is(button:not([disabled]), textarea, video, a[href])') ?? []); const i = f.indexOf(document.activeElement as HTMLElement)
        if (f.length && (i < 0 || (e.shiftKey ? i === 0 : i === f.length - 1))) { f[e.shiftKey ? f.length - 1 : 0].focus(); return true }
      }
    }
    return false
  }
  React.useEffect(() => {
    if (st.phase === 'idle' || st.phase === 'recording') { setKeyHandler(null); return }
    setKeyHandler((e) => keys.current(e))
    return () => setKeyHandler(null)
  }, [st.phase])

  // a press outside closes the menu; leaving the page ends a recording
  React.useEffect(() => {
    if (st.phase === 'menu') {
      const down = (e: PointerEvent) => { if (!e.composedPath().some((n) => n instanceof Element && (n.hasAttribute(UI_ATTR) || n.hasAttribute('data-report-anchor')))) close() }
      const t = window.setTimeout(() => window.addEventListener('pointerdown', down, true), 0)
      return () => { window.clearTimeout(t); window.removeEventListener('pointerdown', down, true) }
    }
    if (st.phase === 'recording') {
      const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
      window.addEventListener('beforeunload', warn)
      return () => window.removeEventListener('beforeunload', warn)
    }
  }, [st.phase, close])

  return createPortal(
    <div ref={root} className={s.root} {...{ [UI_ATTR]: '' }} data-phase={st.phase} data-testid="reporter">
      {st.phase === 'menu' ? <Menu onRecord={() => void record()} onShot={() => void shoot('screenshot', null, null)} onPick={pick} onMine={() => { window.open('/feedback', '_blank', 'noopener'); close() }} /> : null}
      {st.phase === 'picking' ? <>
        {hot ? <div className={s.hot} style={{ left: hot.box.x - 3, top: hot.box.y - 3, width: hot.box.w + 6, height: hot.box.h + 6 }} data-testid="reporter-outline"><span data-below={hot.box.y < 34 || undefined}>{hot.label}</span></div> : null}
        <div className={s.bar} data-top={!coarse() || undefined} role="toolbar" aria-label="Pick a part">
          <b>{coarse() ? 'Tap the part you mean' : 'Click the part you mean'}</b>
          {coarse() ? <><Button size="sm" onClick={() => picker.current?.wider()} disabled={!hot}>Wider</Button><Button size="sm" onClick={() => picker.current?.narrower()} disabled={!hot}>Narrower</Button><Button size="sm" variant="accent" onClick={() => picker.current?.confirm()} disabled={!hot}>Use this</Button></>
            : <span className={s.keys}><Kbd>↑</Kbd> wider <Kbd>↓</Kbd> narrower <Kbd>Esc</Kbd></span>}
          <Button size="sm" variant="ghost" onClick={() => picker.current?.cancel()} testId="reporter-pick-cancel">Cancel</Button>
        </div>
      </> : null}
      {st.phase === 'capturing' && st.mode !== 'record' ? <div className={s.dim} role="status"><span>Taking the screenshot…</span></div> : null}
      {st.phase === 'recording' ? (
        <div className={s.bar} role="toolbar" aria-label="Recording">
          <i className={s.dot} aria-hidden="true" />
          <b className={s.time} role="timer">{LIMITS.recordSeconds - st.seconds <= 15 ? `Stops in ${clock(Math.max(0, LIMITS.recordSeconds - st.seconds))}` : `Recording ${clock(st.seconds)}`}</b>
          <button type="button" className={s.mic} data-mic={st.mic} disabled={st.mic === 'none'} onClick={() => { const m = session.current?.toggleMic(); if (m) go({ t: 'mic', mic: m }) }}><Icon name={st.mic === 'on' ? 'mic' : 'mic-off'} size={16} />{st.mic === 'on' ? 'Mic on' : st.mic === 'muted' ? 'Muted' : 'No mic'}</button>
          <Button size="sm" variant="accent" onClick={() => session.current?.stop()} testId="reporter-stop">Stop</Button>
        </div>
      ) : null}
      {st.phase === 'composing' || st.phase === 'sending' ? (
        <Compose st={st} edit={(patch) => go({ t: 'edit', patch })} onSend={() => void send()} onCancel={cancel} onKeep={() => go({ t: 'discard', ask: false })} onThrow={close}
          onVoice={() => void speak()} onAgain={() => { if (st.phase === 'composing') { kept.current = st.draft; pick() } }} onRetake={() => void retake()} />
      ) : null}
      {toast ? <div className={s.toast} data-testid="reporter-toast"><Toast kind={toast.kind} text={toast.text} dismissible onDismiss={() => setToast(null)} /></div> : null}
    </div>, document.body)
}

function Menu({ onRecord, onShot, onPick, onMine }: { onRecord: () => void; onShot: () => void; onPick: () => void; onMine: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<React.CSSProperties>({})
  const [first, setFirst] = React.useState(false)
  React.useLayoutEffect(() => {
    try { setFirst(!localStorage.getItem(SEEN)) } catch { /* storage blocked */ }
    const a = Array.from(document.querySelectorAll<HTMLElement>('[data-report-anchor]')).map((x) => x.getBoundingClientRect()).find((r) => r.width)
    if (innerWidth >= 768) setPos(a ? { top: a.bottom + 10, left: Math.max(12, Math.min(innerWidth - 332, a.right - 320)) } : { top: 76, left: innerWidth / 2 - 160 })
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus({ preventScroll: true })
  }, [])
  const item = (icon: React.ComponentProps<typeof Icon>['name'], title: string, sub: string, on: () => void, id: string) => (
    <button type="button" role="menuitem" className={s.item} onClick={on} data-testid={id}><span className={s.ic}><Icon name={icon} size={18} /></span><span><b>{title}</b><small>{sub}</small></span></button>
  )
  return (
    <div ref={ref} className={s.menu} style={pos} role="menu" aria-label="Report something on this screen" data-testid="reporter-menu">
      {canRecordScreen() ? item('video', 'Record the screen', "With your voice. Stop when you're done.", onRecord, 'reporter-record') : null}
      {canRecordScreen() && first ? <p className={s.once}>The team will see everything on the screen you share.</p> : null}
      {item('camera', 'Screenshot', 'Then say or type what to change.', onShot, 'reporter-shot')}
      {item('square-mouse-pointer', 'Highlight a part', `${coarse() ? 'Tap' : 'Click'} the part, then say or type.`, onPick, 'reporter-pick')}
      <span className={s.sep} />
      {item('inbox', 'My reports', 'What you sent, and what came of it.', onMine, 'reporter-mine')}
    </div>
  )
}

function Compose({ st, edit, onSend, onCancel, onKeep, onThrow, onVoice, onAgain, onRetake }: { st: Extract<State, { phase: 'composing' | 'sending' }>; edit: (p: Partial<Draft>) => void; onSend: () => void; onCancel: () => void; onKeep: () => void; onThrow: () => void; onVoice: () => void; onAgain: () => void; onRetake: () => void }) {
  const d = st.draft; const on = st.phase === 'composing'; const voicing = on ? st.voicing : null
  const panel = React.useRef<HTMLDivElement>(null); const file = React.useRef<HTMLInputElement>(null); const text = React.useRef<HTMLTextAreaElement>(null)
  const clip = useUrl(d.clip?.blob); const poster = useUrl(d.clip?.stills[0]); const shot = useUrl(d.shot)
  React.useEffect(() => { if (coarse()) panel.current?.focus({ preventScroll: true }); else text.current?.focus({ preventScroll: true }) }, [])
  const add = (list: Iterable<File>) => {
    const ok = Array.from(list).filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type) && f.size <= LIMITS.fileBytes)
    if (ok.length) edit({ pictures: [...d.pictures, ...ok].slice(0, 4) })
  }
  return (
    <div ref={panel} className={s.panel} role="dialog" aria-label="Your report" tabIndex={-1} data-compose data-testid="reporter-compose"
      onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); add(e.clipboardData.files) } }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); add(e.dataTransfer.files) }}>
      <header className={s.head}><h2>{d.mode === 'record' ? 'Your recording' : d.mode === 'highlight' ? 'The part you picked' : 'Your screenshot'}</h2><IconButton variant="ghost" size={32} label="Close" icon={<IconX size={16} />} onClick={onCancel} testId="reporter-close" /></header>
      <div className={s.scroll}>
        {clip ? <video className={s.media} src={clip} poster={poster ?? undefined} controls playsInline preload="metadata" onLoadedMetadata={(e) => findLength(e.currentTarget)} data-testid="reporter-video" /> : null}
        {shot ? <a href={shot} target="_blank" rel="noreferrer" className={s.shot} title="Open full size"><img src={shot} alt="The screenshot" data-testid="reporter-shot-img" /></a> : null}
        {d.mode === 'highlight' ? <p className={s.part}>{d.picked ? <>Highlighted {d.picked.text || d.picked.label ? <>&ldquo;{(d.picked.text || d.picked.label || '').slice(0, 60)}&rdquo;</> : <code>{d.picked.tag}</code>}{d.picked.heading ? <> in <b>{d.picked.heading}</b></> : null}</> : 'The whole screen'} <button type="button" className={s.link} onClick={onAgain} disabled={!on}>Pick again</button></p> : null}
        {d.pictures.length ? <ul className={s.pics}>{d.pictures.map((p, i) => <Pic key={i} blob={p} onDrop={() => edit({ pictures: d.pictures.filter((_, j) => j !== i) })} />)}</ul> : null}
        {d.mode !== 'record' ? <div className={s.row}>
          {canRecordScreen() ? <button type="button" className={s.link} onClick={onRetake} disabled={!on || voicing != null}><Icon name="monitor-up" size={15} />Retake with screen share</button> : null}
          <button type="button" className={s.link} onClick={() => file.current?.click()} disabled={!on}><Icon name="image-plus" size={15} />Add a picture</button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = '' }} />
        </div> : null}
        {d.voice && voicing == null ? <VoiceNote clip={d.voice} onRemove={() => edit({ voice: null })} />
          : <button type="button" className={s.voice} data-on={voicing != null || undefined} onClick={onVoice} disabled={!on} data-testid="reporter-voice"><Icon name="mic" size={18} />{voicing != null ? <><span role="timer">Listening {clock(voicing)}</span><em>Done</em></> : <span>{d.clip?.hasVoice ? 'Add a voice note' : 'Say it: voice note'}</span>}</button>}
        <textarea ref={text} className={s.text} rows={3} value={d.text} maxLength={20_000} disabled={!on} onChange={(e) => edit({ text: e.target.value })} placeholder={d.voice || d.clip?.hasVoice ? 'Anything to add?' : 'Or type it'} aria-label="What is wrong, or what should change" data-testid="reporter-text" />
        {on && st.error ? <p className={s.err} role="alert">{st.error}</p> : null}
      </div>
      <footer className={s.foot}>
        {on && st.confirmDiscard ? <><span className={s.ask}>Throw this away?</span><Button size="sm" variant="ghost" onClick={onKeep}>Keep it</Button><Button size="sm" variant="danger" onClick={onThrow} testId="reporter-throw">Throw away</Button></>
          : <><Button size="sm" variant="ghost" onClick={onCancel} disabled={!on}>Cancel</Button><Button size="sm" variant="accent" onClick={onSend} loading={!on} disabled={!on} testId="reporter-send">Send</Button></>}
      </footer>
    </div>
  )
}

function Pic({ blob, onDrop }: { blob: Blob; onDrop: () => void }) {
  const url = useUrl(blob)
  return <li>{url ? <img src={url} alt="Added picture" /> : null}<button type="button" aria-label="Remove this picture" onClick={onDrop}><IconX size={12} /></button></li>
}

/** The length is the one measured while recording: the file itself reads 0:00 in Chrome. */
function VoiceNote({ clip, onRemove }: { clip: Clip; onRemove: () => void }) {
  const url = useUrl(clip.blob); const a = React.useRef<HTMLAudioElement>(null); const [play, setPlay] = React.useState(false)
  return (
    <div className={s.note} data-testid="reporter-note">
      <button type="button" className={s.playBtn} aria-label={play ? 'Pause the voice note' : 'Play the voice note'} onClick={() => { const el = a.current; if (!el) return; if (play) el.pause(); else void el.play().catch(() => undefined) }}><Icon name={play ? 'pause' : 'play'} size={16} /></button>
      <span>Voice note {clock(clip.seconds)}</span>
      <button type="button" className={s.link} onClick={onRemove}>Remove</button>
      {url ? <audio ref={a} src={url} onPlay={() => setPlay(true)} onPause={() => setPlay(false)} onEnded={() => setPlay(false)} onLoadedMetadata={(e) => findLength(e.currentTarget)} /> : null}
    </div>
  )
}
