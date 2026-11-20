// Looting. Nothing on a map is put in anyone's pack for them: it lies where
// it fell until a hero walks up and takes it, so a party decides for itself
// when it is done with a place and leaves.
//
//   bodies      every enemy that falls (and is not lost to a pit) lies where
//               it fell, to be searched: what it holds follows from what it
//               was (spoils.ts).
//   chests      a chest, a strongbox or the hoard is opened from beside it,
//               by a player's own hero: an Action in a fight, free out of
//               one, and not while the band that guards it still stands.
//               Opening it pays a little XP (the hoard, to everyone); what
//               is inside is then there to take.
//   the spoils  on a map the atlas made (options.tier): once it is cleared
//               (no enemy left standing; in a sea cave, nothing left unopened) every
//               player's hero on it is paid its XP, and the place's spoils
//               are heaped beside whoever finished it. More the further out
//               the node lies, more again for each of its perils, and its
//               lodestones with them (lodestone.ts).
//
// Whose it is depends on which it is:
//
//   a body, a chest   everyone's, first come first served. One lot of
//                     things, rolled once, the first time anyone looks
//                     (and a piece of gear in it for one of the party as
//                     the dice have it, not for whoever looked). Everyone
//                     who looks sees the same things, and what one hero
//                     takes is gone for all of them.
//   the spoils        each hero's own share, rolled for them the first
//                     time they look, and nobody else's to take.
//
// Looking (`look`) is free and can be done from beside it at any time out
// of a fight; so is taking (`take`), a thing at a time or all at once. A
// thing is named by its `uid`, never by where it lay in the list, so two
// heroes reaching into the same body at once each get what they reached
// for or are told it has gone. Everything taken is an effect the server
// carries out (ZoneRoom), and a `took` event the client tells.

import { hexDistance } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import type { Resources } from "../hut";
import type { Poi } from "../map";
import { tileAt } from "../map";
import type { Ctx } from "./engine";
import { freeHexNear } from "./gen";
import { blockerAt, inFight, unitAt } from "./geometry";
import { modsOf } from "./mods";
import { bountyPay, rollBody, rollChest, rollSpoils, type Pay } from "./spoils";
import type { LootItem, LootSpot, Throwable, Unit, ZoneEffect, ZoneState } from "./types";

export { bountyPay } from "./spoils";

type Loot = "chest" | "vault" | "hoard";

/** What each kind pays: XP, a span of gold, the chance of a piece of gear and how good, and the chance of a potion. */
export const CHEST_PAY: Record<Loot, Pay> = {
  chest: { xp: 10, gold: [6, 16], gear: 0.25, quality: 0.3, potion: 0.3 },
  vault: { xp: 20, gold: [20, 35], gear: 1, quality: 0.5, potion: 1 },
  hoard: { xp: 30, gold: [30, 50], gear: 1, quality: 0.7, potion: 0 },
};

const lootOf = (chest: Poi): Loot => (chest.loot === "hoard" || chest.loot === "vault" ? chest.loot : "chest");
const CHEST_NAME: Record<Loot, string> = { chest: "Chest", vault: "Strongbox", hoard: "The hoard" };

/** The id of the heap a cleared place's spoils lie in. */
export const SPOILS_ID = "spoils";

/** Why `unit` cannot open this, in words, or null if it can. */
export function checkOpen(state: ZoneState, unit: Unit, chest: Poi | undefined): string | null {
  if (!chest) return "There is nothing to open there.";
  if (chest.cleared) return "It stands open already.";
  if (unit.side !== "hero" || unit.controller) return "Only your own hero can open it.";
  if (unit.down) return "Not while you are down.";
  if (hexDistance(unit.pos, chest.pos) > 1) return "Go up to it first.";
  if (chest.guard && state.units.some((u) => u.group === chest.guard && !u.down)) return "Its guards still stand over it.";
  return null;
}

/** XP and nothing else, paid to one hero and told. */
function payXp(ctx: Ctx, hero: Unit, xp: number): void {
  if (xp <= 0) return;
  ctx.effects.push({ type: "grant", heroId: hero.id, xp, resources: {} });
  ctx.events.push({ t: "spoils", id: hero.id, xp, resources: {} });
}

/** Every player's own hero on the map: who a place's rewards are for. */
const players = (state: ZoneState): Unit[] => state.units.filter((u) => u.side === "hero" && !u.controller && !u.summon);

/** Open a chest that has passed its check: it stands open, with what is in it there for the taking. The hoard's XP is everyone's; any other, its opener's. */
export function openChest(ctx: Ctx, unit: Unit, chest: Poi): void {
  const { state } = ctx;
  const loot = lootOf(chest);
  chest.cleared = true;
  ctx.events.push({ t: "opened", id: unit.id, poi: chest.id, loot });
  // A key to a locked door, left in it: on the party's ring.
  if (chest.key) {
    state.keys = (state.keys ?? 0) + 1;
    ctx.events.push({ t: "key", keys: state.keys, from: "chest", id: unit.id });
  }
  for (const hero of loot === "hoard" ? players(state) : [unit]) payXp(ctx, hero, CHEST_PAY[loot].xp);
  (state.loot ??= []).push({ id: chest.id, kind: "chest", name: CHEST_NAME[loot], pos: { q: chest.pos.q, r: chest.pos.r }, chest: loot, loot: {} });
  // The last thing left to open on a map the atlas made, with nobody left to fight: it is cleared.
  payBounty(ctx, unit);
}

/** An enemy that has fallen and been cleared out of the fight lies where it fell, to be searched. One lost to a pit leaves nothing. */
export function leaveBody(state: ZoneState, unit: Unit): void {
  if (unit.lost || unit.summon || !ENEMIES[unit.kind] || unit.kind === "dummy") return;
  (state.loot ??= []).push({ id: unit.id, kind: "body", name: unit.name, pos: { q: unit.pos.q, r: unit.pos.r }, unit: unit.kind, level: unit.level, loot: {} });
}

/**
 * A map the atlas made has just been cleared (nobody left to fight and nothing left to open): every player's hero
 * on it is paid its XP, and its spoils are heaped on open ground beside `by` (whoever finished it), each hero's
 * share their own to take (unlike a body or a chest, which is first come first served). Once only. Called wherever either of those can become true.
 */
export function payBounty(ctx: Ctx, by?: Unit): void {
  const { state } = ctx;
  if (!state.options.tier || state.bounty || !zoneCleared(state)) return;
  state.bounty = true;
  const sum = modsOf(state.options);
  const xp = bountyPay(state.options.tier, sum.pay, sum).xp;
  const heroes = players(state);
  for (const hero of heroes) payXp(ctx, hero, xp);
  const near = (by && by.side === "hero" ? by : heroes[0])?.pos ?? state.start;
  const taken = (p: { q: number; r: number }) => !!unitAt(state, p) || blockerAt(state, p) || !!state.loot?.some((s) => s.pos.q === p.q && s.pos.r === p.r);
  const pos = freeHexNear(state.map, near, taken, (p) => tileAt(state.map, p)) ?? near;
  (state.loot ??= []).push({ id: SPOILS_ID, kind: "spoils", name: `The spoils of ${state.options.name ?? "this place"}`, pos: { q: pos.q, r: pos.r }, loot: {} });
  ctx.events.push({ t: "bounty", spot: SPOILS_ID });
}

/** Why `unit` cannot look into (or take from) this, in words, or null if it can. */
export function checkLoot(state: ZoneState, unit: Unit, spot: LootSpot | undefined): string | null {
  if (!spot) return "There is nothing there to search.";
  if (unit.side !== "hero" || unit.controller || unit.summon) return "Only your own hero can search it.";
  if (unit.down) return "Not while you are down.";
  if (inFight(state, unit.id)) return "Not in the middle of a fight: it will keep.";
  if (hexDistance(unit.pos, spot.pos) > 1) return "Go up to it first.";
  return null;
}

/**
 * Whether what is in a spot is everyone's, first come first served: a body or a chest. The spoils are each hero's
 * own. (So is a body or a chest on a map saved when those were too, if someone had looked into it by then: it has
 * shares in `loot` and nothing in `shared`, and is finished as it was begun. One nobody had looked into is shared.)
 */
export const sharedLoot = (spot: LootSpot): boolean => spot.kind !== "spoils" && (!!spot.shared || Object.keys(spot.loot).length === 0);

/** What `hero` would find in a spot now: what is left in a body or a chest, or of their own share of the spoils. Undefined: it has not been looked into yet. */
export const lootIn = (spot: LootSpot, hero: string): LootItem[] | undefined => (sharedLoot(spot) ? spot.shared : spot.loot[hero]);

/** What is in a spot, as `hero` finds it: rolled now if nobody has looked into a body or a chest before, or they have not looked at their share of the spoils. */
export function look(ctx: Ctx, hero: Unit, spot: LootSpot): LootItem[] {
  const shared = sharedLoot(spot);
  const had = shared ? spot.shared : spot.loot[hero.id];
  if (had) return had;
  const { options } = ctx.state;
  // Whose a piece of gear in it would be: the looker's, in a share of their own. In what is everyone's, one of the
  // players' heroes on the map as the dice have it, so that what is found is nothing to do with who looked first.
  const owner = shared ? (ctx.rng.pick(players(ctx.state)) ?? hero) : hero;
  const who = { classId: owner.kind, level: owner.level };
  const rolled =
    spot.kind === "body" ? rollBody(ctx.rng, spot.unit ?? "", spot.level ?? 1, who, options)
    : spot.kind === "chest" ? rollChest(ctx.rng, CHEST_PAY[spot.chest ?? "chest"], who)
    : rollSpoils(ctx.rng, who, options);
  const found = rolled.map((item, i) => ({ ...item, uid: i + 1 }));
  if (shared) spot.shared = found;
  else spot.loot[hero.id] = found;
  return found;
}

/**
 * Take from a spot: the thing with this `uid` (or, in a share of `hero`'s own, the `index`th), or with neither all
 * that is there. Out of a body or a chest it is gone for everyone, and whoever reaches for it next is told so. Gold,
 * materials and what there is to drink or throw go as one grant; each piece of gear, lodestone, blueprint or
 * furnishing past the first is a grant of its own. All of them to `hero`, and each thing once.
 */
export function take(ctx: Ctx, hero: Unit, spot: LootSpot, which: { index?: number; uid?: number } = {}): string | null {
  const shared = sharedLoot(spot);
  const there = look(ctx, hero, spot);
  const all = which.uid === undefined && which.index === undefined;
  // A place in the list names a thing only where nobody else can have changed the list.
  const one = which.uid !== undefined ? there.find((item) => item.uid === which.uid) : shared || which.index === undefined ? undefined : there[which.index];
  const taken = all ? [...there] : one ? [one] : [];
  if (taken.length === 0) {
    if (!shared) return all ? "There is nothing left in it for you." : "That is not there any more.";
    if (all) return "There is nothing left in it.";
    if (which.uid === undefined) return "That is not there any more.";
    return spot.gone?.[which.uid] === hero.id ? "You have taken that already." : "Someone else took that.";
  }
  const left = there.filter((item) => !taken.includes(item));
  if (shared) {
    spot.shared = left;
    for (const item of taken) if (item.uid !== undefined) (spot.gone ??= {})[item.uid] = hero.id;
  } else spot.loot[hero.id] = left;
  const blank = (): Extract<ZoneEffect, { type: "grant" }> => ({ type: "grant", heroId: hero.id, xp: 0, resources: {} });
  const grants = [blank()];
  /** The first grant with nothing of this sort in it yet, or a fresh one. */
  const slot = (key: "item" | "stone" | "blueprint" | "furnishing") => {
    let g = grants.find((x) => x[key] === undefined || x[key] === null);
    if (!g) grants.push((g = blank()));
    return g;
  };
  const resources: Resources = grants[0].resources;
  for (const item of taken) {
    if (item.t === "gold") grants[0].gold = (grants[0].gold ?? 0) + item.n;
    else if (item.t === "res") resources[item.kind] = (resources[item.kind] ?? 0) + item.n;
    else if (item.t === "use") {
      const items: Partial<Record<Throwable, number>> = (grants[0].items ??= {});
      items[item.kind] = (items[item.kind] ?? 0) + item.n;
      // In the pack at once, on the map as in the bag.
      hero.items[item.kind] = (hero.items[item.kind] ?? 0) + item.n;
    } else if (item.t === "gear") slot("item").item = item.item;
    else if (item.t === "stone") slot("stone").stone = item.stone;
    else if (item.t === "blueprint") slot("blueprint").blueprint = item.id;
    else slot("furnishing").furnishing = item.grant;
  }
  ctx.effects.push(...grants);
  ctx.events.push({ t: "took", id: hero.id, spot: spot.id, items: taken });
  return null;
}

/** Whether anything on the map is still to be opened. */
export const unopened = (state: Pick<ZoneState, "map">): number => state.map.pois.filter((p) => p.kind === "cache" && !p.cleared).length;

/**
 * Whether a map is cleared: no enemy left on it. A delve into the caves is there for its chests as much as its
 * fights, so it is cleared only once the last of those is open too; anywhere else a chest left shut is the
 * party's own loss.
 */
export const zoneCleared = (state: Pick<ZoneState, "map" | "units" | "options">): boolean => !state.units.some((u) => u.side === "enemy") && (!state.options.delve || unopened(state) === 0);

/**
 * What is left to take on the map for `hero`: the bodies and chests that still hold anything, and the spoils while
 * their own share is untaken (what has not been looked into counts).
 */
export const unlooted = (state: Pick<ZoneState, "loot">, hero: string): number => (state.loot ?? []).filter((s) => (lootIn(s, hero)?.length ?? 1) > 0).length;

/** What a client is sent of the loot: every spot, with what is everyone's in it as it stands, and of the shares in it only `you`'s own. */
export function lootFor(state: Pick<ZoneState, "loot">, you: string): LootSpot[] | undefined {
  return state.loot?.map((s) => ({ ...s, loot: s.loot[you] ? { [you]: s.loot[you] } : {} }));
}
