'use client'
import * as React from 'react'
import { readJson, writeJson } from '../persist'

/** useState backed by localStorage (JSON). The initial render uses `fallback` so SSR and the client agree; the stored value is applied in an effect. */
export function usePersistedState<T>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  // the value is tagged with the key it belongs to: when the key changes (a per-position setting on a seat switch) the
  // old key's value is never written under the new key before the new one is read
  const [state, setState] = React.useState<{ key: string | null; value: T }>({ key: null, value: fallback })
  React.useEffect(() => {
    setState({ key, value: readJson<T>(key, fallback) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  React.useEffect(() => {
    if (state.key !== key) return
    writeJson(key, state.value)
  }, [key, state])
  const setValue = React.useCallback<React.Dispatch<React.SetStateAction<T>>>((v) => {
    setState((s) => ({ key: s.key ?? key, value: typeof v === 'function' ? (v as (p: T) => T)(s.value) : v }))
  }, [key])
  return [state.key === key ? state.value : (state.key == null ? fallback : state.value), setValue]
}
