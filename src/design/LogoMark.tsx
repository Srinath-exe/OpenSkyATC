import * as React from 'react'

/* The OpenATC mark: one aircraft tail fin, folded once, in the accent orange. Two faces that share the fold.
   Small sizes use flatter, brighter shades so the shadow face stays orange. Icon files: scripts/brand/build.cjs. */
const LIT = 'M36 452 C110 446 152 408 188 350 L372 56 L248 452 Z'
const SHADE = 'M372 56 L456 56 L352 452 L248 452 Z'
const LARGE = { lit: [[0, '#ffab4f'], [0.3, '#ff9c47'], [0.62, '#df823a'], [1, '#ff9a46']], shade: [[0, '#c36d2f'], [0.28, '#934a1d'], [0.7, '#6e2f0f'], [1, '#884319']] } as const
const SMALL = { lit: [[0, '#ffb25c'], [1, '#f5933f']], shade: [[0, '#d2752f'], [0.5, '#b4571c'], [1, '#a54d17']] } as const

export function LogoMark({ size = 28, opacity = 1, testId, style, ...rest }: { size?: number; opacity?: number; testId?: string } & React.SVGProps<SVGSVGElement>) {
  const id = React.useId()
  const c = size <= 40 ? SMALL : LARGE
  return (
    <svg width={size} height={size} viewBox="36 44 420 420" aria-hidden="true" data-testid={testId} style={{ opacity, flex: 'none', ...style }} {...rest}>
      <defs>
        <linearGradient id={`${id}l`} gradientUnits="userSpaceOnUse" x1="380" y1="60" x2="120" y2="452">{c.lit.map(([o, v]) => <stop key={o} offset={o} stopColor={v} />)}</linearGradient>
        <linearGradient id={`${id}s`} gradientUnits="userSpaceOnUse" x1="420" y1="56" x2="300" y2="452">{c.shade.map(([o, v]) => <stop key={o} offset={o} stopColor={v} />)}</linearGradient>
      </defs>
      <path d={SHADE} fill={`url(#${id}s)`} />
      <path d={LIT} fill={`url(#${id}l)`} />
    </svg>
  )
}
