/* The browser already cuts secrets out (src/feedback/redact.ts); this does it again on what arrived. */
import { cleanText } from '../../feedback/redact';

const SECRET = /(token|secret|passw|pwd|api_?key|^key$|^code$|^otp$|^auth|session|^sig$|signature|credential)/i;
export function clean(s: string): string {
  return cleanText(s).replace(/([?&#])([^=&#\s]+)=([^&#\s"']*)/g, (m, p: string, k: string) => (SECRET.test(k) ? `${p}${k}=removed` : m));
}
export function cleanDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return clean(v);
  if (depth > 8 || v == null) return depth > 8 ? null : v;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.slice(0, 120), SECRET.test(k) && typeof x === 'string' ? '[removed]' : cleanDeep(x, depth + 1)]));
  return v;
}
