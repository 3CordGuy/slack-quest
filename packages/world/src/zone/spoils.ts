// What there is to take on a map: what a fallen enemy had on it, what a
// chest holds, and the spoils of a place cleared. Each is a list of things
// (LootItem), rolled for one hero the first time they look (loot.ts), and
// theirs alone to take.
//
// What a body holds follows from what it was:
//
//   beasts      hide and bone
//   bugs        what an apothecary wants: mushrooms, slime, herbs, and now
//               and then venom worth bottling
//   wildfolk    herbs and mushrooms, and the potions they brewed of them
//   raiders     coin, the iron and copper of their kit, a torch, a flask,
//               and once in a while a piece of gear worth keeping
//   cultists    coin, herbs and bones for their rites, fire to throw
//   the dead    bones, old coin, rusted iron, a gem off a finger
//   oozes       slime, and acid
//   giants      a great deal of bone and hide, the stone they throw, coin
//   constructs  stone and metal, and the gem that drove them
//
// A boss carries more of everything its kind does, a piece of gear more
// often than not, and on the atlas's maps sometimes a lodestone.

import type { ResourceKind } from "../hut";
import { ENEMIES } from "../content";
import { cacheDrops } from "../drops";
import { rollItem } from "../gear";
import { rollStone, spoilStones } from "../lodestone";
import type { Rng } from "../rng";
import { modsOf, type ModSum } from "./mods";
import type { LootItem, Throwable, ZoneOptions } from "./types";

export type Family = "beast" | "bug" | "wild" | "raider" | "cult" | "dead" | "ooze" | "giant" | "construct";

/** What each kind of enemy is, for what it carries. One not listed carries nothing (a training dummy). */
export const ENEMY_FAMILY: Record<string, Family> = {
  wolf: "beast", alpha: "beast", bear: "beast", great_bear: "beast", bat: "beast", frost_wolf: "beast", ember_hound: "beast", snow_bear: "beast",
  spider: "bug", broodmother: "bug",
  witch: "wild",
  bandit: "raider", archer: "raider", brute: "raider", villain: "raider",
  cultist: "cult",
  shade: "dead", skeleton: "dead", haunt: "dead", wraith: "dead",
  slime: "ooze",
  ogre: "giant", troll: "giant",
  guardian: "construct",
};

/** One line of a table: a material or something to drink or throw, how often it is there, and how many. */
interface Line {
  res?: ResourceKind;
  use?: Throwable;
  chance: number;
  n?: [number, number];
}

interface Table {
  /** The chance of coin, and how much before the enemy's level is added. */
  gold?: { chance: number; n: [number, number] };
  lines: Line[];
  /** The chance of a piece of gear. */
  gear?: number;
}

export const FAMILY_LOOT: Record<Family, Table> = {
  beast: { lines: [{ res: "fur", chance: 0.8, n: [1, 2] }, { res: "bone", chance: 0.6, n: [1, 2] }] },
  bug: { lines: [{ res: "mushrooms", chance: 0.6, n: [1, 2] }, { res: "slime", chance: 0.5, n: [1, 2] }, { res: "herbs", chance: 0.3 }, { use: "poison", chance: 0.12 }, { use: "acid", chance: 0.08 }] },
  wild: { gold: { chance: 0.3, n: [1, 4] }, lines: [{ res: "herbs", chance: 0.85, n: [1, 3] }, { res: "mushrooms", chance: 0.6, n: [1, 2] }, { res: "wood", chance: 0.3 }, { use: "healing", chance: 0.22 }, { use: "poison", chance: 0.15 }, { res: "gem", chance: 0.04 }] },
  raider: { gold: { chance: 0.9, n: [2, 6] }, lines: [{ res: "iron", chance: 0.4, n: [1, 2] }, { res: "copper", chance: 0.4, n: [1, 2] }, { use: "torch", chance: 0.15 }, { use: "healing", chance: 0.1 }, { use: "oil", chance: 0.08 }], gear: 0.05 },
  cult: { gold: { chance: 0.7, n: [2, 5] }, lines: [{ res: "herbs", chance: 0.4, n: [1, 2] }, { res: "bone", chance: 0.3 }, { use: "fire", chance: 0.15 }, { use: "healing", chance: 0.1 }, { res: "gem", chance: 0.05 }], gear: 0.04 },
  dead: { gold: { chance: 0.4, n: [1, 5] }, lines: [{ res: "bone", chance: 0.8, n: [1, 3] }, { res: "iron", chance: 0.25 }, { res: "gem", chance: 0.05 }] },
  ooze: { lines: [{ res: "slime", chance: 0.95, n: [2, 3] }, { use: "acid", chance: 0.2 }, { use: "slime", chance: 0.15 }] },
  giant: { gold: { chance: 0.5, n: [4, 10] }, lines: [{ res: "bone", chance: 0.7, n: [2, 3] }, { res: "fur", chance: 0.5, n: [1, 2] }, { res: "stone", chance: 0.5, n: [1, 3] }, { res: "iron", chance: 0.3 }], gear: 0.06 },
  construct: { lines: [{ res: "stone", chance: 0.9, n: [2, 4] }, { res: "iron", chance: 0.5, n: [1, 2] }, { res: "copper", chance: 0.4 }, { res: "gem", chance: 0.2 }] },
};

/** What a boss has over the rank and file of its kind: everything likelier, more of it, coin for certain, gear more often than not, and (on the atlas) the chance of a lodestone. */
export const BOSS_LOOT = { chance: 1.5, amount: 2, gold: [10, 20] as [number, number], gear: 0.6, quality: 0.55, stone: 0.3 };

/** Things of a kind put together, so a list reads "3 bone" once and not three times. */
function tidy(items: LootItem[]): LootItem[] {
  const out: LootItem[] = [];
  for (const item of items) {
    const same = out.find((o) => (o.t === "gold" && item.t === "gold") || (o.t === "res" && item.t === "res" && o.kind === item.kind) || (o.t === "use" && item.t === "use" && o.kind === item.kind));
    if (same && "n" in same && "n" in item) same.n += item.n;
    else out.push(item);
  }
  return out;
}

/** What one hero finds on the body of an enemy of this kind and level. `classId` and `heroLevel`: whose gear it would be. */
export function rollBody(rng: Rng, kind: string, level: number, hero: { classId: string; level: number }, options: Pick<ZoneOptions, "tier" | "mods">): LootItem[] {
  const family = ENEMY_FAMILY[kind];
  if (!family) return [];
  const table = FAMILY_LOOT[family];
  const boss = !!ENEMIES[kind]?.boss;
  const often = (chance: number) => Math.min(1, chance * (boss ? BOSS_LOOT.chance : 1));
  const items: LootItem[] = [];
  if (boss) items.push({ t: "gold", n: rng.int(BOSS_LOOT.gold[0], BOSS_LOOT.gold[1]) + level * 2 });
  else if (table.gold && rng.chance(table.gold.chance)) items.push({ t: "gold", n: rng.int(table.gold.n[0], table.gold.n[1]) + Math.floor(level / 2) });
  for (const line of table.lines) {
    if (!rng.chance(often(line.chance))) continue;
    const n = rng.int(line.n?.[0] ?? 1, line.n?.[1] ?? 1) * (boss && line.res ? BOSS_LOOT.amount : 1);
    if (line.res) items.push({ t: "res", kind: line.res, n });
    else if (line.use) items.push({ t: "use", kind: line.use, n });
  }
  const gear = boss ? BOSS_LOOT.gear : (table.gear ?? 0);
  if (gear > 0 && rng.chance(gear)) items.push({ t: "gear", item: rollItem(rng, hero.classId, boss ? BOSS_LOOT.quality : 0.3, hero.level) });
  // A boss on one of the atlas's maps may have a lodestone on it: one of the lesser sort for its ring.
  if (boss && options.tier && rng.chance(BOSS_LOOT.stone + modsOf(options).stones)) items.push({ t: "stone", stone: rollStone(rng, options.tier) });
  return tidy(items);
}

/** What a chest, a strongbox or the hoard pays: a span of gold, the chance of a piece of gear and how good, and the chance of a potion. */
export interface Pay {
  xp: number;
  gold: [number, number];
  gear: number;
  quality: number;
  potion: number;
}

/** What one hero finds in a chest that pays `pay`: its gold, a few materials, and now and then gear, a potion, a blueprint or a furnishing. */
export function rollChest(rng: Rng, pay: Pay, hero: { classId: string; level: number }): LootItem[] {
  const drops = cacheDrops(rng);
  const items: LootItem[] = [{ t: "gold", n: rng.int(pay.gold[0], pay.gold[1]) }];
  for (const [kind, n] of Object.entries(drops.resources) as [ResourceKind, number][]) if (n > 0) items.push({ t: "res", kind, n });
  if (rng.chance(pay.gear)) items.push({ t: "gear", item: rollItem(rng, hero.classId, pay.quality, hero.level) });
  if (rng.chance(pay.potion)) items.push({ t: "use", kind: "healing", n: 1 });
  if (drops.blueprint) items.push({ t: "blueprint", id: drops.blueprint });
  if (drops.furnishing) items.push({ t: "furnishing", grant: drops.furnishing });
  return tidy(items);
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
 * One hero's share of the spoils of a place on the atlas, cleared: what a good chest would hold at that ring, and
 * its lodestones (lodestone.ts `spoilStones`): always one, as good as the stone that opened the place or a little
 * better, and more of them the more that stone carried.
 */
export function rollSpoils(rng: Rng, hero: { classId: string; level: number }, options: Pick<ZoneOptions, "tier" | "mods" | "stone">): LootItem[] {
  const tier = options.tier ?? 1;
  const sum = modsOf(options);
  const items = rollChest(rng, bountyPay(tier, sum.pay, sum), hero);
  for (const stone of spoilStones(rng, tier, options.stone, sum.stones)) items.push({ t: "stone", stone });
  return items;
}
