// One-piece folded tail fins. Each fin is a few facets that share edges: {d, g:[x1,y1,x2,y2] gradient axis, s: stops, a: brush angle}
const fs = require('fs')
const sharp = require('sharp')
const N = +process.env.N || 1024
const LIGHT = [[0, '#ffffff'], [0.3, '#e3e7ed'], [0.62, '#b4bcc8'], [1, '#dfe4ea']]
const MID = [[0, '#c9d0d9'], [0.45, '#8d97a5'], [1, '#aab3bf']]
const DARK = [[0, '#8f99a7'], [0.28, '#565f6d'], [0.7, '#2c323c'], [1, '#4a525f']]
const V = {
  p: { name: 'One fold', facets: [
    { d: 'M36 452 C110 446 152 408 188 350 L372 56 L248 452 Z', g: [380, 60, 120, 452], s: LIGHT, a: -58 },
    { d: 'M372 56 L456 56 L352 452 L248 452 Z', g: [420, 56, 300, 452], s: DARK, a: -75 }] },
  q: { name: 'Razor', facets: [
    { d: 'M40 452 C124 442 176 394 212 346 L440 44 L236 452 Z', g: [440, 44, 110, 452], s: LIGHT, a: -55 },
    { d: 'M440 44 L362 452 L236 452 Z', g: [440, 60, 280, 452], s: DARK, a: -75 }] },
  r: { name: 'Swoop', facets: [
    { d: 'M24 452 C196 440 300 292 456 44 C376 214 312 352 264 452 Z', g: [456, 44, 80, 452], s: LIGHT, a: -55 },
    { d: 'M456 44 C420 196 398 322 388 452 L264 452 C312 352 376 214 456 44 Z', g: [450, 60, 310, 452], s: DARK, a: -70 }] },
  s: { name: 'Airliner', facets: [
    { d: 'M24 452 C186 442 262 330 378 56 C344 214 306 340 258 452 Z', g: [378, 56, 70, 452], s: LIGHT, a: -58 },
    { d: 'M378 56 L456 56 C424 190 400 322 388 452 L258 452 C306 340 344 214 378 56 Z', g: [430, 56, 310, 452], s: DARK, a: -72 }] },
  t: { name: 'Winglet', facets: [
    { d: 'M24 440 L226 372 C326 340 372 292 394 206 L436 48 L462 48 C456 232 420 388 244 418 Z', g: [450, 48, 90, 440], s: LIGHT, a: -50 },
    { d: 'M462 48 L478 48 C474 268 446 436 250 452 L24 440 L244 418 C420 388 456 232 462 48 Z', g: [470, 60, 180, 452], s: DARK, a: -60 }] },
  u: { name: 'Three planes', facets: [
    { d: 'M32 452 L182 348 L240 452 Z', g: [190, 350, 90, 452], s: [[0, '#8d97a5'], [0.6, '#5d6674'], [1, '#79828f']], a: -20 },
    { d: 'M182 348 L376 56 L240 452 Z', g: [376, 56, 200, 452], s: LIGHT, a: -60 },
    { d: 'M376 56 L452 56 L346 452 L240 452 Z', g: [420, 56, 290, 452], s: DARK, a: -75 }] },
}
const TINT = {
  '': (h) => h,
  k: (h) => mix(h, (l) => [14 + l * 0.46, 15 + l * 0.47, 18 + l * 0.5]),
  o: (h) => mix(h, (l) => [Math.min(255, 70 + l * 0.82), 18 + l * 0.6, l * 0.31]),
}
function mix(h, f) {
  const n = parseInt(h.slice(1), 16), l = ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11)
  return '#' + f(l).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}
function svg(k, finish = '', size = 0) {
  const v = V[k]; let defs = '', body = ''
  v.facets.forEach((f, i) => {
    const id = 'g' + k + finish + i
    defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f.g[0]}" y1="${f.g[1]}" x2="${f.g[2]}" y2="${f.g[3]}">${f.s.map(([o, c]) => `<stop offset="${o}" stop-color="${TINT[finish](c)}"/>`).join('')}</linearGradient>`
    body += `<path d="${f.d}" fill="url(#${id})"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"${size ? ` width="${size}" height="${size}"` : ''}><defs>${defs}</defs>${body}</svg>`
}
module.exports = { V, svg }
async function main() {
  fs.mkdirSync('m1', { recursive: true })
  const plan = {}
  const raster = (s, out, grey) => { const im = sharp(Buffer.from(s)); return (grey ? im.greyscale() : im).png().toFile(out) }
  for (const k of Object.keys(V)) {
    plan[k] = V[k].facets.map((f, i) => ({ a: f.a, f: `m1/${k}${i}.png` }))
    for (let i = 0; i < V[k].facets.length; i++) {
      await raster(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${N}" height="${N}"><rect width="512" height="512"/><path d="${V[k].facets[i].d}" fill="#fff"/></svg>`, `m1/${k}${i}.png`, true)
    }
    for (const fin of ['', 'k', 'o']) await raster(svg(k, fin, N), `m1/${k}_c${fin}.png`)
  }
  fs.writeFileSync('m1/plan.json', JSON.stringify(plan))
}
if (require.main === module) main()
