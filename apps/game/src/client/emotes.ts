// Emotes heard from a place's connection, carried to its view: someone here
// waved, cheered, bowed, danced or breakdanced (see EMOTES), and their figure is to do it.
// Like gaze.ts, so that the connection (the Harbor, a hut, the pub or a map)
// and the view need not know each other.

import type { Emote } from "@gantt-quest/world";

type Fn = (id: string, emote: Emote) => void;
const heard = new Set<Fn>();

export const emotes = {
  /** Someone here (you too) has emoted. */
  emoted(id: string, emote: Emote) {
    for (const fn of heard) fn(id, emote);
  },
  /** Returns the way to stop listening. */
  onEmoted(fn: Fn) {
    heard.add(fn);
    return () => void heard.delete(fn);
  },
};
