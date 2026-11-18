// The small moves every rule is built from: a condition put on or taken
// off, damage dealt, someone healed, an attack or a save rolled. Each one
// changes the state in the context and adds what happened to its events.

import { hexDistance, posKey, type StatKey } from "@gantt-quest/core";
import { tileAt } from "../map";
import type { Rng } from "../rng";
import { adjacent, elevOf, inFight } from "./geometry";
import { AQUEOUS, AURAS, CORAL_ARMOR, ENEMY_KIT, SHIELD_SET_ASIDE, enemyDefence, enemySave } from "./kit";
import { inDark } from "./light";
import { d20, heroDefence, mod, netAdvantage, rollDice, statOf } from "./rules";
import { songDefence, songHit, windward } from "./song";
import type { Condition, Roll, Unit, ZoneEffect, ZoneEvent, ZoneState } from "./types";

export interface Ctx {
  state: ZoneState;
  rng: Rng;
  events: ZoneEvent[];
  effects: ZoneEffect[];
  /**
   * Called after each step a unit takes, by the reducer: has it walked into a fight? Returns true to
   * stop it there. `flush` writes out the steps taken so far, so what follows is told in order.
   */
  onStep?: (unit: Unit, flush: () => void) => boolean;
}

export const has = (unit: Unit, kind: Condition): boolean => unit.conditions.some((c) => c.kind === kind);

export function removeCondition(unit: Unit, kind: Condition): void {
  unit.conditions = unit.conditions.filter((c) => c.kind !== kind);
}

/**
 * Put a condition on a unit, or lengthen the one it has. Something soaked cannot be set burning.
 * `amount`: a shield's points (Bolstered); a bigger one replaces a smaller.
 */
export function addCondition(ctx: Ctx, unit: Unit, kind: Condition, rounds: number, amount?: number): void {
  if (unit.down || rounds <= 0) return;
  if (kind === "burning" && has(unit, "wet")) return;
  // A Wind-god's Shanty keeps everyone in it light on their feet.
  if (kind === "slowed" && windward(ctx.state, unit)) return;
  if (kind === "wet") removeCondition(unit, "burning");
  const enc = ctx.state.encounter;
  const mine = !!enc && enc.acting.includes(unit.id) && !enc.done.includes(unit.id);
  const held = unit.conditions.find((c) => c.kind === kind);
  if (held) held.rounds = Math.max(held.rounds, rounds);
  else {
    unit.conditions.push(mine ? { kind, rounds, fresh: true } : { kind, rounds });
    // On its own turn, what changes how far it can go is felt at once.
    const budget = mine ? enc!.budgets[unit.id] : undefined;
    if (budget && kind === "hasted") budget.move += budget.moveMax;
    if (budget && kind === "slowed") budget.move = Math.floor(budget.move / 2);
    if (budget && kind === "prone") budget.move = 0;
  }
  const now = unit.conditions.find((c) => c.kind === kind)!;
  if (amount !== undefined) now.amount = Math.max(now.amount ?? 0, amount);
  ctx.events.push({ t: "condition", target: unit.id, kind, rounds, ...(now.amount !== undefined ? { amount: now.amount } : {}) });
}

/** Whether a unit is Unseen (Sneak): no enemy can attack it, or pick it out to. */
export const unseen = (unit: Unit): boolean => has(unit, "invisible");

/** A unit Unseen gives itself away (it has used an ability, thrown something, shoved): it can be seen again. */
export function giveAway(ctx: Ctx, unit: Unit): void {
  if (!unseen(unit)) return;
  removeCondition(unit, "invisible");
  ctx.events.push({ t: "seen", id: unit.id });
}

/** The conditions that count as wounds, for abilities that grow with them. */
export const DEBUFFS: readonly Condition[] = ["bleeding", "burning", "stunned", "slowed", "glitched", "exposed", "poisoned", "prone"];

/** A unit's Defence. With the board (`state`), a Dour Shanty it stands in counts too. */
export const defenceOf = (unit: Unit, state?: Pick<ZoneState, "units">): number =>
  (state ? songDefence(state, unit) : 0) +
  (unit.side === "hero" && unit.stats ? heroDefence(unit.stats, unit.armor) - ((unit.torch ?? 0) > 0 && unit.torchHand !== "main" && unit.outfit?.off_hand ? SHIELD_SET_ASIDE : 0) : enemyDefence(unit.kind)) +
  (has(unit, "coral_armor") ? CORAL_ARMOR.defence : 0);

/** Whether a unit stands in water (Aqueous Regeneration heals more there). */
export const inWater = (state: ZoneState, unit: Unit): boolean => state.surfaces[posKey(unit.pos)]?.kind === "water";

/** Aqueous Regeneration comes again as a unit's turn starts (or a round passes out of a fight): more for one standing in water. */
export function regrow(ctx: Ctx, unit: Unit): void {
  if (unit.down || !has(unit, "regenerating") || unit.hp >= unit.maxHp) return;
  heal(ctx, unit, rollDice(ctx.rng, AQUEOUS.tick) + (inWater(ctx.state, unit) ? AQUEOUS.water : 0), { actor: null, what: "aqueous_regeneration" });
}

export const saveBonus = (unit: Unit, stat: StatKey): number => (unit.side === "hero" ? mod(statOf(unit, stat)) : enemySave(unit.kind));

function fall(ctx: Ctx, unit: Unit): void {
  unit.hp = 0;
  unit.down = true;
  unit.conditions = [];
  ctx.events.push({ t: "down", id: unit.id });
}

/** Put a shield of `amount` points on a unit for `rounds` of its turns (Bolstered). A bigger one replaces a smaller. */
export function shieldUnit(ctx: Ctx, unit: Unit, amount: number, rounds: number): void {
  if (amount > 0) addCondition(ctx, unit, "bolstered", rounds, amount);
}

/** The points of shield a unit has left (Bolstered), 0 for none. */
export const shieldOf = (unit: Pick<Unit, "conditions">): number => unit.conditions.find((c) => c.kind === "bolstered")?.amount ?? 0;

/** Spend a unit's shield on `amount` of damage. Returns how much of it the shield took; a shield used up is gone. */
function soak(unit: Unit, amount: number): number {
  const held = unit.conditions.find((c) => c.kind === "bolstered");
  if (!held) return 0;
  const took = Math.min(held.amount ?? 0, amount);
  held.amount = (held.amount ?? 0) - took;
  if (held.amount <= 0) removeCondition(unit, "bolstered");
  return took;
}

/**
 * Deal damage from a blow or a blast. Guarded halves it (rounding up) unless it goes through a guard;
 * a hit that lands always does at least 1. A shield (Bolstered) takes what it can before HP does.
 * Returns the HP it cost.
 */
export function damage(ctx: Ctx, target: Unit, amount: number, opts: { actor: string | null; what: string; crit?: boolean; ignoreGuard?: boolean }): number {
  if (target.down) return 0;
  let dealt = Math.max(1, Math.round(amount));
  if (has(target, "guarded") && !opts.ignoreGuard) dealt = Math.ceil(dealt / 2);
  const blocked = soak(target, dealt);
  dealt = Math.min(dealt - blocked, target.hp);
  target.hp -= dealt;
  ctx.events.push({ t: "hit", actor: opts.actor, target: target.id, amount: dealt, what: opts.what, crit: !!opts.crit, ...(blocked > 0 ? { blocked } : {}) });
  if (target.hp <= 0) fall(ctx, target);
  return dealt;
}

/** Damage from a condition or from the ground: no guard against it. */
export function tick(ctx: Ctx, target: Unit, kind: Condition | "poison" | "fire" | "oil" | "water" | "ice", amount: number): void {
  if (target.down || amount <= 0) return;
  const dealt = Math.min(amount, target.hp);
  target.hp -= dealt;
  ctx.events.push({ t: "tick", target: target.id, kind, amount: dealt });
  if (target.hp <= 0) fall(ctx, target);
}

/** Heal a unit. Someone down is back on their feet. Returns what was healed. */
export function heal(ctx: Ctx, target: Unit, amount: number, opts: { actor: string | null; what: string }): number {
  if (target.down) {
    target.down = false;
    ctx.events.push({ t: "up", id: target.id });
  }
  const healed = Math.max(0, Math.min(target.maxHp - target.hp, Math.round(amount)));
  target.hp += healed;
  ctx.events.push({ t: "heal", actor: opts.actor, target: target.id, amount: healed, what: opts.what });
  return healed;
}

export interface AttackContext {
  adv: -1 | 0 | 1;
  /** Added to the roll: high ground, cover. */
  mods: number;
  /** Why, in a few words each, for the tooltip. */
  notes: string[];
}

/**
 * What bears on an attack besides the attacker's skill.
 *
 * Advantage: the target is Exposed or Stunned, or Prone and struck in melee; Focus was spent; a pack
 * animal has one of its own beside the target; the attacker carries a Beacon, or an ally near enough (AURAS.range) does;
 * the attacker is Unseen. Disadvantage: the attacker is Poisoned or Fumbling, is
 * shooting with an enemy beside them, or is shooting at something Prone. Shots also get +2 from
 * higher ground, -2 from lower, and -2 at a target standing among trees.
 */
export function attackContext(state: ZoneState, attacker: Unit, target: Unit, opts: { melee: boolean; focus?: boolean }): AttackContext {
  const notes: string[] = [];
  let advantage = false;
  let disadvantage = false;
  const adv = (why: string) => { advantage = true; notes.push(`Advantage: ${why}`); };
  const dis = (why: string) => { disadvantage = true; notes.push(`Disadvantage: ${why}`); };
  if (has(target, "exposed")) adv("the target is Exposed");
  if (has(target, "stunned")) adv("the target is Stunned");
  if (has(target, "prone") && opts.melee) adv("the target is Prone");
  if (opts.focus) adv("Focus");
  if (has(attacker, "invisible")) adv("you are Unseen");
  if (has(attacker, "inspired")) adv("you are Inspired");
  if (attacker.side === "enemy" && ENEMY_KIT[attacker.kind]?.pack && state.units.some((u) => u.id !== attacker.id && u.side === "enemy" && !u.down && adjacent(u.pos, target.pos))) adv("the pack is on the target");
  if (state.units.some((u) => u.side === attacker.side && !u.down && has(u, "beacon") && hexDistance(u.pos, attacker.pos) <= AURAS.range)) adv(has(attacker, "beacon") ? "your Beacon" : "an ally's Beacon");
  if (has(attacker, "poisoned")) dis("Poisoned");
  if (has(attacker, "glitched")) dis("Fumbling");
  // The party strikes blind at what the light does not reach. The things of the caves see in the dark.
  if (attacker.side === "hero" && inDark(state, target.pos)) dis("the target is in the dark");
  if (!opts.melee) {
    if (state.units.some((u) => u.side !== attacker.side && !u.down && inFight(state, u.id) && adjacent(u.pos, attacker.pos))) dis("an enemy is beside you");
    if (has(target, "prone")) dis("the target is Prone");
  }
  let mods = 0;
  const sung = songHit(state, attacker);
  if (sung > 0) { mods += sung; notes.push(`+${sung} Lively Shanty`); }
  if (!opts.melee) {
    const rise = elevOf(state.map, attacker.pos) - elevOf(state.map, target.pos);
    if (rise > 0) { mods += 2; notes.push("+2 high ground"); }
    if (rise < 0) { mods -= 2; notes.push("-2 shooting uphill"); }
    if (tileAt(state.map, target.pos)?.biome === "forest") { mods -= 2; notes.push("-2 the target is among trees"); }
  }
  return { adv: netAdvantage(advantage, disadvantage), mods, notes };
}

/** Roll an attack and say so. A Fumbling attacker's next attack is the one that suffers: it clears here. */
export function attackRoll(ctx: Ctx, attacker: Unit, target: Unit, opts: { label: string; bonus: number; melee: boolean; focus?: boolean }): Roll {
  const c = attackContext(ctx.state, attacker, target, opts);
  const roll = d20(ctx.rng, { kind: "attack", id: attacker.id, target: target.id, label: opts.label, bonus: opts.bonus + c.mods, vs: defenceOf(target, ctx.state), adv: c.adv });
  removeCondition(attacker, "glitched");
  removeCondition(attacker, "inspired");
  ctx.events.push({ t: "roll", roll });
  return roll;
}

/** Roll a save against a difficulty and say so. */
export function saveRoll(ctx: Ctx, unit: Unit, stat: StatKey, vs: number, label: string, disadvantage = false): Roll {
  const roll = d20(ctx.rng, { kind: "save", id: unit.id, label, bonus: saveBonus(unit, stat), vs, adv: disadvantage ? -1 : 0 });
  ctx.events.push({ t: "roll", roll });
  return roll;
}
