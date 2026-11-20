// Going from one place to another without a loading screen.
//
// When the player sets off for another place (into the pub, back out to the
// Harbor, through the waygate), the view on the screen is asked for its last
// picture. That picture is laid under the game, pushing in gently toward
// where their hero stands, and only then is the next view made. The next view
// starts unseen, is built over the picture, and fades in over it once it has
// a place of its own to show. So a door is one move through, not a cut to the
// anchor and back.
//
// The order is the point. The push and the fade are the browser's own
// animations of `transform` and `opacity`, which go on smoothly while the
// page is busy: but only once the browser has shown their first frame. So the
// picture is put up and given a frame or two to reach the screen (leaveFor)
// before any of the work of building the next place begins.
//
// If the next place is slow (a poor connection), its view fades in anyway
// after HOLD_MS, showing its veil (veil.ts), so nobody stares at a still.

/** How long a picture is kept with no view taking it up, before it is put away. */
const FRESH_MS = 1500;
/** How long the next view stays unseen with no place built, before it shows its veil. */
export const HOLD_MS = 700;
/** How long the next place takes to fade in over the picture. */
const FADE_MS = 280;
/** How long the picture goes on pushing in, and how far. */
const PUSH_MS = 1100;
const PUSH = 1.14;
/** How far out the new place starts from as it fades in, and how long it takes to settle back. */
const SETTLE = 1.05;
const SETTLE_MS = 520;

/** A view that can be asked for its picture as the player leaves it. */
export interface Showing {
  /**
   * Draw now, and say where the picture is: the canvas just drawn on, and where on it the player's hero stands
   * (shares of its width and height). Null if the view has nothing of its own on the screen yet.
   */
  picture(): { canvas: HTMLCanvasElement; origin: { x: number; y: number } | null } | null;
}

let showing: Showing | null = null;
let over: { el: HTMLCanvasElement; taken: boolean } | null = null;
let forget = 0;

/**
 * Dev server only: what happened at each change of place and when (ms since the page loaded), in `__gqSeam`, with
 * every stretch of 50 ms or more in which the page drew no frame ("stall"). For tuning this by the numbers.
 */
const note: (what: string, more?: number) => void = import.meta.env.DEV
  ? (what, more) => ((globalThis as { __gqSeam?: unknown[] }).__gqSeam ??= []).push(more === undefined ? [what, Math.round(performance.now())] : [what, Math.round(performance.now()), more])
  : () => {};
function watchStalls(which: object) {
  if (!import.meta.env.DEV) return;
  let last = performance.now();
  const tick = (now: number) => {
    if (now - last >= 50) note("stall", Math.round(now - last));
    last = now;
    if (over === which) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** This view is now the one on the screen. */
export function nowShowing(view: Showing) {
  showing = view;
}

/** This view has left the screen (nothing changes if another has taken its place already). */
export function notShowing(view: Showing) {
  if (showing === view) showing = null;
}

function putAway(which = over) {
  if (!which) return;
  which.el.remove();
  if (over === which) {
    over = null;
    clearTimeout(forget);
  }
}

function untaken() {
  clearTimeout(forget);
  const which = over;
  forget = window.setTimeout(() => {
    if (which && over === which && !which.taken) putAway(which);
  }, FRESH_MS);
}

/**
 * The player is going somewhere else: `go` makes the change (the view on the screen is taken down, the next made).
 * The picture of where they are is put up first and given a moment to reach the screen, then `go` is called.
 * With nothing on the screen to take a picture of, `go` is called at once.
 */
export function leaveFor(go: () => void) {
  const from = showing?.picture() ?? null;
  if (!from || from.canvas.width === 0 || from.canvas.height === 0) return go();
  const el = document.createElement("canvas");
  el.width = from.canvas.width;
  el.height = from.canvas.height;
  const ctx = el.getContext("2d");
  try {
    ctx!.drawImage(from.canvas, 0, 0);
  } catch {
    // A lost context has nothing to copy: the next view starts under its veil.
    return go();
  }
  // Exactly where the view's own canvas is, under the game: the game's panels stay over it.
  const box = from.canvas.getBoundingClientRect();
  const x = Math.min(0.85, Math.max(0.15, from.origin?.x ?? 0.5));
  const y = Math.min(0.85, Math.max(0.15, from.origin?.y ?? 0.5));
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;pointer-events:none;will-change:transform;transform-origin:${(x * 100).toFixed(1)}% ${(y * 100).toFixed(1)}%;`;
  putAway();
  document.body.insertBefore(el, document.body.firstChild);
  if (!still() && typeof el.animate === "function") el.animate([{ transform: "scale(1)" }, { transform: `scale(${PUSH})` }], { duration: PUSH_MS, easing: "cubic-bezier(0.25, 0.1, 0.25, 1)", fill: "forwards" });
  over = { el, taken: false };
  untaken();
  note("leave");
  watchStalls(over);
  // Two frames: one for the picture to be laid out, one for it to be on the screen and moving. (A page nobody is
  // looking at is given no frames: it goes on after a moment regardless.)
  let gone = false;
  const run = () => {
    if (gone) return;
    gone = true;
    note("go");
    go();
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 150);
}

/** The last view's picture under a view while its place is built. */
export interface Carried {
  /** performance.now() when the view took it up. */
  readonly since: number;
  /** The place is ready: fade in over the picture, settling back from a little closer in. */
  reveal(): void;
  /** The place is taking too long: fade in anyway, showing the veil. */
  giveWay(): void;
  /** The view is going before it showed anything: the picture is left for whoever comes after it. */
  release(): void;
}

/**
 * Start this view unseen over the last view's picture, if there is one. Null if not: the view shows from the
 * start, under its veil, as on first coming to the game.
 */
export function takeOver(canvas: HTMLCanvasElement): Carried | null {
  const mine = over;
  if (!mine || mine.taken) return null;
  mine.taken = true;
  clearTimeout(forget);
  canvas.style.opacity = "0";
  note("taken");
  let done = false;
  const show = (settle: boolean) => {
    if (done) return;
    done = true;
    note(settle ? "reveal" : "gave way");
    canvas.style.opacity = "";
    if (typeof canvas.animate !== "function") return putAway(mine);
    if (settle && !still()) canvas.animate([{ transform: `scale(${SETTLE})` }, { transform: "scale(1)" }], { duration: SETTLE_MS, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" });
    const fade = canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
    fade.onfinish = fade.oncancel = () => {
      note("shown");
      putAway(mine);
    };
  };
  return {
    since: performance.now(),
    reveal: () => show(true),
    giveWay: () => show(false),
    release() {
      if (done) return;
      done = true;
      canvas.style.opacity = "";
      mine.taken = false;
      if (over === mine) untaken();
    },
  };
}
