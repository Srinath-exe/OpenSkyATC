#!/usr/bin/env node
// Publish a model update: writes public/model-updates.json, the list both the website and the phone app check.
//   1. put the new files in a NEW folder under public/models (folders are cached for a year and never change)
//   2. point scripts/models.release.json at it, with its version and what is better ("notes", shown to players)
//   3. node scripts/model-release.mjs, then deploy
// A command model that is newer than the installed apps must carry its own safety gate: this writes gate.json beside it
// (from src/lib/voice/verify-model.ts). The phone's bundled copy (mobile/assets/s1) follows the release.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const R = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const rel = JSON.parse(fs.readFileSync(path.join(R, 'scripts/models.release.json'), 'utf8'))
const stt = JSON.parse(fs.readFileSync(path.join(R, 'mobile/assets/stt_models.json'), 'utf8'))
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const out = { schema: 1, models: {} }
for (const [id, m] of Object.entries(rel)) {
  if (!/^\/models\/[\w./-]+$/.test(m.dir) || m.dir.includes('..')) throw new Error(`${id}: dir must be a folder under /models`)
  const dir = path.join(R, 'public', m.dir)
  if (id === 's1') {
    const src = fs.readFileSync(path.join(R, 'src/lib/voice/verify-model.ts'), 'utf8'), i = src.indexOf(`"${m.dir}": {`)
    if (i < 0) throw new Error(`no safety gate fitted for ${m.dir}: run ml/verify/refit.sh public${m.dir}`)
    const line = (k) => JSON.parse(src.slice(i).match(new RegExp(`\\n    ${k}: (\\{.*\\}),?\\n`))[1])
    fs.writeFileSync(path.join(dir, 'gate.json'), JSON.stringify({ full: line('full'), basic: line('basic') }))
    m.files = ['model.json', 'model.bin', 'gate.json']
    fs.mkdirSync(path.join(R, 'mobile/assets/s1'), { recursive: true })
    for (const f of m.files) fs.copyFileSync(path.join(dir, f), path.join(R, 'mobile/assets/s1', f))
    fs.writeFileSync(path.join(R, 'mobile/assets/s1/version.json'), JSON.stringify({ version: m.version, url: m.dir }))
  }
  const spec = m.phone ? stt.models.find((x) => x.id === m.phone) : null
  const files = spec ? spec.files.map((f) => ({ name: f.name, role: f.role, size: f.size, sha256: f.sha256 })) : m.files.map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size, sha256: sha(path.join(dir, name)) }))
  if (spec) for (const f of files) if (sha(path.join(dir, f.name)) !== f.sha256) throw new Error(`${id}: ${f.name} on disk is not the one in stt_models.json`)
  out.models[id] = { version: m.version, aliases: m.aliases ?? [], title: m.title, what: m.what, notes: m.notes ?? [], dir: m.dir, bytes: files.reduce((a, f) => a + f.size, 0), files,
    ...(spec ? { phone: { id: spec.id, name: spec.name, kind: spec.kind, sampleRate: spec.sampleRate, hotwords: spec.hotwords, modelType: spec.modelType ?? '', license: spec.license, source: spec.source, notes: spec.notes } } : {}) }
}
fs.writeFileSync(path.join(R, 'public/model-updates.json'), JSON.stringify(out, null, 1) + '\n')
for (const [id, m] of Object.entries(out.models)) console.log(id, m.version, (m.bytes / 1e6).toFixed(1) + ' MB', m.dir)
