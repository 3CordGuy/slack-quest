// "Fancy graphics": the finishing pass (glow, tilt-shift blur, colour grade)
// and characters that take the light where they stand. One setting for every
// view, remembered on this device. Off unless the player turns it on: it
// costs a phone some battery.

const KEY = "gq.graphics.fancy";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let on = read();
const listeners = new Set<() => void>();

export const fancy = {
  get: () => on,
  set(next: boolean) {
    if (next === on) return;
    on = next;
    try {
      if (on) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      // Private windows and blocked storage: the setting lasts until the page closes.
    }
    for (const fn of listeners) fn();
  },
  /** Calls `fn` whenever the setting changes; returns the way to stop. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
