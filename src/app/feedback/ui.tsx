'use client'
/* Reports: shared bits of the list and the report page. */
import * as React from 'react'
import s from './feedback.module.css'

export interface Row { number: number; title: string; summary: string | null; status: string; kind: string; severity: string; reporter_name: string | null; source: string; environment: string; route: string | null; mode: string | null; files_state: string; ai_state: string; created_at: string }
export interface Me { name: string | null; triager: boolean; ai: boolean }
export const STATUS: Record<string, string> = { NEW: 'New', CHECKING: 'Checking', FIXED: 'Fixed', TESTED: 'Tested', WONT_CHANGE: "Won't change" }
export const KIND: Record<string, string> = { BUG: 'Bug', CHANGE: 'Change', QUESTION: 'Question' }
export const SEV: Record<string, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' }
export const Chip = ({ k, v }: { k: 'status' | 'severity' | 'kind'; v: string }) => <span className={s.chip} data-k={k} data-v={v}>{(k === 'status' ? STATUS : k === 'kind' ? KIND : SEV)[v] ?? v}</span>
export function ago(iso: string): string {
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${Math.floor(m)} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : m < 43200 ? `${Math.floor(m / 1440)} d ago` : new Date(iso).toLocaleDateString('en')
}
