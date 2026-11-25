'use client';
/** The last net: the root layout itself broke. No styles of ours can be relied on here. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en"><body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeContent: 'center', justifyItems: 'center', gap: 14, background: '#0b0b0c', color: '#fff', font: '16px/1.5 system-ui, sans-serif', textAlign: 'center', padding: 24 }}>
      <h1 style={{ margin: 0, fontSize: 26 }}>OpenATC could not start</h1>
      <p style={{ margin: 0, color: '#c8c8c8' }}>Reload the page. If it keeps happening, write to us.</p>
      <p style={{ margin: 0, display: 'flex', gap: 16 }}><button type="button" onClick={reset} style={{ height: 44, padding: '0 22px', border: 0, borderRadius: 999, background: '#ff8a3c', color: '#1c0d03', font: '650 15px system-ui' }}>Try again</button><a href="/contact?topic=bug" style={{ color: '#ff9d5c', alignSelf: 'center' }}>Contact</a></p>
    </body></html>
  );
}
