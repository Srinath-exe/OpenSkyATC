// Bundle the phone core (mobile/core/core.ts + the web game's sim, parser and AI) into one script for the app's
// embedded JS engine:  node mobile/core/build.mjs   ->  mobile/assets/core/core.js
// Browser-only modules the store imports are swapped for stand-ins (sound) or emptied (React, map libraries).
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const stubs = {
  name: 'phone-stubs',
  setup(b) {
    b.onResolve({ filter: /\/sound$/ }, (a) => (a.importer.endsWith('simStore.ts') ? { path: path.join(here, 'sound.ts') } : undefined))
    // the store builds the airport through a wrapper that can return one baked ahead of time (osmAirport.ts)
    b.onResolve({ filter: /\/lib\/osmAirport$/ }, (a) => (a.importer.endsWith('simStore.ts') ? { path: path.join(here, 'osmAirport.ts') } : undefined))
    // the simple taxiway and stand names, baked ahead of time too (naming.ts)
    b.onResolve({ filter: /^\.\/naming$/ }, (a) => (/lib[\/\\]sim[\/\\]engine\.ts$/.test(a.importer) ? { path: path.join(here, 'naming.ts') } : undefined))
    // what fits along each taxi line, baked ahead of time too (taxiLimits.ts)
    b.onResolve({ filter: /^\.\/taxiLimits$/ }, (a) => (/lib[\/\\]sim[\/\\](engine|taximind)\.ts$/.test(a.importer) ? { path: path.join(here, 'taxiLimits.ts') } : undefined))
    // the tutorial's map cues are queued for the app (tutor.ts); the coach's window.setTimeout uses the timer shim
    b.onResolve({ filter: /\/WorldMap\/tutor$/ }, () => ({ path: path.join(here, 'tutor.ts') }))
    b.onLoad({ filter: /Tutorial[\/\\]runner\.ts$/ }, async (a) => ({ contents: (await import('node:fs')).readFileSync(a.path, 'utf8').replace(/window\.setTimeout/g, 'setTimeout'), loader: 'ts', resolveDir: path.dirname(a.path) }))
    // where the map's taxiway names stand: the web map's own function, cut out of layers.ts (the rest of it is three.js)
    b.onResolve({ filter: /^phone:taxiLabels$/ }, (a) => ({ path: a.path, namespace: 'cut' }))
    b.onLoad({ filter: /.*/, namespace: 'cut' }, async () => {
      const src = (await import('node:fs')).readFileSync(path.join(root, 'src/components/atc/MapboxMap/layers.ts'), 'utf8')
      const m = src.match(/export function taxiLabels\(air: [^)]*\)[\s\S]*?\n}\n/)
      if (!m) throw new Error('taxiLabels not found in MapboxMap/layers.ts')
      return { contents: m[0].replace(/air: AirData\['air'\]/, 'air: any'), loader: 'ts' }
    })
    b.onResolve({ filter: /^(react|react-dom|mapbox-gl|maplibre-gl|three)(\/.*)?$/ }, (a) => ({ path: a.path, namespace: 'empty' }))
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({
      contents: 'const n = () => undefined; export default {}; export const useRef = (v) => ({ current: v }); export const useSyncExternalStore = n; export const useEffect = n; export const useState = (v) => [v, n]; export const useMemo = (f) => f(); export const useCallback = (f) => f;',
      loader: 'js',
    }))
  },
}

const r = await build({
  entryPoints: [path.join(here, 'core.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2019',        // QuickJS in flutter_js and older JavaScriptCore: no ?. / ?? / class fields natively
  platform: 'neutral',
  mainFields: ['module', 'main'],
  outfile: path.join(root, 'mobile/assets/core/core.js'),
  tsconfig: path.join(root, 'tsconfig.json'),
  plugins: [stubs],
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_STT_MODEL_BASE': '""' },
  minify: process.argv.includes('--min'),
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
})
const out = Object.values(r.metafile.outputs)[0]
console.log(`core.js ${(out.bytes / 1024).toFixed(0)} KB`)
