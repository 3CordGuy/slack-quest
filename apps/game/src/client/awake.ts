// Whether the player is here: the tab is showing and they have touched it
// lately. A place's connection closes while they are away (nobody pays for
// an idle socket, and the crew stops seeing someone who has wandered off)
// and opens again the moment they come back.

import { useSyncExternalStore } from "react";

/** Away once the tab has been hidden this long. */
const HIDDEN_MS = 60_000;
/** Or once nothing has been pressed, moved or scrolled for this long, with the tab showing. */
const STILL_MS = 10 * 60_000;
/** How often to look, while here. Only a timer: nothing is sent. */
const CHECK_MS = 15_000;

const heard = new Set<() => void>();
let awake = true;
let lastStir = Date.now();
let hiddenAt: number | null = null;
let started = false;

function set(next: boolean) {
  if (next === awake) return;
  awake = next;
  for (const fn of heard) fn();
}

function check() {
  const now = Date.now();
  set(!((hiddenAt !== null && now - hiddenAt >= HIDDEN_MS) || now - lastStir >= STILL_MS));
}

function stir() {
  lastStir = Date.now();
  if (!awake && hiddenAt === null) set(true);
}

function start() {
  if (started) return;
  started = true;
  hiddenAt = document.hidden ? Date.now() : null;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else {
      // Coming back to the tab is a stir: back at once.
      hiddenAt = null;
      stir();
    }
  });
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, stir, { passive: true, capture: true });
  }
  setInterval(check, CHECK_MS);
}

function subscribe(fn: () => void) {
  start();
  heard.add(fn);
  return () => void heard.delete(fn);
}

/** True while the player is here; false once they have been away a while. */
export function useAwake(): boolean {
  return useSyncExternalStore(subscribe, () => awake);
}
