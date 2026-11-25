// Every OpenATC icon file from the one vector mark (src/design/LogoMark.tsx has the same two faces).
//   node scripts/brand/build.cjs            public/brand, favicon, touch icon, phone app icons, share image
const fs = require('fs'), path = require('path'), sharp = require('sharp')
const ROOT = path.join(__dirname, '../..'), at = (p) => path.join(ROOT, p)
const LIT = 'M36 452 C110 446 152 408 188 350 L372 56 L248 452 Z', SHADE = 'M372 56 L456 56 L352 452 L248 452 Z'
const LARGE = { lit: [[0, '#ffab4f'], [0.3, '#ff9c47'], [0.62, '#df823a'], [1, '#ff9a46']], shade: [[0, '#c36d2f'], [0.28, '#934a1d'], [0.7, '#6e2f0f'], [1, '#884319']] }
const SMALL = { lit: [[0, '#ffb25c'], [1, '#f5933f']], shade: [[0, '#d2752f'], [0.5, '#b4571c'], [1, '#a54d17']] }
const stops = (s) => s.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')
const defs = (c) => `<defs><linearGradient id="l" gradientUnits="userSpaceOnUse" x1="380" y1="60" x2="120" y2="452">${stops(c.lit)}</linearGradient><linearGradient id="s" gradientUnits="userSpaceOnUse" x1="420" y1="56" x2="300" y2="452">${stops(c.shade)}</linearGradient></defs>`
const faces = `<path d="${SHADE}" fill="url(#s)"/><path d="${LIT}" fill="url(#l)"/>`
const mark = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="36 44 420 420">${defs(c)}${faces}</svg>`
// a square tile: the fin takes `k` of the width, sitting slightly left so its weight is centred
const tile = (c, k, { bg = '#0b0b0c', r = 0 } = {}) => { const w = 420 / k, x = 246 - w / 2, y = 254 - w / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${w}">${defs(c)}${bg ? `<rect x="${x}" y="${y}" width="${w}" height="${w}" rx="${w * r}" fill="${bg}"/>` : ''}${faces}</svg>` }
const png = (svg, px, flat) => { let im = sharp(Buffer.from(svg.replace('<svg ', `<svg width="${px * 2}" height="${px * 2}" `))).resize(px, px); if (flat) im = im.flatten({ background: '#0b0b0c' }); return im.png().toBuffer() }
const save = (p, b) => { fs.mkdirSync(path.dirname(at(p)), { recursive: true }); fs.writeFileSync(at(p), b) }
async function main() {
  save('public/brand/openatc-mark.svg', mark(LARGE)); save('public/brand/openatc-mark-small.svg', mark(SMALL))
  save('public/brand/openatc-mark-512.png', await png(mark(LARGE), 512)); save('public/brand/openatc-icon-512.png', await png(tile(LARGE, 0.6, { r: 0.23 }), 512))
  save('src/app/icon.svg', tile(SMALL, 0.74, { r: 0.23 }))
  save('public/apple-touch-icon.png', await png(tile(LARGE, 0.6), 180, true))
  const ico = []; for (const z of [16, 32, 48]) ico.push([z, await png(tile(SMALL, z === 16 ? 0.86 : 0.78, { r: 0.2 }), z)])
  const head = Buffer.alloc(6 + 16 * ico.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(ico.length, 4); let off = head.length
  ico.forEach(([z, b], i) => { const p = 6 + 16 * i; head[p] = z; head[p + 1] = z; head.writeUInt16LE(1, p + 4); head.writeUInt16LE(32, p + 6); head.writeUInt32LE(b.length, p + 8); head.writeUInt32LE(off, p + 12); off += b.length })
  save('public/favicon.ico', Buffer.concat([head, ...ico.map((x) => x[1])]))
  const res = 'mobile/android/app/src/main/res/mipmap-'
  for (const [d, m] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) {
    save(`${res}${d}/ic_launcher.png`, await png(tile(m < 2 ? SMALL : LARGE, 0.62, { r: 0.23 }), 48 * m))
    save(`${res}${d}/ic_launcher_foreground.png`, await png(tile(LARGE, 0.42, { bg: '' }), 108 * m)) }
  for (const [d, m] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) save(`${res}${d}/launch_image.png`, await png(mark(LARGE), 112 * m))
  for (const m of [1, 2, 3]) save(`mobile/ios/Runner/Assets.xcassets/LaunchImage.imageset/LaunchImage${m > 1 ? `@${m}x` : ''}.png`, await png(mark(LARGE), 112 * m))
  const ios = 'mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset/'
  for (const f of fs.readdirSync(at(ios))) { const m = f.match(/^Icon-App-([\d.]+)x[\d.]+@(\d)x\.png$/); if (!m) continue; const px = Math.round(m[1] * m[2]); save(ios + f, await png(tile(px < 60 ? SMALL : LARGE, 0.62), px, true)) }
}
main()
