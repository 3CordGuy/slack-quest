// Modifiers: what makes one map unlike the next beyond its ground and its
// size. The atlas rolls a few onto each node (atlas.ts); a map's options
// carry their ids (`ZoneOptions.mods`), and everything that reads a map's
// danger asks `modsOf` what they add up to.
//
// Two kinds. A map modifier changes the ground: more clutter, more high
// ground, a bigger map, or patches of something on the ground that do not
// wear off. An enemy modifier changes whoever stands on it: how much they
// take, how hard and how surely they hit, how far they move, how many there
// are. Each one adds to what clearing the map pays.

import type { SurfaceKind, ZoneOptions, ZoneSize } from "./types";

export type ZoneModId = "tangled" | "craggy" | "sprawling" | "smouldering" | "fouled" | "slick" | "frozen" | "hardy" | "savage" | "swift" | "numerous";

export interface ZoneModDef {
  id: ZoneModId;
  name: string;
  /** What it changes: the ground, or the enemy. A map modifier means nothing in a sea cave, whose ground is the caverns' own. */
  kind: "map" | "enemy";
  /** What it does, in a line, for the chart. */
  blurb: string;
  /** How much more clearing the map pays, as a share (0.15 is 15% more). */
  pay: number;
  /** Steps of clutter and of high ground added (each runs 0 to 3). */
  obstacles?: number;
  elevation?: number;
  /** The map is this size whatever it would have been, with this many more enemy groups. */
  size?: ZoneSize;
  groups?: number;
  /** Patches of this lie on the ground and stay. */
  hazard?: SurfaceKind;
  /** Enemy health, as a multiplier. */
  hp?: number;
  /** Added to every enemy attack's damage and its bonus to hit. */
  edge?: number;
  /** Hexes of movement added to every enemy's turn. */
  move?: number;
  /** More in every group: another of whoever came with its leader. */
  extras?: number;
}

export const ZONE_MODS: Record<ZoneModId, ZoneModDef> = {
  tangled: { id: "tangled", name: "Tangled", kind: "map", blurb: "Thick with rock and trees: little open ground, and cover everywhere.", pay: 0.1, obstacles: 2 },
  craggy: { id: "craggy", name: "Craggy", kind: "map", blurb: "Hills and crowns of high ground all over it.", pay: 0.1, elevation: 2 },
  sprawling: { id: "sprawling", name: "Sprawling", kind: "map", blurb: "A big place, with one more band on it.", pay: 0.2, size: "large", groups: 1 },
  smouldering: { id: "smouldering", name: "Smouldering", kind: "map", blurb: "Fire burns on the ground in patches, and does not go out.", pay: 0.15, hazard: "fire" },
  fouled: { id: "fouled", name: "Fouled", kind: "map", blurb: "Pools of poison lie about, and stay.", pay: 0.15, hazard: "poison" },
  slick: { id: "slick", name: "Slick", kind: "map", blurb: "Oil on the ground in patches: slow going, and one spark sets it off.", pay: 0.1, hazard: "oil" },
  frozen: { id: "frozen", name: "Frozen", kind: "map", blurb: "Sheets of ice that will not melt on their own.", pay: 0.1, hazard: "ice" },
  hardy: { id: "hardy", name: "Hardy", kind: "enemy", blurb: "Everything here takes a third more killing.", pay: 0.2, hp: 1.3 },
  savage: { id: "savage", name: "Savage", kind: "enemy", blurb: "They hit harder, and miss less.", pay: 0.2, edge: 1 },
  swift: { id: "swift", name: "Swift", kind: "enemy", blurb: "They cover one more hex a turn.", pay: 0.15, move: 1 },
  numerous: { id: "numerous", name: "Numerous", kind: "enemy", blurb: "One more in every band.", pay: 0.25, extras: 1 },
};

export const ZONE_MOD_IDS = Object.keys(ZONE_MODS) as ZoneModId[];
/** The most a map carries. */
export const MAX_MODS = 4;

/** Modifier ids as they came off the wire, made safe: the ones there are, each once, with one kind of ground at most. */
export function cleanMods(raw: unknown): ZoneModId[] {
  if (!Array.isArray(raw)) return [];
  const out: ZoneModId[] = [];
  for (const id of raw) {
    const def = ZONE_MODS[id as ZoneModId];
    if (!def || out.includes(def.id)) continue;
    if (def.hazard && out.some((o) => ZONE_MODS[o].hazard)) continue;
    out.push(def.id);
    if (out.length >= MAX_MODS) break;
  }
  return out;
}

/** What a map's modifiers add up to. With none, nothing changes. */
export interface ModSum {
  obstacles: number;
  elevation: number;
  size?: ZoneSize;
  groups: number;
  hazard?: SurfaceKind;
  hp: number;
  edge: number;
  move: number;
  extras: number;
  /** The share added to what clearing the map pays. */
  pay: number;
}

export function modsOf(options: Pick<ZoneOptions, "mods"> | undefined): ModSum {
  const sum: ModSum = { obstacles: 0, elevation: 0, groups: 0, hp: 1, edge: 0, move: 0, extras: 0, pay: 0 };
  for (const id of options?.mods ?? []) {
    const def = ZONE_MODS[id as ZoneModId];
    if (!def) continue;
    sum.obstacles += def.obstacles ?? 0;
    sum.elevation += def.elevation ?? 0;
    sum.groups += def.groups ?? 0;
    sum.size = def.size ?? sum.size;
    sum.hazard = def.hazard ?? sum.hazard;
    sum.hp *= def.hp ?? 1;
    sum.edge += def.edge ?? 0;
    sum.move += def.move ?? 0;
    sum.extras += def.extras ?? 0;
    sum.pay += def.pay;
  }
  return sum;
}
