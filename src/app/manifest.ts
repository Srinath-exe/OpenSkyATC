import type { MetadataRoute } from 'next';
import { DESCRIPTION, SITE_NAME, TAGLINE } from './_lib/site';
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/', name: `${SITE_NAME}: ${TAGLINE.toLowerCase()}`, short_name: SITE_NAME, description: DESCRIPTION, start_url: '/start', scope: '/', display: 'standalone', orientation: 'any', background_color: '#0b0b0c', theme_color: '#0b0b0c', categories: ['games', 'simulation', 'education'], lang: 'en',
    icons: [{ src: '/brand/openatc-icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/brand/openatc-icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/brand/openatc-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
