// the commit a report or a crash came from
let build = process.env.SKYCONTROL_BUILD || ''
if (!build) try { const git = (a) => require('child_process').execSync(`git ${a}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); build = git('rev-parse --short HEAD') + (git('status --porcelain -uno --ignore-submodules') ? '+' : '') } catch { build = 'dev' /* not a checkout */ }

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST || '.next',   // a trial build beside the one the live server runs from
  env: { NEXT_PUBLIC_BUILD: build },
  allowedDevOrigins: ['localhost'],
  poweredByHeader: false,
  // /api/voice/stt runs Whisper on onnxruntime-node, which transformers.js loads through createRequire: the file tracer
  // cannot see it, so the standalone bundle lists it here (CPU binaries only; the CUDA/TensorRT providers are 500 MB).
  outputFileTracingIncludes: {
    '/api/voice/stt': [
      './node_modules/onnxruntime-node/package.json',
      './node_modules/onnxruntime-node/dist/*.js',
      './node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node',
      './node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1',
      './node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so',
      './node_modules/onnxruntime-common/**/*',
      // transformers.js imports its own sharp (0.35, libvips 8.18) at load; the tracer misses the native libraries
      './node_modules/@huggingface/transformers/node_modules/@img/sharp-linux-x64/**/*',
      './node_modules/@huggingface/transformers/node_modules/@img/sharp-libvips-linux-x64/**/*',
      // Parakeet (engine.ts) runs on sherpa-onnx-node: its addon picks the platform package by a computed path, and the
      // addon loads its own onnxruntime and sherpa libraries from beside it ($ORIGIN)
      './node_modules/sherpa-onnx-node/package.json',
      './node_modules/sherpa-onnx-node/*.js',
      './node_modules/sherpa-onnx-linux-x64/package.json',
      './node_modules/sherpa-onnx-linux-x64/index.js',
      './node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node',
      './node_modules/sherpa-onnx-linux-x64/*.so',
    ],
  },
  // a native addon: required at run time from node_modules, never bundled
  serverExternalPackages: ['sherpa-onnx-node'],
  // /api/voice/gold reads and writes ml/data/gold of the checkout at run time (outside the bundle); without this the
  // tracer copies all of ml/ (datasets, checkpoints) and mobile/ (Flutter build) into .next/standalone (~5 GB).
  outputFileTracingExcludes: {
    '*': ['./ml/**', './mobile/**', './data/**', './film/**', './video/**', './refrence/**', './docs/**', './tests/**', './test-results/**', './playwright-report/**', './cache/**', './context/**', './public/**', './.scratch*/**', './.tmp/**', './.impeccable/**', './*.mp4'],
  },
  // The baked worlds and the aircraft models are large and immutable per version (their URLs carry ?v=): cache them for
  // a year so a returning player downloads nothing but the page. Everything else keeps Next's revalidation defaults.
  async headers() {
    const inner = ['/lab/:path*', '/design', '/map3d', '/reports/:path*', '/feedback/:path*', '/voice/record.html', '/taxi', '/play', '/atc', '/api/:path*', '/dl/:path*', '/downloads/:path*']
    return [
      { source: '/:path*', headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'Strict-Transport-Security', value: 'max-age=15552000' },
        { key: 'Permissions-Policy', value: 'microphone=(self), display-capture=(self), camera=(), geolocation=(), payment=(), usb=()' },
      ] },
      // the team's own screens, and screens that are a running session: not for search engines
      ...inner.map((source) => ({ source, headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] })),
      { source: '/world/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/models/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      // the landing film's frames, video pieces and tracks (fetched with ?v=ASSET_V)
      { source: '/landing/sfo/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/landing/sfo-p/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ]
  },
}
module.exports = nextConfig
