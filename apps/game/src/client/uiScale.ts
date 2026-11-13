// How big the game's HTML is drawn: the bars, panels and menus, not the 3D
// scene. Chosen in the Options menu and remembered per device.
//
// The scale is applied as CSS `zoom` on each full-screen view (`.run`), with
// the 3D stage zoomed back by the inverse so the canvas and its pixel art stay
// exactly as they were. Zoom multiplies everything inside, viewport units and
// drag offsets included, so code that turns screen pixels into CSS pixels for
// something inside a view divides by `uiZoom()`, and stylesheet viewport
// units are written as `calc(40vw / var(--ui-z, 1))`.

const KEY = "gq.uiScale";

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.1;
/**
 * The view is never laid out narrower than this many CSS pixels: on a phone
 * the larger settings are drawn only as large as still leaves the top bar
 * (and its gear) room to fit.
 */
const MIN_LAYOUT_WIDTH = 340;

const clamp = (n: number) => Math.round(Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, n)) * 100) / 100;

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw === null ? 1 : Number(raw);
    return Number.isFinite(n) ? clamp(n) : 1;
  } catch {
    return 1;
  }
}

let scale = read();
const listeners = new Set<() => void>();

let drawn = 0;

/** The scale the player chose. */
export function getUiScale(): number {
  return scale;
}

/** The scale actually drawn: the chosen one, held down on a narrow screen. */
export function uiZoom(): number {
  const room = typeof innerWidth === "number" && innerWidth > 0 ? Math.max(1, Math.floor((innerWidth / MIN_LAYOUT_WIDTH) * 100) / 100) : Infinity;
  return Math.min(scale, room);
}

/** Set the zoom the stylesheet reads; true if it changed. */
function apply(): boolean {
  const z = uiZoom();
  if (z === drawn || typeof document === "undefined") return false;
  drawn = z;
  document.documentElement.style.setProperty("--ui-zoom", String(z));
  return true;
}

export function setUiScale(next: number) {
  scale = clamp(next);
  try {
    if (scale === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(scale));
  } catch {
    // Remembered for this visit only.
  }
  apply();
  for (const fn of listeners) fn();
}

/** Hear about the scale changing (a new choice, or a resize that changes how large it can be drawn). */
export function onUiScaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

apply();
if (typeof addEventListener === "function") {
  addEventListener("resize", () => {
    if (apply()) for (const fn of listeners) fn();
  });
}
