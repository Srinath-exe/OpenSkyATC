'use client'
/*
  "A better model is ready": asks a player who already has a model on this device whether to take the new one
  (lib/models/updates.ts). Update downloads beside the old one, which keeps working until the new one has loaded; Later asks
  again tomorrow; Skip is for this version only. Never over a first visit, the tutorial or a test run.
*/
import * as React from 'react'
import { sim } from '@/components/atc/simStore'
import { downloadModel, updateAvailable, useModels, type ModelId } from '@/lib/models/manager'
import { isSnoozed, onReleases, releases, snooze, watchReleases } from '@/lib/models/updates'
import styles from './ModelUpdate.module.css'

const mb = (b: number) => (b >= 10e6 ? Math.round(b / 1e6) : (b / 1e6).toFixed(1)) + ' MB'

export function ModelUpdate() {
  const { states } = useModels()
  const [, again] = React.useReducer((x: number) => x + 1, 0)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<'done' | 'failed' | null>(null)
  React.useEffect(() => { if (sim.testMode && !(window as unknown as { __forceModelUpdate?: boolean }).__forceModelUpdate) return; watchReleases(); return onReleases(again) }, [])
  const due = (['stt', 's1'] as ModelId[]).filter((id) => { const r = releases()[id]; return r && updateAvailable(id, states[id]) && !isSnoozed(id, r.version) })
  const [asked, setAsked] = React.useState<ModelId[]>([])
  const list = busy || result ? asked : due
  if (!list.length) return null
  const rel = list.map((id) => releases()[id]!).filter(Boolean)
  const total = rel.reduce((a, r) => a + r.bytes, 0)
  const run = async () => {
    const ids = result === 'failed' ? asked : due; setAsked(ids); setBusy(true); setResult(null)
    let ok = true; for (const id of ids) ok = (await downloadModel(id)) && ok
    setBusy(false); setResult(ok ? 'done' : 'failed'); if (ok) window.setTimeout(() => setResult(null), 4000)
  }
  const put = (forever: boolean) => { for (const id of list) { const r = releases()[id]; if (r) snooze(id, r.version, forever) } setResult(null); again() }
  const progress = list.reduce((a, id) => a + (states[id].state === 'downloading' ? states[id].progress : result === 'done' || !updateAvailable(id, states[id]) ? 1 : 0) * (releases()[id]?.bytes ?? 0), 0) / (total || 1)
  return (
    <section className={styles.card} role="status" aria-live="polite" data-testid="model-update" data-state={busy ? 'busy' : result ?? 'ask'}>
      <h2>{result === 'done' ? 'Updated' : busy ? 'Updating' : result === 'failed' ? 'The update did not finish' : list.length > 1 ? 'Better AI models are ready' : `A better ${rel[0].title.toLowerCase()} is ready`}</h2>
      {result === 'done' ? <p>You are on the newest version.</p> : busy ? (
        <><div className={styles.bar}><i style={{ width: `${Math.round(progress * 100)}%` }} /></div><p>{Math.round(progress * 100)} % of {mb(total)}. Keep playing: the old one works until it is done.</p></>
      ) : result === 'failed' ? <p>Your current model still works. Check the connection and try again.</p> : (
        <ul>{rel.map((r) => <li key={r.title}><b>{r.title}</b> <span>{mb(r.bytes)}</span><br />{r.notes.join('. ')}</li>)}</ul>
      )}
      {busy || result === 'done' ? null : (
        <div className={styles.row}>
          <button type="button" className={styles.go} onClick={() => void run()} data-testid="model-update-go">{result === 'failed' ? 'Try again' : `Update (${mb(total)})`}</button>
          <button type="button" onClick={() => put(false)} data-testid="model-update-later">Later</button>
          <button type="button" onClick={() => put(true)} data-testid="model-update-skip">Skip this version</button>
        </div>
      )}
    </section>
  )
}
