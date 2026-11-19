// What a delve's chests give (delve.ts lays them out). A chest is opened from
// beside it, by a player's own hero: 2 AP in a fight, free out of one,
// and not while the band that guards it still stands.
//
//   chest       its opener: 10 XP, a little gold, materials, and now and then
//               a piece of gear or a healing potion
//   strongbox   its opener: 20 XP, more gold, a piece of gear and a potion
//   the hoard   every player's hero on the map: 30 XP, a pile of gold and
//               a good piece of gear
//
//   the bounty  on a map the atlas made (options.tier): every player's hero
//               on it, once, when it is cleared: no enemy left standing
//               and nothing left unopened. More the further out the node
//               lies, and more again for each of its modifiers.
//
// Everything paid is an effect the server carries out (ZoneRoom), and a
// `spoils` event the client tells.

import { hexDistance } from "@gantt-quest/core";
import { cacheDrops } from "../drops";
import { rollItem } from "../gear";
import { rollStone, stoneChance } from "../lodestone";
import type { Poi } from "../map";
import type { Ctx } from "./engine";
import { modsOf, type ModSum } from "./mods";
import type { Throwable, Unit, ZoneState } from "./types";

type Loot = "chest" | "vault" | "hoard";
interface Pay {
  xp: number;
  gold: [number, number];
  gear: number;
  quality: number;
  potion: number;
}

/** What each kind pays: XP, a span of gold, the chance of a piece of gear and how good, and the chance of a potion. */
export const CHEST_PAY: Record<Loot, Pay> = {
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

/**
 * What clearing a map the atlas made pays each player's hero on it: more by the ring its node lies in, more
 * again by the share its perils add (the harder the map, the better it pays), and each thing in it more
 * again by the map's boons, which multiply what the perils made of it.
 */
export function bountyPay(tier: number, share: number, boons: Partial<Pick<ModSum, "gold" | "xp" | "gear">> = {}): Pay {
  const more = 1 + share;
  const [gold, xp, gear] = [1 + (boons.gold ?? 0), 1 + (boons.xp ?? 0), boons.gear ?? 0];
  return {
    xp: Math.round((20 + 6 * tier) * more * xp),
    gold: [Math.round((14 + 5 * tier) * more * gold), Math.round((24 + 8 * tier) * more * gold)],
    gear: Math.min(1, 0.35 + 0.05 * tier + share * 0.5 + gear),
    quality: Math.min(0.9, 0.3 + 0.04 * tier + share * 0.3 + gear * 0.5),
    potion: 0.5,
  };
}

/**
 * Pay the bounty, if this is a map the atlas made and it has just been cleared: nobody left to fight and
 * nothing left to open. Once only. Called wherever either of those can become true.
 */
export function payBounty(ctx: Ctx): void {
  const { state } = ctx;
  if (!state.options.tier || state.bounty) return;
  if (state.units.some((u) => u.side === "enemy") || unopened(state) > 0) return;
  state.bounty = true;
  const sum = modsOf(state.options);
  const p = bountyPay(state.options.tier, sum.pay, sum);
  for (const hero of state.units.filter((u) => u.side === "hero" && !u.controller)) pay(ctx, hero, p, state.options.tier, sum.stones);
  ctx.events.push({ t: "bounty" });
}

/**
 * Pay one hero: the XP, gold and finds of this kind of chest, or of a bounty (`bounty` is the ring it is paid
 * as: there may be a lodestone in it, likelier and finer by `lode`, what the map's boons add to that).
 */
function pay(ctx: Ctx, hero: Unit, p: Pay, bounty = 0, lode = 0): void {
  const { rng } = ctx;
  const drops = cacheDrops(rng);
  const gold = rng.int(p.gold[0], p.gold[1]);
  const item = rng.chance(p.gear) ? rollItem(rng, hero.kind, p.quality, hero.level) : null;
  const potions = rng.chance(p.potion) ? 1 : 0;
  const items: Partial<Record<Throwable, number>> | undefined = potions > 0 ? { healing: potions } : undefined;
  // The potion is in the pack at once, on the map as in the bag.
  if (potions > 0) hero.items.healing = (hero.items.healing ?? 0) + potions;
  // Thrown last, so a bounty with no stone in it pays what it always did.
  const stone = bounty > 0 && rng.chance(Math.min(0.97, stoneChance(bounty) + lode)) ? rollStone(rng, bounty + (lode > 0 ? 3 : 0)) : null;
  ctx.effects.push({ type: "grant", heroId: hero.id, xp: p.xp, resources: drops.resources, gold, item, ...(drops.blueprint ? { blueprint: drops.blueprint } : {}), ...(drops.furnishing ? { furnishing: drops.furnishing } : {}), ...(items ? { items } : {}), ...(stone ? { stone } : {}) });
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
    ...(stone ? { stone } : {}),
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
  for (const hero of paid) pay(ctx, hero, CHEST_PAY[loot]);
  // The last thing left to open on a map the atlas made, with nobody left to fight: it is cleared.
  payBounty(ctx);
}

/** Whether anything on the map is still to be opened. */
export const unopened = (state: Pick<ZoneState, "map">): number => state.map.pois.filter((p) => p.kind === "cache" && !p.cleared).length;
