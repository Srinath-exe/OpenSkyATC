/*
  The map, the clouds and the hangar are WebGL canvases without preserveDrawingBuffer: read outside their own frame they
  are blank. Ask for a repaint, read every visible one in the same frame, and hand the picture over through toDataURL
  (which is what modern-screenshot calls) until the screenshot is done.
*/
export const REPAINT_EVENT = "skycontrol:repaint";

export async function holdWebgl(): Promise<() => void> {
  const seen = Array.from(document.querySelectorAll("canvas")).filter((c) => {
    const r = c.getBoundingClientRect();
    if (!c.width || !c.height || !r.width || !r.height) return false;
    try { return !!(c.getContext("webgl2") ?? c.getContext("webgl")); } catch { return false; }
  });
  if (!seen.length) return () => undefined;
  const held: HTMLCanvasElement[] = [];
  await new Promise<void>((done) => {
    // after this frame's loops have queued their next one, so ours runs after theirs
    setTimeout(() => {
      window.dispatchEvent(new Event(REPAINT_EVENT));
      requestAnimationFrame(() => {
        for (const c of seen) {
          try {
            const copy = document.createElement("canvas");
            const k = Math.min(1, 2560 / c.width);
            copy.width = Math.round(c.width * k); copy.height = Math.round(c.height * k);
            copy.getContext("2d")!.drawImage(c, 0, 0, copy.width, copy.height);
            const url = copy.toDataURL("image/webp", 0.92);
            c.toDataURL = () => url;
            held.push(c);
          } catch { /* a lost context: it stays blank */ }
        }
        done();
      });
    }, 0);
  });
  return () => { for (const c of held) delete (c as { toDataURL?: unknown }).toDataURL; };
}
