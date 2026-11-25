import { MASK_ATTR, UI_ATTR } from "./limits";
import { cleanText } from "./redact";

export interface Box { x: number; y: number; w: number; h: number }
export interface PickedElement {
  selector: string; tag: string; text: string; heading: string | null; label: string | null;
  data: Record<string, string>; components: string[]; rect: Box;
}

const squash = (s: string | null | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const parentOf = (el: Element): Element | null =>
  el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null);

export function describeElement(el: Element): PickedElement {
  const r = el.getBoundingClientRect();
  const isPrivate = !!el.closest(`[${MASK_ATTR}]`) || !!el.querySelector(`[${MASK_ATTR}]`);
  const isTyped = !!el.closest("input, textarea, [contenteditable]"); // the words on the page, not what someone typed
  const data: Record<string, string> = {};
  for (let n: Element | null = el, i = 0; n && i < 4 && !isPrivate; n = parentOf(n), i++)
    for (const a of Array.from(n.attributes))
      if (a.name.startsWith("data-") && a.name !== UI_ATTR && !(a.name in data)) data[a.name] = cleanText(a.value).slice(0, 120);
  return {
    selector: selectorOf(el),
    tag: el.tagName.toLowerCase(),
    text: isPrivate ? "" : cleanText(squash((!isTyped && (el as HTMLElement).innerText) || el.getAttribute("placeholder"), 300)),
    heading: headingFor(el),
    label: squash(el.getAttribute("aria-label") ?? el.closest("[aria-label]")?.getAttribute("aria-label"), 120) || null,
    data,
    components: componentsOf(el),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
  };
}

/** A CSS path a person (or an agent) can paste into the console. */
function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n && n !== document.body && parts.length < 7; n = parentOf(n)) {
    const node: Element = n;
    const testId = node.getAttribute("data-testid");
    if (testId) { parts.unshift(`[data-testid="${CSS.escape(testId)}"]`); break; }
    // useId() and the like change on every load, so they are no use as an address.
    if (node.id && !/^[:«]|^radix-|^headlessui-|^react-aria|:r\w+:/.test(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    const tag = node.tagName.toLowerCase();
    const same = Array.from(node.parentElement?.children ?? []).filter((c) => c.tagName === node.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
  }
  return parts.join(" > ");
}

/** The nearest heading before or around it: which part of the page it is in. */
function headingFor(el: Element): string | null {
  for (let n: Element | null = el; n; n = parentOf(n)) {
    const before = Array.from(n.querySelectorAll("h1, h2, h3, h4, [role=heading]")).filter(
      (h) => !h.closest(`[${UI_ATTR}]`) && (h === el || h.contains(el) || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0));
    const last = before[before.length - 1];
    if (last) return squash(last.textContent, 120) || null;
  }
  return null;
}

/** React component names from the element up, where the build kept them. Drop this for other frameworks. */
function componentsOf(el: Element): string[] {
  type Fiber = { type?: unknown; return?: Fiber | null };
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  let f: Fiber | null = key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
  const names: string[] = [];
  for (let i = 0; f && i < 60 && names.length < 6; f = f.return ?? null, i++) {
    const t = f.type as { displayName?: string; name?: string } | string | null | undefined;
    const name = t && typeof t !== "string" ? t.displayName ?? t.name : null;
    if (name && /^[A-Z][A-Za-z0-9]{2,}$/.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** What the screen is called: its main heading, else the tab's title. */
export function pageHeading(): string {
  const h = Array.from(document.querySelectorAll("main h1, h1")).find((x) => !x.closest(`[${UI_ATTR}]`));
  return squash(h?.textContent, 120) || squash(document.title, 120);
}

/** Record ids and document numbers in the address. */
export function idsInAddress(): string[] {
  let path = window.location.pathname + window.location.search;
  try { path = decodeURIComponent(path); } catch { /* a stray % is fine as it is */ }
  const uuids = path.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi) ?? [];
  const numbers = path.match(/\b[A-Z]{2,5}-(?:\d{4}-\d{3,5}|\d{3,6})\b/g) ?? []; // ORD-1042, INV-2026-0007: fit to this app
  return Array.from(new Set([...uuids, ...numbers])).slice(0, 10);
}
