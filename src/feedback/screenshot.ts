import { MASK_ATTR, UI_ATTR } from "./limits";
import type { Box } from "./element";
import { screenDpr } from "@/lib/dpr";
import { holdWebgl } from "./webgl";

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** The visible screen as a PNG, private parts painted over, `rect` (viewport pixels) outlined. */
export async function takeScreenshot(rect: Box | null): Promise<Blob | null> {
  // Let the menu and the hover outline leave the screen first.
  await nextFrame();
  await nextFrame();
  const { domToCanvas } = await import("modern-screenshot"); // 4.7.0, loaded only when used
  const scale = Math.min(screenDpr(), 2);
  const release = await holdWebgl(); // the 3D map is a WebGL canvas: blank unless read while it is drawn
  const canvas = await domToCanvas(document.documentElement, {
    width: window.innerWidth,
    height: window.innerHeight,
    scale,
    backgroundColor: getComputedStyle(document.body).backgroundColor.replace(/^rgba\(0, 0, 0, 0\)$/, "#ffffff"),
    timeout: 8000,
    // When the page scrolls inside <main>, not the window, the picture is otherwise of the top
    // of the page while the outline is where the person had scrolled to.
    features: { restoreScrollPosition: true, copyScrollbar: false },
    filter: (node) => !(node instanceof Element && node.hasAttribute(UI_ATTR)),
  }).finally(release);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#6b7280";
  for (const el of Array.from(document.querySelectorAll(`[${MASK_ATTR}], input[type=password], input[autocomplete^=cc-]`))) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height) ctx.fillRect(r.left, r.top, r.width, r.height);
  }
  if (rect) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#c2410c";
    ctx.fillStyle = "rgba(194, 65, 12, 0.08)";
    ctx.beginPath();
    ctx.roundRect(rect.x - 4, rect.y - 4, rect.w + 8, rect.h + 8, 6);
    ctx.fill();
    ctx.stroke();
  }
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
