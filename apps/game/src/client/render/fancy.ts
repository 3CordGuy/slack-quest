// "Fancy graphics": the finishing pass
// (glow, tilt-shift blur, colour grade) and the water and weather that go with it. One setting for every view,
// remembered on this device. Off unless the player turns it on: it
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

// "Fancy grass": the thick fields of blades (meadows, tall grass, dry patches) and the oaks' crowns of single
// leaves. Off, the open grass is a scatter of tufts and an oak's crown is a few faceted lumps, as the other
// trees are: far fewer triangles for a phone to draw. One setting for every view, remembered on this device.
// On unless the player turns it off.

const GRASS_KEY = "gq.graphics.grass";

function readGrass(): boolean {
  try {
    return localStorage.getItem(GRASS_KEY) !== "0";
  } catch {
    return true;
  }
}

let grassOn = readGrass();
const grassListeners = new Set<() => void>();

export const fancyGrass = {
  get: () => grassOn,
  set(next: boolean) {
    if (next === grassOn) return;
    grassOn = next;
    try {
      if (grassOn) localStorage.removeItem(GRASS_KEY);
      else localStorage.setItem(GRASS_KEY, "0");
    } catch {
      // Private windows and blocked storage: the setting lasts until the page closes.
    }
    for (const fn of grassListeners) fn();
  },
  /** Calls `fn` whenever the setting changes; returns the way to stop. */
  subscribe(fn: () => void): () => void {
    grassListeners.add(fn);
    return () => grassListeners.delete(fn);
  },
};
