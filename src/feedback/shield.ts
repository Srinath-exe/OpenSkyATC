import { UI_ATTR } from "./limits";

/*
  The game listens for keys on window in the capture phase (Space talks, Esc opens the pause menu). This listener is put
  there first (instrumentation-client.ts), so keys typed into the reporter never reach the game.
*/
export const OPEN_EVENT = "skycontrol:report";
type KeyHandler = (e: KeyboardEvent) => boolean;
let handler: KeyHandler | null = null;
let installed = false;
export const setKeyHandler = (h: KeyHandler | null) => { handler = h; };
export const inReporter = (e: Event) => e.composedPath().some((n) => n instanceof Element && n.hasAttribute(UI_ATTR));

export function installShield() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyU") {
      e.preventDefault(); e.stopImmediatePropagation();
      window.dispatchEvent(new Event(OPEN_EVENT));
      return;
    }
    if (handler?.(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (inReporter(e)) e.stopImmediatePropagation(); // typing and Tab still work: only the listeners are stopped
  }, true);
  // keyup is left alone: a push-to-talk key let go while the panel opens must still end the transmission
}
