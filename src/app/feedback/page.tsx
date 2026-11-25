'use client'
/* The reports: a triager's list, or a player's own ("My reports"). */
import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button, LogoMark } from '@/design'
import { api } from '@/feedback/transport'
import { ago, Chip, KIND, SEV, type Me, type Row } from './ui'
import s from './feedback.module.css'

const TABS: Array<[string, string, string[]]> = [['todo', 'To do', ['NEW', 'CHECKING']], ['fixed', 'Fixed', ['FIXED']], ['done', 'Done', ['TESTED', 'WONT_CHANGE']], ['all', 'All', []]]
interface List { reports: Row[]; counts: Record<string, number>; people: string[]; next: number | null }

function Reports() {
  const q = useSearchParams(); const router = useRouter()
  const [me, setMe] = React.useState<Me | null>(null)
  const [list, setList] = React.useState<List | null>(null)
  const [error, setError] = React.useState(false)
  const [search, setSearch] = React.useState(q.get('q') ?? '')
  const [shown, setShown] = React.useState(30)
  const team = !!me?.triager && q.get('mine') !== '1'
  const tab = TABS.find((t) => t[0] === (q.get('tab') ?? (team ? 'todo' : 'all'))) ?? TABS[0]
  const set = React.useCallback((k: string, v: string) => { const n = new URLSearchParams(window.location.search); if (v) n.set(k, v); else n.delete(k); n.delete('signin'); router.replace(`/feedback${n.size ? `?${n}` : ''}`, { scroll: false }) }, [router])
  const query = React.useMemo(() => {
    const n = new URLSearchParams()
    for (const k of ['kind', 'severity', 'environment', 'person', 'q']) { const v = q.get(k); if (v) n.set(k, v) }
    if (tab[2].length) n.set('status', tab[2].join(','))
    if (!team) n.set('mine', '1')
    n.set('limit', String(Math.min(100, shown)))
    return n.toString()
  }, [q, tab, team, shown])
  React.useEffect(() => { api<Me & Record<string, unknown>>('GET', 'me').then((m) => setMe(m), () => setError(true)) }, [])
  React.useEffect(() => {
    if (!me) return
    let live = true
    const load = () => { if (!document.hidden) api<List & Record<string, unknown>>('GET', `reports?${query}`).then((l) => { if (live) { setList(l); setError(false) } }, () => live && setError(true)) }
    load(); const t = window.setInterval(load, 15_000); document.addEventListener('visibilitychange', load)
    return () => { live = false; window.clearInterval(t); document.removeEventListener('visibilitychange', load) }
  }, [me, query])
  React.useEffect(() => { const t = window.setTimeout(() => { if (search !== (q.get('q') ?? '')) set('q', search) }, 300); return () => window.clearTimeout(t) }, [search, q, set])
  const pick = (k: string, label: string, opts: Array<[string, string]>) => (
    <label className={s.sel}><span className="sr-only">{label}</span><select value={q.get(k) ?? ''} onChange={(e) => set(k, e.target.value)}><option value="">{label}</option>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
  )
  const count = (st: string[]) => (st.length ? st : ['NEW', 'CHECKING', 'FIXED', 'TESTED', 'WONT_CHANGE']).reduce((a, x) => a + (list?.counts[x] ?? 0), 0)
  return (
    <main className={s.page}>
      <header className={s.top}><Link href="/" className={s.home} aria-label="OpenATC"><LogoMark size={26} /></Link><h1>{team ? 'Reports' : 'My reports'}</h1>
        {me?.triager ? <Link className={s.mine} href={team ? '/feedback?mine=1' : '/feedback'}>{team ? 'My own' : 'Everyone’s'}</Link> : null}</header>
      {q.get('signin') === 'expired' ? <p className={s.warn}>That sign-in link has been used or has run out. Make a new one with <code>node scripts/feedback.mjs signin</code>.</p> : null}
      <div className={s.tabs} role="tablist">{TABS.map((t) => <button key={t[0]} type="button" role="tab" aria-selected={t === tab} onClick={() => set('tab', t[0])}>{t[1]}<em>{list ? count(t[2]) : ''}</em></button>)}</div>
      {team ? <div className={s.filters}>
        <input className={s.search} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Number, words, person, page" aria-label="Search" />
        {pick('kind', 'Any kind', Object.entries(KIND))}{pick('severity', 'Any severity', Object.entries(SEV))}{pick('environment', 'Anywhere', [['production', 'Live site'], ['sandbox', 'Sandbox']])}{pick('person', 'Anyone', (list?.people ?? []).map((p) => [p, p]))}
      </div> : null}
      {error && !list ? <p className={s.warn}>The reports could not be loaded. Trying again.</p> : null}
      {list && !list.reports.length ? <p className={s.none}>{team ? 'Nothing here.' : 'You have not sent a report from this browser yet. Press the report icon beside the bell while you play.'}</p> : null}
      <ul className={s.list}>{list?.reports.map((r) => (
        <li key={r.number}><Link href={`/feedback/${r.number}`} className={s.row}>
          <b className={s.num}>#{r.number}</b>
          <span className={s.what}><strong>{r.title}</strong>{r.summary && r.summary !== r.title ? <small>{r.summary}</small> : null}</span>
          <span className={s.tags}><Chip k="status" v={r.status} /><Chip k="severity" v={r.severity} /><Chip k="kind" v={r.kind} /></span>
          <span className={s.who}>{team ? <>{r.reporter_name}<br /></> : null}<time dateTime={r.created_at}>{ago(r.created_at)}</time>{r.environment === 'sandbox' && team ? ' · sandbox' : ''}</span>
        </Link></li>))}</ul>
      {list?.next && shown < 100 ? <Button onClick={() => setShown((n) => n + 35)}>Show more</Button> : null}
    </main>
  )
}
export default function Page() { return <React.Suspense fallback={null}><Reports /></React.Suspense> }
