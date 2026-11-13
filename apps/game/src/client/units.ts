// "Measures": metric or imperial, for the weights and lengths of catches.
// One setting for every view, remembered on this device. Until it is set it
// follows the browser's region: pounds and inches in the US, Liberia and
// Myanmar, kilograms and centimetres everywhere else.

import type { Units } from "@gantt-quest/world";

const KEY = "gq.units";

function guess(): Units {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return region === "US" || region === "LR" || region === "MM" ? "imperial" : "metric";
  } catch {
    return "metric";
  }
}

function read(): Units {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "metric" || v === "imperial") return v;
  } catch {
    // Storage is off: the region's measures it is.
  }
  return guess();
}

let current = read();
const listeners = new Set<() => void>();

export const units = {
  get: () => current,
  set(next: Units) {
    if (next === current) return;
    current = next;
    try {
      localStorage.setItem(KEY, next);
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
