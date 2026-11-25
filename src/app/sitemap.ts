import type { MetadataRoute } from 'next';
import { AIRPORT_PAGES } from './_lib/airportPages';
import { SITE_URL } from './_lib/site';
export default function sitemap(): MetadataRoute.Sitemap {
  const at = new Date('2026-11-25');
  const p = (path: string, priority: number, changeFrequency: 'weekly' | 'monthly' | 'yearly' = 'monthly') => ({ url: SITE_URL + path, lastModified: at, changeFrequency, priority });
  return [p('/', 1, 'weekly'), p('/start', 0.9, 'weekly'), p('/learn', 0.9), p('/about', 0.8), p('/airports', 0.8), ...AIRPORT_PAGES.map((a) => p(`/airports/${a.code}`, 0.8)), p('/hangar', 0.6), p('/credits', 0.4), p('/contact', 0.4), p('/privacy', 0.2, 'yearly'), p('/terms', 0.2, 'yearly')];
}
