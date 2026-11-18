// Your own hero's look while a change of gear made in the sea bag is on its way to the server.
//
// The bag (InventoryScreen.tsx) knows what the hero will be wearing the moment a piece is put on. The
// view the hero stands in draws them from what its room tells it, and the room hears of the change
// last of all. So the bag says here what it shows, and the view draws that for your own hero until
// the room has caught up (wearAhead.ts lookToDraw). One hero, one look: kept for the whole page, as
// the bag and the view under it are different parts of it.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { outfitKey, type Outfit } from "@gantt-quest/world";
import { LOOK_HOLD_MS, lookToDraw, type LookAhead } from "./wearAhead";

let ahead: { shown: Outfit; settledAt: number | null } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

export const ownLook = {
  /** A change is on its way: this is what the hero wears once it is made. */
  show(outfit: Outfit) {
    clearTimeout(timer);
    ahead = { shown: outfit, settledAt: null };
    tell();
  },
  /**
   * Every change has been answered (or the bag was shut on them), and this is what the hero wears: what was
   * last shown, if nothing is given. It is drawn a little longer, for the room to catch up.
   */
  settle(outfit?: Outfit) {
    if (!ahead) return;
    clearTimeout(timer);
    ahead = { shown: outfit ?? ahead.shown, settledAt: performance.now() };
    timer = setTimeout(ownLook.drop, LOOK_HOLD_MS);
    tell();
  },
  /** Done with: the room's own telling is drawn again. */
  drop() {
    clearTimeout(timer);
    if (!ahead) return;
    ahead = null;
    tell();
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The outfit to draw for your own hero: what the room tells (`told`), or what the bag shows while the room has yet to catch up with it. */
export function useOwnLook(told: Outfit | undefined): Outfit | undefined {
  const now = useSyncExternalStore(subscribe, () => ahead);
  /** What the room was telling when the bag first showed a look of its own. */
  const toldThen = useRef<string | null>(null);
  if (!now) toldThen.current = null;
  else if (toldThen.current === null) toldThen.current = outfitKey(told);
  const full: LookAhead | null = now ? { ...now, toldThen: toldThen.current ?? "" } : null;
  const { outfit, over } = lookToDraw(full, told, performance.now());
  useEffect(() => {
    if (over) ownLook.drop();
  }, [over]);
  return outfit;
}
