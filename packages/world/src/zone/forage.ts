// Glowing mushrooms: clusters of pale caps growing against the rock in a
// delve (delve.ts sets them out). Until they are picked they glow, and light
// the hexes round them by the rules of the dark (light.ts). A hero picks
// them from beside them, or standing among them, for a few mushrooms: free
// out of a fight, an Action in one. Picked, the glow is gone.
//
// They grow on the floor and stand in nobody's way.

import { hexDistance } from "@gantt-quest/core";
import type { Poi } from "../map";
import type { Ctx } from "./engine";
import type { Unit, ZoneState } from "./types";

/** How far a cluster of glowing mushrooms lights round it, in hexes. */
export const GLOWCAP_LIGHT = 1;
/** Mushrooms a cluster gives, fewest to most, and the XP for finding them. */
export const GLOWCAP_MUSHROOMS: [number, number] = [1, 3];
export const GLOWCAP_XP = 2;

/** Why `unit` cannot pick these, in words, or null if it can. */
export function checkForage(state: ZoneState, unit: Unit, patch: Poi | undefined): string | null {
  if (!patch) return "There is nothing growing there.";
  if (patch.cleared) return "Picked already.";
  if (unit.side !== "hero" || unit.controller) return "Only your own hero can pick them.";
  if (unit.down) return "Not while you are down.";
  if (hexDistance(unit.pos, patch.pos) > 1) return "Go up to them first.";
  return state.map.pois.includes(patch) ? null : "There is nothing growing there.";
}

/** Pick a cluster that passed its check: the mushrooms go to the picker, and the glow goes out. */
export function forage(ctx: Ctx, unit: Unit, patch: Poi): void {
  patch.cleared = true;
  const mushrooms = ctx.rng.int(GLOWCAP_MUSHROOMS[0], GLOWCAP_MUSHROOMS[1]);
  ctx.events.push({ t: "foraged", id: unit.id, poi: patch.id });
  ctx.effects.push({ type: "grant", heroId: unit.id, xp: GLOWCAP_XP, resources: { mushrooms } });
  ctx.events.push({ t: "spoils", id: unit.id, xp: GLOWCAP_XP, resources: { mushrooms } });
}
