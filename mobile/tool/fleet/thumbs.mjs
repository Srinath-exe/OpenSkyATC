// The flight card's aircraft pictures, baked: each GLB the app ships (assets/fleet/*.glb, one per type + livery) drawn
// side-on, nose left, on a transparent background, with the light the web's aircraftThumb.ts uses, saved as
// assets/fleet/thumbs/<name>.webp. The phone shows these instead of rendering the model for a card.
//   node mobile/tool/fleet/thumbs.mjs            (after a fleet bake; headless Chromium via playwright)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const FLEET = path.join(ROOT, 'mobile/assets/fleet'), OUT = path.join(FLEET, 'thumbs')
const W = 780, H = 276
const only = process.argv[2]   // one GLB name, to check a picture

const types = { '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.html': 'text/html' }
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]))
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const base = `http://127.0.0.1:${server.address().port}`

const page_ = `<!doctype html><html><body style="margin:0;background:transparent">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
const W = ${W}, H = ${H}
const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; document.body.appendChild(canvas)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true })
renderer.setSize(W, H, false); renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1
const scene = new THREE.Scene()
scene.add(new THREE.HemisphereLight(0xe6eeff, 0x40444c, 1.6))
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(-2, 4, 3); scene.add(key)
const rim = new THREE.DirectionalLight(0xa8c4ff, 0.9); rim.position.set(3, 2, -3); scene.add(rim)
const camera = new THREE.PerspectiveCamera(12, W / H, 0.01, 2000)
const loader = new GLTFLoader()
window.shot = async (url) => {
  const g = (await loader.loadAsync(url)).scene
  g.traverse((o) => { if (o.name === 'windows' || o.name === 'cabin') o.visible = false })
  // the baked frame: length along x with the nose toward -x, y up. Seen from +z the nose is on the left.
  const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
  const len = Math.max(size.x, size.z * 0.6), hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI / 180) / 2) * camera.aspect)
  const dist = (len * 0.54) / Math.tan(hfov / 2)
  camera.position.set(c.x, c.y + dist * 0.05, c.z + dist); camera.lookAt(c.x, c.y, c.z)
  scene.add(g)
  renderer.render(scene, camera)
  const u = canvas.toDataURL('image/png')
  scene.remove(g)
  return u
}
window.ready = true
</script></body></html>`
fs.writeFileSync(path.join(ROOT, 'mobile/tool/fleet/.thumbs.html'), page_)

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
page.on('pageerror', (e) => console.error('page:', e.message))
await page.goto(`${base}/mobile/tool/fleet/.thumbs.html`)
await page.waitForFunction(() => window.ready === true)
fs.mkdirSync(OUT, { recursive: true })
const glbs = fs.readdirSync(FLEET).filter((f) => f.endsWith('.glb') && (!only || f === only))
let bytes = 0
for (const f of glbs) {
  const url = await page.evaluate((u) => window.shot(u), `/mobile/assets/fleet/${f}`)
  const png = Buffer.from(url.split(',')[1], 'base64')
  const out = path.join(OUT, f.replace(/\.glb$/, '.webp'))
  await sharp(png).trim({ threshold: 0 }).webp({ quality: 82, alphaQuality: 90 }).toFile(out)
  bytes += fs.statSync(out).size
}
console.log(`${glbs.length} pictures, ${(bytes / 1e6).toFixed(1)} MB -> ${path.relative(ROOT, OUT)}`)
await browser.close()
server.close()
fs.rmSync(path.join(ROOT, 'mobile/tool/fleet/.thumbs.html'))
