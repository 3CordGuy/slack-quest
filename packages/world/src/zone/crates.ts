// Crates: old boxes stacked about a delve's chambers and tunnels, to be
// broken open for what is inside. A crate is a thing on the map (a poi), not
// a fighter: it takes no turns, is on nobody's side and rolls no saves, so
// nothing in a fight's turn order or the enemy's reasoning has to know of it.
//
// - It stands in the way, as a chest does: nobody walks, lands or is shoved
//   onto it (geometry.ts blockerAt). Once broken it is only splinters, and
//   can be walked over.
// - A hero breaks it by hitting it. An ability that does damage, aimed at
//   it, always lands (a crate cannot dodge), though never as a critical hit;
//   a blast, a burst, a line or a thrown bomb that reaches it hurts it too,
//   and so does fire under it. The enemy leaves crates alone.
// - At 0 it breaks and pays whoever broke it: a little wood from its planks,
//   sometimes one other material, often a little gold, and now and then a
//   healing potion or a torch. No XP. A stand-in's blow pays the player who
//   plays it; a crate burnt by a fire no player's hero started pays nobody.

import { posKey, type HexPos } from "@gantt-quest/core";
import type { ResourceKind, Resources } from "../hut";
import type { Poi } from "../map";
import type { Ctx } from "./engine";
import type { Throwable, Unit, ZoneState } from "./types";

/** What a crate can take before it breaks: a good blow and a bit, or two ordinary ones. */
export const CRATE_HP = 10;

/** What a broken crate pays its breaker. */
export const CRATE_PAY = {
  /** Wood from its planks: always some. */
  wood: [1, 2] as [number, number],
  /** The chance of one piece of something else that was stored in it, and what that may be. */
  extra: 0.5,
  finds: ["stone", "copper", "bone", "mushrooms"] as ResourceKind[],
  /** The chance of a few coins, and how many. */
  goldChance: 0.6,
  gold: [2, 8] as [number, number],
  /** The chance of a healing potion, and of a torch. */
  potion: 0.12,
  torch: 0.15,
};

/** A crate that is still whole. */
const whole = (p: Poi): boolean => p.kind === "crate" && !p.cleared;

/** The whole crate on this hex, if there is one. */
export const crateAt = (state: Pick<ZoneState, "map">, pos: HexPos): Poi | undefined => state.map.pois.find((p) => whole(p) && p.pos.q === pos.q && p.pos.r === pos.r);

/** The whole crate with this id, if there is one. */
export const crateById = (state: Pick<ZoneState, "map">, id: string | undefined): Poi | undefined => (id ? state.map.pois.find((p) => p.id === id && whole(p)) : undefined);

/** Whether this id names a crate, whole or broken. */
export const isCrateId = (state: Pick<ZoneState, "map">, id: string | undefined): boolean => !!id && state.map.pois.some((p) => p.id === id && p.kind === "crate");

/** The whole crates on any of these hexes. */
export function cratesOn(state: Pick<ZoneState, "map">, hexes: readonly HexPos[]): Poi[] {
  const keys = new Set(hexes.map(posKey));
  return state.map.pois.filter((p) => whole(p) && keys.has(posKey(p.pos)));
}

/** A crate's health now: a crate laid out before it had any is whole. */
export const crateHp = (crate: Poi): number => (crate.cleared ? 0 : (crate.hp ?? crate.maxHp ?? CRATE_HP));

/** Damage a crate. A blow that reaches it always does at least 1; at 0 it breaks open and pays. */
export function hurtCrate(ctx: Ctx, crate: Poi, amount: number, opts: { actor: string | null; what: string }): void {
  if (crate.cleared) return;
  const hp = crateHp(crate);
  const dealt = Math.min(hp, Math.max(1, Math.round(amount)));
  crate.hp = hp - dealt;
  crate.maxHp ??= CRATE_HP;
  ctx.events.push({ t: "crate_hit", poi: crate.id, actor: opts.actor, amount: dealt, what: opts.what });
  if (crate.hp > 0) return;
  crate.cleared = true;
  ctx.events.push({ t: "crate_broken", poi: crate.id, id: opts.actor });
  const hero = payee(ctx.state, opts.actor);
  if (hero) pay(ctx, hero);
}

/** Who takes what a crate held: the player's own hero who broke it, or the player who plays the stand-in that did. */
function payee(state: ZoneState, actor: string | null): Unit | undefined {
  const unit = actor ? state.units.find((u) => u.id === actor) : undefined;
  if (!unit || unit.side !== "hero") return undefined;
  if (!unit.controller) return unit;
  return state.units.find((u) => u.id === unit.controller && u.side === "hero" && !u.controller);
}

function pay(ctx: Ctx, hero: Unit): void {
  const { rng } = ctx;
  const p = CRATE_PAY;
  const resources: Resources = { wood: rng.int(p.wood[0], p.wood[1]) };
  if (rng.chance(p.extra)) {
    const kind = rng.pick(p.finds);
    resources[kind] = (resources[kind] ?? 0) + 1;
  }
  const gold = rng.chance(p.goldChance) ? rng.int(p.gold[0], p.gold[1]) : 0;
  const items: Partial<Record<Throwable, number>> = {};
  if (rng.chance(p.potion)) items.healing = 1;
  if (rng.chance(p.torch)) items.torch = 1;
  // What can be drunk or thrown is in the pack at once, on the map as in the bag.
  for (const [kind, n] of Object.entries(items) as [Throwable, number][]) hero.items[kind] = (hero.items[kind] ?? 0) + n;
  const found = Object.keys(items).length > 0;
  ctx.effects.push({ type: "grant", heroId: hero.id, xp: 0, resources, ...(gold > 0 ? { gold } : {}), ...(found ? { items } : {}) });
  ctx.events.push({
    t: "spoils",
    id: hero.id,
    xp: 0,
    resources,
    ...(gold > 0 ? { gold } : {}),
    ...(items.healing ? { potions: items.healing } : {}),
    ...(items.torch ? { torches: items.torch } : {}),
  });
}
