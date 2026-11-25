import { UI_ATTR } from "./limits";

export interface Picker { wider(): void; narrower(): void; confirm(): void; cancel(): void }

/**
 * Picking a part of the page. Mouse: hover outlines, click takes it. Touch: a tap outlines
 * and `confirm()` (a button in the bar) takes it, since a finger has no hover.
 * Keyboard: ArrowUp = the part around it, ArrowDown = back in, Enter = take, Escape = cancel.
 *
 * Listeners sit on window in the capture phase so the app sees none of it. A pick is read
 * from pointerup, not click, because a disabled button never fires click.
 */
export function startPicking(on: { target(el: Element): void; pick(el: Element | null): void; cancel(): void }): Picker {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const abort = new AbortController();
  const opts = { capture: true, signal: abort.signal } as const;
  let target: Element | null = null;
  let inner: Element[] = []; // what wider() stepped out of
  let down: { x: number; y: number } | null = null;

  const ours = (e: Event) => e.composedPath().some((n) => n instanceof Element && n.hasAttribute(UI_ATTR));
  const block = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const at = (x: number, y: number): Element | null => {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const deeper = el.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === el) break;
      el = deeper;
    }
    return el && !el.closest(`[${UI_ATTR}]`) ? el : null;
  };
  const aim = (el: Element | null, keepInner = false) => {
    if (!el || el === target) return;
    if (!keepInner) inner = [];
    target = el;
    on.target(el);
  };
  const end = () => {
    abort.abort();
    document.documentElement.style.cursor = "";
    // The click that follows this pointerup must not reach the app either.
    const swallow = new AbortController();
    window.addEventListener("click", (e) => { if (!ours(e)) block(e); swallow.abort(); }, { capture: true, signal: swallow.signal });
    window.setTimeout(() => swallow.abort(), 350);
  };
  const take = () => {
    const el = target;
    end();
    (document.activeElement as HTMLElement | null)?.blur?.();
    // The page itself is not a part of it: that is the whole screen.
    on.pick(!el || el === document.documentElement || el === document.body ? null : el);
  };
  const cancel = () => { end(); on.cancel(); };
  const wider = () => {
    const up = target?.parentElement;
    if (!target || !up || up === document.documentElement) return;
    inner.push(target);
    aim(up, true);
  };
  const narrower = () => { const back = inner.pop(); if (back) aim(back, true); };

  window.addEventListener("pointermove", (e) => {
    if (coarse || ours(e)) return;
    const el = at(e.clientX, e.clientY);
    if (inner.length && target?.contains(el)) return; // stepped wider: hold it while the mouse is inside
    aim(el);
  }, opts);
  window.addEventListener("pointerdown", (e) => { if (ours(e)) return; block(e); down = { x: e.clientX, y: e.clientY }; }, opts);
  window.addEventListener("pointercancel", () => { down = null; }, opts); // the finger was scrolling
  window.addEventListener("pointerup", (e) => {
    if (ours(e)) return;
    block(e);
    const moved = !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10;
    down = null;
    if (moved || e.button !== 0) return;
    // After ArrowUp a click takes the wider part, not what is under the pointer.
    if (coarse || !inner.length) aim(at(e.clientX, e.clientY));
    if (!coarse && target) take();
  }, opts);
  // Text boxes must not take focus (a phone opens its keyboard), press-to-open menus must not open.
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"])
    window.addEventListener(type, (e) => { if (!ours(e)) block(e); }, opts);
  window.addEventListener("keydown", (e) => {
    const act = { Escape: cancel, Enter: () => target && take(), ArrowUp: wider, ArrowDown: narrower }[e.key];
    if (!act || (ours(e) && e.key === "Enter")) return; // Enter on the bar's own buttons is theirs
    block(e);
    act();
  }, opts);
  document.documentElement.style.cursor = "crosshair";
  return { wider, narrower, confirm: take, cancel };
}
