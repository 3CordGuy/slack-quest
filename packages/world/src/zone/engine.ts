// The small moves every rule is built from: a condition put on or taken
// off, damage dealt, someone healed, an attack or a save rolled. Each one
// changes the state in the context and adds what happened to its events.

import type { StatKey } from "@gantt-quest/core";
import { tileAt } from "../map";
import type { Rng } from "../rng";
import { adjacent, elevOf, inFight } from "./geometry";
import { ENEMY_KIT, SHIELD_SET_ASIDE, enemyDefence, enemySave } from "./kit";
import { inDark } from "./light";
import { d20, heroDefence, mod, netAdvantage, statOf } from "./rules";
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

/** Put a condition on a unit, or lengthen the one it has. Something soaked cannot be set burning. */
export function addCondition(ctx: Ctx, unit: Unit, kind: Condition, rounds: number): void {
  if (unit.down || rounds <= 0) return;
  if (kind === "burning" && has(unit, "wet")) return;
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
  ctx.events.push({ t: "condition", target: unit.id, kind, rounds });
}

/** The conditions that count as wounds, for abilities that grow with them. */
export const DEBUFFS: readonly Condition[] = ["bleeding", "burning", "stunned", "slowed", "glitched", "exposed", "poisoned", "prone"];

export const defenceOf = (unit: Unit): number =>
  unit.side === "hero" && unit.stats ? heroDefence(unit.stats, unit.armor) - ((unit.torch ?? 0) > 0 && unit.torchHand !== "main" && unit.outfit?.off_hand ? SHIELD_SET_ASIDE : 0) : enemyDefence(unit.kind);

export const saveBonus = (unit: Unit, stat: StatKey): number => (unit.side === "hero" ? mod(statOf(unit, stat)) : enemySave(unit.kind));

function fall(ctx: Ctx, unit: Unit): void {
  unit.hp = 0;
  unit.down = true;
  unit.conditions = [];
  ctx.events.push({ t: "down", id: unit.id });
}

/**
 * Deal damage from a blow or a blast. Guarded halves it (rounding up) unless it goes through a guard;
 * a hit that lands always does at least 1. Returns what was dealt.
 */
export function damage(ctx: Ctx, target: Unit, amount: number, opts: { actor: string | null; what: string; crit?: boolean; ignoreGuard?: boolean }): number {
  if (target.down) return 0;
  let dealt = Math.max(1, Math.round(amount));
  if (has(target, "guarded") && !opts.ignoreGuard) dealt = Math.ceil(dealt / 2);
  dealt = Math.min(dealt, target.hp);
  target.hp -= dealt;
  ctx.events.push({ t: "hit", actor: opts.actor, target: target.id, amount: dealt, what: opts.what, crit: !!opts.crit });
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
 * Advantage: the target is Holed or Stunned, or Prone and struck in melee; Focus was spent; a pack
 * animal has one of its own beside the target. Disadvantage: the attacker is Poisoned or Fouled, is
 * shooting with an enemy beside them, or is shooting at something Prone. Shots also get +2 from
 * higher ground, -2 from lower, and -2 at a target standing among trees.
 */
export function attackContext(state: ZoneState, attacker: Unit, target: Unit, opts: { melee: boolean; focus?: boolean }): AttackContext {
  const notes: string[] = [];
  let advantage = false;
  let disadvantage = false;
  const adv = (why: string) => { advantage = true; notes.push(`Advantage: ${why}`); };
  const dis = (why: string) => { disadvantage = true; notes.push(`Disadvantage: ${why}`); };
  if (has(target, "exposed")) adv("the target is Holed");
  if (has(target, "stunned")) adv("the target is Stunned");
  if (has(target, "prone") && opts.melee) adv("the target is Prone");
  if (opts.focus) adv("Focus");
  if (attacker.side === "enemy" && ENEMY_KIT[attacker.kind]?.pack && state.units.some((u) => u.id !== attacker.id && u.side === "enemy" && !u.down && adjacent(u.pos, target.pos))) adv("the pack is on the target");
  if (has(attacker, "poisoned")) dis("Poisoned");
  if (has(attacker, "glitched")) dis("Fouled");
  // The party strikes blind at what the light does not reach. The things of the caves see in the dark.
  if (attacker.side === "hero" && inDark(state, target.pos)) dis("the target is in the dark");
  if (!opts.melee) {
    if (state.units.some((u) => u.side !== attacker.side && !u.down && inFight(state, u.id) && adjacent(u.pos, attacker.pos))) dis("an enemy is beside you");
    if (has(target, "prone")) dis("the target is Prone");
  }
  let mods = 0;
  if (!opts.melee) {
    const rise = elevOf(state.map, attacker.pos) - elevOf(state.map, target.pos);
    if (rise > 0) { mods += 2; notes.push("+2 high ground"); }
    if (rise < 0) { mods -= 2; notes.push("-2 shooting uphill"); }
    if (tileAt(state.map, target.pos)?.biome === "forest") { mods -= 2; notes.push("-2 the target is among trees"); }
  }
  return { adv: netAdvantage(advantage, disadvantage), mods, notes };
}

/** Roll an attack and say so. A Fouled attacker's next attack is the one that suffers: it clears here. */
export function attackRoll(ctx: Ctx, attacker: Unit, target: Unit, opts: { label: string; bonus: number; melee: boolean; focus?: boolean }): Roll {
  const c = attackContext(ctx.state, attacker, target, opts);
  const roll = d20(ctx.rng, { kind: "attack", id: attacker.id, target: target.id, label: opts.label, bonus: opts.bonus + c.mods, vs: defenceOf(target), adv: c.adv });
  removeCondition(attacker, "glitched");
  ctx.events.push({ t: "roll", roll });
  return roll;
}

/** Roll a save against a difficulty and say so. */
export function saveRoll(ctx: Ctx, unit: Unit, stat: StatKey, vs: number, label: string, disadvantage = false): Roll {
  const roll = d20(ctx.rng, { kind: "save", id: unit.id, label, bonus: saveBonus(unit, stat), vs, adv: disadvantage ? -1 : 0 });
  ctx.events.push({ t: "roll", roll });
  return roll;
}
