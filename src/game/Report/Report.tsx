'use client'
/* The reporter's place in the app: mounted once in the root layout, asked to open by openReport() or Ctrl/Cmd+Shift+U
   (src/feedback/shield.ts). The reporter itself (src/feedback) is loaded the first time it is opened. */
import * as React from 'react'
import { installErrorReporting } from '@/lib/report'
import { OPEN_EVENT } from '@/feedback/shield'

const Reporter = React.lazy(() => import('@/feedback/Reporter'))
export function openReport(): void { window.dispatchEvent(new Event(OPEN_EVENT)) }

export function ReportHost() {
  const [loaded, setLoaded] = React.useState(false)
  React.useEffect(() => {
    installErrorReporting()
    const on = () => setLoaded(true)
    window.addEventListener(OPEN_EVENT, on)
    // a report that could not be sent last time (no connection, closed tab) goes now
    const t = window.setTimeout(() => { try { if (localStorage.getItem('skycontrol_feedback_waiting')) void import('@/feedback/transport').then((m) => m.outbox().flush()) } catch { /* storage blocked */ } }, 4000)
    return () => { window.removeEventListener(OPEN_EVENT, on); window.clearTimeout(t) }
  }, [])
  return loaded ? <React.Suspense fallback={null}><Reporter /></React.Suspense> : null
}
