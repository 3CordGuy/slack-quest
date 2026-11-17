// Your own walks about the Harbor are shown at the click (useHarbor.ts), before the room has answered.
// This is the part of that with no connection in it: holding an answer against what was shown.

import type { HexPos } from "@gantt-quest/core";

const samePath = (a: HexPos[], b: HexPos[]) => a.length === b.length && a.every((p, i) => p.q === b[i].q && p.r === b[i].r);

/**
 * The room has answered a walk of your own: with the walk it made, or null for none. `ahead` is what was
 * shown for each walk asked for and not yet answered, oldest first (null: nothing was shown for it). If the
 * answer is what was shown for the oldest, the picture is right already (`shown`) and the rest still stand.
 * If it is not, the room's answer is the one to show, and nothing shown ahead of it stands any longer.
 */
export function answeredWalk(ahead: (HexPos[] | null)[], path: HexPos[] | null): { ahead: (HexPos[] | null)[]; shown: boolean } {
  const first = ahead[0];
  const agrees = ahead.length > 0 && (path === null || first === null ? path === first : samePath(first, path));
  return agrees ? { ahead: ahead.slice(1), shown: true } : { ahead: [], shown: false };
}
