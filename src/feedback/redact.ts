const SECRET_PARAM = /(token|secret|passw|pwd|api_?key|^key$|^code$|^otp$|^auth|session|^sig$|signature|credential)/i;

/** Same-origin URLs lose the origin; secret-looking query values and token-carrying hashes go. */
export function cleanUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw, window.location.href); } catch { return raw.slice(0, 300); }
  for (const k of Array.from(u.searchParams.keys())) if (SECRET_PARAM.test(k)) u.searchParams.set(k, "removed");
  if (u.hash.includes("=")) u.hash = "";
  u.username = "";
  u.password = "";
  return (u.origin === window.location.origin ? `${u.pathname}${u.search}${u.hash}` : u.href).slice(0, 2000);
}

export function cleanText(s: string): string {
  return s
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[token]")
    .replace(/\b(bearer|basic)\s+[\w.+/=~-]{8,}/gi, "$1 [token]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1[removed]");
}
