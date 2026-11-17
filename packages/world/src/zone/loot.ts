// What a delve's chests give (delve.ts lays them out). A chest is opened from
// beside it, by a player's own hero: an Action in a fight, free out of one,
// and not while the band that guards it still stands.
//
//   chest       its opener: 10 XP, a little gold, materials, and now and then
//               a piece of gear or a healing potion
//   strongbox   its opener: 20 XP, more gold, a piece of gear and a potion
//   the hoard   every player's hero on the map: 30 XP, a pile of gold and
//               a good piece of gear
//
// Everything paid is an effect the server carries out (ZoneRoom), and a
// `spoils` event the client tells.

import { hexDistance } from "@gantt-quest/core";
import { cacheDrops } from "../drops";
import { rollItem } from "../gear";
import type { Poi } from "../map";
import type { Ctx } from "./engine";
import type { Throwable, Unit, ZoneState } from "./types";

type Loot = "chest" | "vault" | "hoard";

/** What each kind pays: XP, a span of gold, the chance of a piece of gear and how good, and the chance of a potion. */
export const CHEST_PAY: Record<Loot, { xp: number; gold: [number, number]; gear: number; quality: number; potion: number }> = {
  chest: { xp: 10, gold: [6, 16], gear: 0.25, quality: 0.3, potion: 0.3 },
  vault: { xp: 20, gold: [20, 35], gear: 1, quality: 0.5, potion: 1 },
  hoard: { xp: 30, gold: [30, 50], gear: 1, quality: 0.7, potion: 0 },
};

const lootOf = (chest: Poi): Loot => (chest.loot === "hoard" || chest.loot === "vault" ? chest.loot : "chest");

/** Why `unit` cannot open this, in words, or null if it can. */
export function checkOpen(state: ZoneState, unit: Unit, chest: Poi | undefined): string | null {
  if (!chest) return "There is nothing to open there.";
  if (chest.cleared) return "It has been emptied already.";
  if (unit.side !== "hero" || unit.controller) return "Only your own hero can open it.";
  if (unit.down) return "Not while you are down.";
  if (hexDistance(unit.pos, chest.pos) > 1) return "Go up to it first.";
  if (chest.guard && state.units.some((u) => u.group === chest.guard && !u.down)) return "Its guards still stand over it.";
  return null;
}

/** Pay one hero: the XP, gold and finds of this kind of chest. */
function pay(ctx: Ctx, hero: Unit, loot: Loot): void {
  const { rng } = ctx;
  const p = CHEST_PAY[loot];
  const drops = cacheDrops(rng);
  const gold = rng.int(p.gold[0], p.gold[1]);
  const item = rng.chance(p.gear) ? rollItem(rng, hero.kind, p.quality, hero.level) : null;
  const potions = rng.chance(p.potion) ? 1 : 0;
  const items: Partial<Record<Throwable, number>> | undefined = potions > 0 ? { healing: potions } : undefined;
  // The potion is in the pack at once, on the map as in the bag.
  if (potions > 0) hero.items.healing = (hero.items.healing ?? 0) + potions;
  ctx.effects.push({ type: "grant", heroId: hero.id, xp: p.xp, resources: drops.resources, gold, item, ...(drops.blueprint ? { blueprint: drops.blueprint } : {}), ...(drops.furnishing ? { furnishing: drops.furnishing } : {}), ...(items ? { items } : {}) });
  ctx.events.push({
    t: "spoils",
    id: hero.id,
    xp: p.xp,
    resources: drops.resources,
    gold,
    ...(item ? { item: item.name } : {}),
    ...(drops.blueprint ? { blueprint: drops.blueprint } : {}),
    ...(drops.furnishing ? { furnishing: drops.furnishing.label } : {}),
    ...(potions > 0 ? { potions } : {}),
  });
}

/** Open a chest that has passed its check. The hoard pays every player's hero on the map; anything else, its opener. */
export function openChest(ctx: Ctx, unit: Unit, chest: Poi): void {
  const loot = lootOf(chest);
  chest.cleared = true;
  ctx.events.push({ t: "opened", id: unit.id, poi: chest.id, loot });
  // A key to a locked door, left in it: on the party's ring.
  if (chest.key) {
    ctx.state.keys = (ctx.state.keys ?? 0) + 1;
    ctx.events.push({ t: "key", keys: ctx.state.keys, from: "chest", id: unit.id });
  }
  const paid = loot === "hoard" ? ctx.state.units.filter((u) => u.side === "hero" && !u.controller) : [unit];
  for (const hero of paid) pay(ctx, hero, loot);
}

/** Whether anything on the map is still to be opened. */
export const unopened = (state: Pick<ZoneState, "map">): number => state.map.pois.filter((p) => p.kind === "cache" && !p.cleared).length;
