// Lodestones: stones that draw a crew to a place, and pull the place off its
// course.
//
// A lodestone is an item, a hero's own, carried in the pack. To set out for
// a place on the atlas beyond the Harbor's own country, someone must put one
// into the place's slot: it is spent as the map is made. A plain lodestone
// does no more than that. One that carries modifiers (zone/mods.ts; up to
// three) adds what it carries to what the place already has. A peril makes
// the map made there harder, and its bounty the bigger for it; a boon makes
// nothing harder, and is more of one thing in the bounty. A stone is found
// carrying whatever it carries, wanted or not: not every stone is a good one.
//
// They are found in the spoils of a place cleared (zone/loot.ts), each hero
// their own, and a place always gives at least one back: a stone as good
// as the one that opened it, or now and then a little better (`spoilStones`).
// The more the stone that opened a place carried, the more stones its
// spoils hold, most of them a little poorer than it, some its equal, a few
// finer. So a crew that keeps clearing places never runs out of stones, and
// the best of them are worked up at the Lapidary in town (stonecraft.ts).
// Should anyone ever be left with none all the same, a plain one can always
// be cut from stone and iron (`PLAIN_STONE_COST`).
//
// A stone is nothing but the list of what it carries, in the modifiers' own
// order, so two that carry the same are the same stone and stack. On the
// wire it is that list joined with "+" (a plain one is the empty string);
// in a pack it is an item of kind "lodestone", or "lodestone:" and the list.

import type { AtlasNode } from "./atlas";
import type { Resources } from "./hut";
import type { Rng } from "./rng";
import { MAX_BOONS, MAX_MODS, ZONE_MODS, ZONE_MOD_IDS, modOf, modToken, rollMod, type ZoneMod, type ZoneModId } from "./zone/mods";

/** What a lodestone carries: nothing (a plain one), or up to `STONE_MODS` modifiers, each at its rank. */
export type Lodestone = ZoneMod[];

/** The most a stone carries. */
export const STONE_MODS = 3;
/** What a plain lodestone is cut from. */
export const PLAIN_STONE_COST: Resources = { stone: 4, iron: 2 };

/** A stone as it came off the wire or out of the database (a list, or one joined with "+"), made safe; null if it is not one. */
export function cleanStone(raw: unknown): Lodestone | null {
  const list = typeof raw === "string" ? (raw === "" ? [] : raw.split("+")) : Array.isArray(raw) ? raw : null;
  if (!list || list.length > STONE_MODS) return null;
  const mods = list.map(modOf);
  if (mods.some((m) => !m) || new Set(mods.map((m) => m!.id)).size !== mods.length) return null;
  // One kind of ground at most: a second would only be painted over the first.
  if (mods.filter((m) => ZONE_MODS[m!.id].hazard).length > 1) return null;
  return ZONE_MOD_IDS.flatMap((id) => mods.filter((m) => m!.id === id).map((m) => modToken(id, m!.rank)));
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

/**
 * A stone as one is found: carrying `size` things (left out: one near the Harbor, up to three far out), each picked
 * by its weight from perils and boons alike (so the best are the rarest), at a rank that ring can show.
 */
export function rollStone(rng: Rng, tier: number, size?: number): Lodestone {
  const most = tier <= 3 ? 1 : tier <= 7 ? 2 : STONE_MODS;
  // More often one fewer than the most it could carry: the best are rare.
  const want = size !== undefined ? Math.max(0, Math.min(STONE_MODS, Math.round(size))) : Math.max(1, most - (rng.chance(0.6) ? 1 : 0));
  if (want === 0) return [];
  const ids: ZoneModId[] = [];
  const out: ZoneMod[] = [];
  for (let tries = 0; out.length < want && tries < 24; tries++) {
    const mod = rollMod(rng, ZONE_MOD_IDS, tier, (id) => !ids.includes(id) && !(ZONE_MODS[id].hazard && ids.some((o) => ZONE_MODS[o].hazard)));
    if (!mod) break;
    ids.push(modOf(mod)!.id);
    out.push(mod);
  }
  return cleanStone(out)!;
}

/**
 * How the stones in a place's spoils are reckoned, from how much the stone that opened it carried (0 to 3).
 *
 *   the one    always there: as much as that stone carried, or (`better`) one thing more.
 *   the rest   `rolls` more chances at a stone, one for the place itself and one for each thing its stone carried,
 *              each coming up `chance` of the time (and `perThing` more for each thing the stone carried). Of those
 *              that do, most carry one thing fewer than the stone did (`lesser`), some as much, the rest one more.
 *
 * So a plain stone's place gives back one stone and now and then a second; a stone that carried three gives three
 * or more as often as not, and a fine one among them now and then.
 */
export const SPOIL_STONES = { better: 0.25, chance: 0.3, perThing: 0.08, lesser: 0.55, equal: 0.33 };

/**
 * The lodestones in one hero's share of a place's spoils. `carried`: how much the stone that opened the place
 * carried (a place beside the Harbor needs none: it is reckoned as a plain one). `lode`: what the place's boons
 * add to each further stone's chance (zone/mods.ts `stones`). Never fewer than one.
 */
export function spoilStones(rng: Rng, tier: number, carried: number | undefined, lode = 0): Lodestone[] {
  const q = Math.max(0, Math.min(STONE_MODS, Math.round(carried ?? 0)));
  const s = SPOIL_STONES;
  const out: Lodestone[] = [rollStone(rng, tier, Math.min(STONE_MODS, q + (rng.chance(s.better) ? 1 : 0)))];
  for (let i = 0; i < 1 + q; i++) {
    if (!rng.chance(Math.min(0.95, s.chance + s.perThing * q + lode))) continue;
    const which = rng.next();
    out.push(rollStone(rng, tier, which < s.lesser ? q - 1 : which < s.lesser + s.equal ? q : q + 1));
  }
  return out;
}

/**
 * What a stone does to a place it is set into: what of it takes (`added`), and everything the place then
 * carries (`mods`). What the place has already does not take twice, unless the stone's is of a higher rank,
 * which takes its place; a second kind of ground does not take over the first; under the earth, in a sea
 * cave, nothing that changes the ground takes; and a place carries so many perils and so many boons, and no
 * more. A stone none of which takes still opens the place: it is only the poorer spent.
 */
export function stoneOn(node: Pick<AtlasNode, "mods" | "kind">, stone: Lodestone): { mods: ZoneMod[]; added: ZoneMod[] } {
  const rank = new Map<ZoneModId, number>(node.mods.map((m) => [modOf(m)!.id, modOf(m)!.rank]));
  const side = (boon: boolean) => [...rank.keys()].filter((id) => (ZONE_MODS[id].kind === "boon") === boon).length;
  const added: ZoneMod[] = [];
  for (const mod of stone) {
    const { id, rank: at } = modOf(mod)!;
    const def = ZONE_MODS[id];
    if (node.kind === "seacave" && def.kind === "map") continue;
    const had = rank.get(id);
    if (had !== undefined) {
      if (at <= had) continue;
    } else {
      if (def.hazard && [...rank.keys()].some((o) => ZONE_MODS[o].hazard)) continue;
      if (side(def.kind === "boon") >= (def.kind === "boon" ? MAX_BOONS : MAX_MODS)) continue;
    }
    rank.set(id, at);
    added.push(mod);
  }
  return { added, mods: ZONE_MOD_IDS.filter((id) => rank.has(id)).map((id) => modToken(id, rank.get(id)!)) };
}
