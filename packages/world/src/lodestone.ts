// Lodestones: stones that draw a crew to a place, and pull the place off its
// course.
//
// A lodestone is an item, a hero's own, carried in the pack. To set out for
// a place on the atlas beyond the Harbor's own country, someone must put one
// into the place's slot: it is spent as the map is made. A plain lodestone
// does no more than that. One that carries modifiers (zone/mods.ts: what
// changes a map's ground or whoever stands on it; up to three) adds what it
// carries to what the place already has: the map made there is harder, and
// its bounty the richer for it.
//
// They are found in the bounty of a place cleared (zone/loot.ts), each hero
// their own, more often and carrying more the further out the place lies.
// So that nobody is ever left with nowhere to go, a plain one can always be
// cut from stone and iron (`PLAIN_STONE_COST`): what is scarce is not the
// way out, but what a stone carries.
//
// A stone is nothing but the list of what it carries, in the modifiers' own
// order, so two that carry the same are the same stone and stack. On the
// wire it is that list joined with "+" (a plain one is the empty string);
// in a pack it is an item of kind "lodestone", or "lodestone:" and the list.

import type { AtlasNode } from "./atlas";
import type { Resources } from "./hut";
import type { Rng } from "./rng";
import { MAX_MODS, ZONE_MODS, ZONE_MOD_IDS, type ZoneModId } from "./zone/mods";

/** What a lodestone carries: nothing (a plain one), or up to `STONE_MODS` modifiers. */
export type Lodestone = ZoneModId[];

/** The most a stone carries. */
export const STONE_MODS = 3;
/** What a plain lodestone is cut from. */
export const PLAIN_STONE_COST: Resources = { stone: 4, iron: 2 };

/** A stone as it came off the wire or out of the database (a list, or one joined with "+"), made safe; null if it is not one. */
export function cleanStone(raw: unknown): Lodestone | null {
  const list = typeof raw === "string" ? (raw === "" ? [] : raw.split("+")) : Array.isArray(raw) ? raw : null;
  if (!list || list.length > STONE_MODS) return null;
  if (!list.every((id): id is ZoneModId => typeof id === "string" && id in ZONE_MODS) || new Set(list).size !== list.length) return null;
  // One kind of ground at most: a second would only be painted over the first.
  if (list.filter((id) => ZONE_MODS[id].hazard).length > 1) return null;
  return ZONE_MOD_IDS.filter((id) => list.includes(id));
}

/** A stone as it is sent. */
export const stoneKey = (stone: Lodestone): string => stone.join("+");

/** The kind of item a stone is in a pack, and the stone an item of that kind is (null if the kind is no lodestone's). */
export const STONE_ITEM = "lodestone";
export const stoneItem = (stone: Lodestone): string => (stone.length === 0 ? STONE_ITEM : `${STONE_ITEM}:${stoneKey(stone)}`);
export function stoneOfItem(kind: unknown): Lodestone | null {
  if (kind === STONE_ITEM) return [];
  if (typeof kind !== "string" || !kind.startsWith(`${STONE_ITEM}:`)) return null;
  const stone = cleanStone(kind.slice(STONE_ITEM.length + 1));
  return stone && stone.length > 0 ? stone : null;
}

/** What a stone is called: for how much it carries. */
export const stoneName = (stone: Lodestone): string => `${["Plain", "Dull", "Bright", "Singing"][Math.min(STONE_MODS, stone.length)]} lodestone`;

/** Whether a place needs a lodestone in its slot before anyone can set out for it: all but those beside the Harbor, which is their own country. */
export const needsStone = (node: Pick<AtlasNode, "ring" | "kind">): boolean => node.kind !== "harbor" && node.ring > 1;

/** How likely a hero is to find a stone in the bounty of a place this many rings out. */
export const stoneChance = (tier: number): number => Math.min(0.9, 0.5 + 0.03 * tier);

/** A stone as one is found in a bounty: one modifier near the Harbor, up to three far out. */
export function rollStone(rng: Rng, tier: number): Lodestone {
  const most = tier <= 3 ? 1 : tier <= 7 ? 2 : STONE_MODS;
  // More often one fewer than the most it could carry: the best are rare.
  const want = Math.max(1, most - (rng.chance(0.6) ? 1 : 0));
  const out: ZoneModId[] = [];
  for (let tries = 0; out.length < want && tries < 24; tries++) {
    const id = rng.pick(ZONE_MOD_IDS);
    if (out.includes(id) || (ZONE_MODS[id].hazard && out.some((o) => ZONE_MODS[o].hazard))) continue;
    out.push(id);
  }
  return ZONE_MOD_IDS.filter((id) => out.includes(id));
}

/**
 * What a stone does to a place it is set into: what of it takes (`added`), and everything the place then
 * carries (`mods`). What the place has already does not take twice; a second kind of ground does not take
 * over the first; under the earth, in a sea cave, only what changes the enemy takes; and a place carries so
 * much and no more. A stone none of which takes still opens the place: it is only the poorer spent.
 */
export function stoneOn(node: Pick<AtlasNode, "mods" | "kind">, stone: Lodestone): { mods: ZoneModId[]; added: ZoneModId[] } {
  const added: ZoneModId[] = [];
  for (const id of stone) {
    const def = ZONE_MODS[id];
    if (node.mods.includes(id) || node.mods.length + added.length >= MAX_MODS) continue;
    if (node.kind === "seacave" && def.kind !== "enemy") continue;
    if (def.hazard && [...node.mods, ...added].some((o) => ZONE_MODS[o].hazard)) continue;
    added.push(id);
  }
  return { added, mods: ZONE_MOD_IDS.filter((id) => node.mods.includes(id) || added.includes(id)) };
}
