// Lodestones: stones that pull a place off its course.
//
// A lodestone carries one to three modifiers (zone/mods.ts: what changes a
// map's ground or whoever stands on it). A crew that sets one into a place
// on its atlas, before anyone has set out for it, adds what the stone
// carries to what the place already has: the map made there is harder, and
// its bounty the richer for it. The stone is spent.
//
// They are found in the bounty of a place the crew clears (zone/loot.ts),
// more often and with more on them the further out the place lies, and are
// kept in the crew's own case with the atlas, not in anyone's pack: the
// atlas is the crew's, and so is what is done to it.
//
// A stone is nothing but the list of what it carries, in the modifiers' own
// order, so two that carry the same are the same stone. In the database, and
// on the wire, it is that list joined with "+".

import type { AtlasNode } from "./atlas";
import type { Rng } from "./rng";
import { MAX_MODS, ZONE_MODS, ZONE_MOD_IDS, type ZoneModId } from "./zone/mods";

export type Lodestone = ZoneModId[];

/** The most a stone carries. */
export const STONE_MODS = 3;

/** A stone as it came off the wire or out of the database (a list, or one joined with "+"), made safe; null if it is not one. */
export function cleanStone(raw: unknown): Lodestone | null {
  const list = typeof raw === "string" ? raw.split("+") : Array.isArray(raw) ? raw : null;
  if (!list || list.length < 1 || list.length > STONE_MODS) return null;
  if (!list.every((id): id is ZoneModId => typeof id === "string" && id in ZONE_MODS) || new Set(list).size !== list.length) return null;
  // One kind of ground at most: a second would only be painted over the first.
  if (list.filter((id) => ZONE_MODS[id].hazard).length > 1) return null;
  return ZONE_MOD_IDS.filter((id) => list.includes(id));
}

/** A stone as it is kept and sent. */
export const stoneKey = (stone: Lodestone): string => stone.join("+");

/** What a stone is called: for how much it carries. */
export const stoneName = (stone: Lodestone): string => `${["Dull", "Bright", "Singing"][Math.min(STONE_MODS, Math.max(1, stone.length)) - 1]} lodestone`;

/** How likely a hero is to find a stone in the bounty of a place this many rings out. */
export const stoneChance = (tier: number): number => Math.min(0.65, 0.2 + 0.04 * tier);

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
 * What a stone would do to a place: what of it takes (`added`), and everything the place then carries
 * (`mods`). What the place has already does not take twice; a second kind of ground does not take over the
 * first; under the earth, in a sea cave, only what changes the enemy takes; and a place carries so much and no more.
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

/** Why a stone cannot be set into a place, or null if it can. */
export function stoneProblem(node: Pick<AtlasNode, "mods" | "kind">, stone: Lodestone): string | null {
  if (node.kind === "harbor") return "There is nothing to set it into at the Harbor.";
  if (stoneOn(node, stone).added.length > 0) return null;
  if (node.kind === "seacave" && stone.every((id) => ZONE_MODS[id].kind !== "enemy")) return "A sea cave's ground is its own: only what a stone does to the enemy would take there.";
  return node.mods.length >= MAX_MODS ? "The place carries all it can already." : "It would change nothing: the place already has what that stone carries.";
}
