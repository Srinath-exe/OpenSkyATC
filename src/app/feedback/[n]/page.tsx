'use client'
/* One report: what was sent on the left, where it stands on the right. A player sees their own, shorter. */
import * as React from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/design'
import { api } from '@/feedback/transport'
import { findLength } from '@/feedback/recorder'
import type { EventRow, FileRow, Report } from '@/lib/feedback/store'
import { ago, Chip, KIND, SEV, STATUS, type Me } from '../ui'
import s from '../feedback.module.css'

type Net = { method: string; url: string; status: number | null; ms: number; requestId: string | null; at: string }
type Full = Omit<Report, 'files' | 'events' | 'context' | 'element'> & { mine: boolean; files: Array<FileRow & { url: string | null }>; events: EventRow[]; element: { text?: string; tag?: string; selector?: string; heading?: string | null; components?: string[]; data?: Record<string, string> } | null; context: { console?: Array<{ level: string; message: string; at: string }>; network?: Net[]; game?: Record<string, unknown>; screen?: Record<string, string> } | null }
const clock = (n: number | null) => (n ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : '')

export default function Page() {
  const { n } = useParams<{ n: string }>(); const router = useRouter()
  const [r, setR] = React.useState<Full | null>(null)
  const [me, setMe] = React.useState<Me | null>(null)
  const [missing, setMissing] = React.useState(false)
  const [note, setNote] = React.useState(''); const [internal, setInternal] = React.useState(false)
  const [busy, setBusy] = React.useState(false); const [msg, setMsg] = React.useState<string | null>(null)
  const load = React.useCallback(() => api<Full & Record<string, unknown>>('GET', `reports/${n}`).then(setR, (e: Error) => { if (!/HTTP|fetch/.test(e.message)) setMissing(true) }), [n])
  React.useEffect(() => { void api<Me & Record<string, unknown>>('GET', 'me').then(setMe).catch(() => undefined); void load() }, [load])
  const waiting = r && (r.ai_state === 'READING' || (r.ai_state === 'WAITING' && r.files_state === 'READY') || r.files_state === 'UPLOADING')
  React.useEffect(() => { if (!waiting) return; const t = window.setInterval(() => { if (!document.hidden) void load() }, 3000); return () => window.clearInterval(t) }, [waiting, load])
  const again = React.useRef(0)
  const stale = () => { if (Date.now() - again.current > 10_000) { again.current = Date.now(); void load() } } // a signed link that has run out
  const act = async (method: string, path: string, body: unknown) => {
    setBusy(true); setMsg(null)
    try { setR(await api<Full & Record<string, unknown>>(method, `reports/${n}${path}`, body)); setNote('') } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  if (missing) return <main className={s.page}><p className={s.none}>There is no report here that you can see.</p><Link href="/feedback" className={s.back}>All reports</Link></main>
  if (!r) return <main className={s.page} aria-busy="true" />
  const team = !!me?.triager
  const of = (k: string) => r.files.filter((f) => f.kind === k)
  const stills = of('STILL').sort((a, b) => a.file_name.localeCompare(b.file_name)); const poster = stills.find((f) => f.url)?.url ?? undefined
  const net = r.context?.network ?? []; const bad = net.filter((x) => x.status == null || x.status >= 400); const good = net.filter((x) => !bad.includes(x))
  const move = (to: string, label: string, primary = false) => <Button key={to + label} size="sm" variant={primary ? 'accent' : 'secondary'} disabled={busy} onClick={() => void act('PATCH', '', { status: to, ...(note.trim() ? { note: note.trim(), internal } : {}) })}>{label}</Button>
  const next = { NEW: [move('CHECKING', 'Start checking', true), move('FIXED', 'Mark fixed'), move('WONT_CHANGE', "Won't change")], CHECKING: [move('FIXED', 'Mark fixed', true), move('WONT_CHANGE', "Won't change"), move('NEW', 'Back to new')], FIXED: [move('TESTED', 'Tested, it works', true), move('NEW', 'Reopen')], TESTED: [move('NEW', 'Reopen')], WONT_CHANGE: [move('NEW', 'Reopen')] }[r.status]
  const markdown = () => [`# Report #${r.number}: ${r.title}`, `${STATUS[r.status]} · ${KIND[r.kind]} · ${SEV[r.severity]} · ${r.environment} · build ${r.app_version ?? '?'}`, `Page: ${r.url ?? ''} (${r.page_title ?? ''})`, r.ai ? `\n${r.ai.summary}\n\nAsked for:\n${r.ai.asks.map((x) => `- ${x}`).join('\n')}${r.ai.transcript ? `\n\nSaid: ${r.ai.transcript}` : ''}` : '', r.body ? `\nTyped: ${r.body}` : '', r.element ? `\nHighlighted: \`${r.element.selector}\` "${r.element.text ?? ''}" in ${r.element.heading ?? '-'}; components ${r.element.components?.join(' < ') ?? '-'}; ${JSON.stringify(r.element.data ?? {})}` : '', bad.length ? `\nFailed calls:\n${bad.map((x) => `- ${x.method} ${x.url} ${x.status ?? 'no answer'} (${x.requestId ?? 'no id'})`).join('\n')}` : '', r.context?.console?.length ? `\nConsole:\n${r.context.console.slice(-15).map((x) => `- ${x.level}: ${x.message.split('\n')[0]}`).join('\n')}` : '', `\nWhole report and its files: node scripts/feedback.mjs show ${r.number}`].filter(Boolean).join('\n')
  const calls = (list: Net[]) => <table className={s.calls}><tbody>{list.map((x, i) => <tr key={i} data-bad={x.status == null || x.status >= 400 || undefined}><td>{x.method}</td><td>{x.url}</td><td>{x.status ?? 'no answer'}</td><td>{x.ms} ms</td><td><code>{x.requestId ?? ''}</code></td></tr>)}</tbody></table>
  return (
    <main className={s.page}>
      <button type="button" className={s.back} onClick={() => { if (window.history.length > 1) router.back(); else router.push('/feedback') }}>← Back</button>
      <h1 className={s.title}><span>#{r.number}</span> {r.title}</h1>
      <p className={s.meta}><Chip k="status" v={r.status} /><Chip k="kind" v={r.kind} /><Chip k="severity" v={r.severity} />{r.files_state === 'UPLOADING' ? <span className={s.muted}>files still uploading</span> : null}</p>
      <div className={s.cols}>
        <section className={s.sent} aria-label="What was sent">
          {team && r.ai_state !== 'OFF' ? <div className={s.card}>
            {r.ai ? <><p>{r.ai.summary}</p>{r.ai.asks.length ? <ul>{r.ai.asks.map((x) => <li key={x}>{x}</li>)}</ul> : null}{r.ai.mentions.length ? <p className={s.muted}>Mentions: {r.ai.mentions.join(', ')}</p> : null}{r.ai.steps_to_reproduce.length ? <ol>{r.ai.steps_to_reproduce.map((x) => <li key={x}>{x}</li>)}</ol> : null}{r.ai.transcript ? <details><summary>What was said</summary><p>{r.ai.transcript}</p></details> : null}</>
              : <p className={s.muted}>{r.ai_state === 'FAILED' ? r.ai_error : 'The AI is reading this…'}</p>}
            <button type="button" className={s.link} disabled={busy} onClick={() => void act('POST', '/read', {})}>Read again</button>
          </div> : null}
          {of('RECORDING').map((f) => f.url ? <video key={f.id} className={s.media} src={f.url} poster={poster} controls playsInline preload="metadata" onLoadedMetadata={(e) => findLength(e.currentTarget)} onError={stale} /> : <p key={f.id} className={s.muted}>The recording ({clock(f.seconds)}) was deleted after the keeping time.</p>)}
          {of('VOICE').map((f) => f.url ? <p key={f.id} className={s.voice}><audio src={f.url} controls preload="metadata" onLoadedMetadata={(e) => findLength(e.currentTarget)} onError={stale} /><span>{clock(f.seconds)}</span></p> : <p key={f.id} className={s.muted}>The voice note was deleted after the keeping time.</p>)}
          {r.body ? <blockquote className={s.words}>{r.body}</blockquote> : null}
          {(['steps', 'expected', 'actual'] as const).map((k) => r[k] ? <p key={k} className={s.pre}><b>{k === 'steps' ? 'Steps' : k === 'expected' ? 'Expected' : 'Actual'}</b>{'\n'}{r[k]}</p> : null)}
          {[...of('SCREENSHOT'), ...of('FILE')].map((f) => f.url ? f.content_type.startsWith('image/') ? <a key={f.id} href={f.url} target="_blank" rel="noreferrer"><img className={s.media} src={f.url} alt={f.file_name} onError={stale} /></a> : <a key={f.id} href={f.url} className={s.link}>{f.file_name}</a> : null)}
          {stills.length && team ? <div className={s.stills}>{stills.map((f) => f.url ? <a key={f.id} href={f.url} target="_blank" rel="noreferrer"><img src={f.url} alt={f.file_name} onError={stale} /></a> : null)}</div> : null}
          {r.element ? <div className={s.card}><h2>The part they picked</h2><p>{r.element.text ? <>&ldquo;{r.element.text}&rdquo;</> : r.element.tag}{r.element.heading ? <> in <b>{r.element.heading}</b></> : null}</p>{team ? <><code className={s.code}>{r.element.selector}</code>{r.element.components?.length ? <p className={s.muted}>{r.element.components.join(' ‹ ')}</p> : null}{r.element.data && Object.keys(r.element.data).length ? <p className={s.muted}>{Object.entries(r.element.data).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p> : null}</> : null}</div> : null}
          {team && bad.length ? <div className={s.card}><h2>Calls that failed</h2>{calls(bad)}</div> : null}
          {team && good.length ? <details className={s.card}><summary>Other calls ({good.length})</summary>{calls(good)}</details> : null}
          {team && r.context?.console?.length ? <details className={s.card}><summary>Console ({r.context.console.length})</summary><pre>{r.context.console.map((x) => `${x.level} ${x.message}`).join('\n')}</pre></details> : null}
          {team && r.context?.game ? <details className={s.card}><summary>The game: radio, speech, settings</summary><pre>{JSON.stringify(r.context.game, null, 1)}</pre></details> : null}
        </section>
        <aside className={s.side} aria-label="Where it stands">
          {team ? <div className={s.next}>{next}</div> : null}
          {r.mine && !team && r.status === 'FIXED' ? <div className={s.next}><p>The team says this is fixed.</p><Button size="sm" variant="accent" disabled={busy} onClick={() => void act('POST', '/verdict', { verdict: 'works', note: note.trim() || undefined })}>It works</Button><Button size="sm" disabled={busy} onClick={() => void act('POST', '/verdict', { verdict: 'still_wrong', note: note.trim() || undefined })}>Still wrong</Button></div> : null}
          <textarea className={s.note} value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder={team ? internal ? 'A note for the team' : 'A note to the reporter' : 'Add a note'} aria-label="Note" />
          <div className={s.noteRow}>{team ? <label><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal</label> : <span />}<Button size="sm" disabled={busy || !note.trim()} onClick={() => void act('POST', '/notes', { note: note.trim(), internal })}>Add note</Button></div>
          {msg ? <p className={s.warn} role="alert">{msg}</p> : null}
          {team ? <>
            <div className={s.sets}>
              <label>Kind<select value={r.kind} onChange={(e) => void act('PATCH', '', { kind: e.target.value })}>{Object.entries(KIND).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
              <label>Severity<select value={r.severity} onChange={(e) => void act('PATCH', '', { severity: e.target.value })}>{Object.entries(SEV).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
            </div>
            {r.maybe_duplicate_of ? <p className={s.warn}>Looks like <Link href={`/feedback/${r.maybe_duplicate_of}`}>#{r.maybe_duplicate_of}</Link>. <button type="button" className={s.link} onClick={() => void act('PATCH', '', { duplicate_of: r.maybe_duplicate_of })}>It is the same</button> <button type="button" className={s.link} onClick={() => void act('PATCH', '', { duplicate_of: null })}>It is not</button></p> : null}
            {r.duplicate_of ? <p className={s.muted}>Duplicate of <Link href={`/feedback/${r.duplicate_of}`}>#{r.duplicate_of}</Link></p> : null}
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(markdown()).then(() => setMsg('Copied.'), () => setMsg('The browser did not allow copying.'))}>Copy for an agent</Button>
          </> : null}
          <dl className={s.facts}>
            <div><dt>From</dt><dd>{r.reporter_name ?? r.agent_name}</dd></div><div><dt>When</dt><dd>{ago(r.created_at)}</dd></div>
            {r.url ? <div><dt>Page</dt><dd><a href={r.url}>{r.page_title || r.url}</a></dd></div> : null}
            {team ? <><div><dt>Build</dt><dd>{r.environment} {r.app_version}</dd></div>{r.context?.screen ? <div><dt>Screen</dt><dd>{r.context.screen.viewport} · {r.context.screen.ua}</dd></div> : null}</> : null}
          </dl>
          <ol className={s.history}>{r.events.map((e) => <li key={e.id} data-internal={e.internal || undefined}><b>{e.actor_name}</b> {e.to_status ? (e.from_status ? `${STATUS[e.from_status]} → ${STATUS[e.to_status]}` : 'sent it') : ''}{e.commit_sha ? <code> {e.commit_sha.slice(0, 9)}</code> : null}<time dateTime={e.created_at}>{ago(e.created_at)}</time>{e.note ? <p>{e.note}</p> : null}</li>)}</ol>
          {team ? <button type="button" className={s.link} onClick={() => { if (window.confirm(`Delete #${r.number} and its files?`)) void api('DELETE', `reports/${n}`).then(() => router.push('/feedback'), (e: Error) => setMsg(e.message)) }}>Delete this report</button> : null}
        </aside>
      </div>
    </main>
  )
}
