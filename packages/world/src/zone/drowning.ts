// The Warlock's sea. Drowning is a condition on an enemy that comes in
// stacks (its `amount`): at the start of each of its turns it loses a little
// HP for every stack, then must hold its breath (a Vitality save, harder for
// every stack) or lose 2 of its AP. Every stack laid on starts the count again
// for all of them. Two curses lay the stacks: the Curse of Drowning, one
// whenever the enemy starts or ends a turn standing in water, and the Black
// Spot, one at the end of each of its turns. The Black Spot also spoils its
// attacks (engine.ts attackContext), and is passed on to the nearest of its
// side when it falls (engine.ts fall).
//
// The start and end of a turn call in here from zone.ts; the abilities that
// lay the curses are in combat.ts.

import { addCondition, has, inWater, removeCondition, saveRoll, tick, type Ctx } from "./engine";
import { flies } from "./geometry";
import { ACTION_AP, DROWNING, SAVE_STAT } from "./kit";
import type { Budget, Unit, ZoneState } from "./types";

/** The stacks of Drowning on a unit, 0 for none. */
export const drowningStacks = (unit: Pick<Unit, "conditions">): number => unit.conditions.find((c) => c.kind === "drowning")?.amount ?? 0;

/** What a unit must reach to hold its breath with this many stacks on it. */
export const breathDc = (stacks: number): number => DROWNING.dc + DROWNING.perStack * stacks;

/** Lay `stacks` more stacks of Drowning on a unit. All of them, old and new, run DROWNING.rounds more of its turns. */
export function drown(ctx: Ctx, unit: Unit, stacks = 1): void {
  if (unit.down || stacks <= 0) return;
  // The count starts again: addCondition keeps the longer of what is left and what is laid, and what is left is never more.
  addCondition(ctx, unit, "drowning", DROWNING.rounds, drowningStacks(unit) + stacks);
}

/** The Curse of Drowning bites: the unit carries it and stands in water (not flying over it). */
const cursedInWater = (state: ZoneState, unit: Unit): boolean => has(unit, "drowning_curse") && inWater(state, unit) && !flies(unit);

/** A unit's turn starts: the Curse takes hold if it starts in water, then every stack of Drowning takes its HP. */
export function drowningAtStart(ctx: Ctx, unit: Unit): void {
  if (unit.down) return;
  if (cursedInWater(ctx.state, unit)) drown(ctx, unit);
  const stacks = drowningStacks(unit);
  if (stacks > 0) tick(ctx, unit, "drowning", DROWNING.tick * stacks);
}

/** With its turn underway and its budget set: it holds its breath, or loses ACTION_AP of its AP. */
export function holdBreath(ctx: Ctx, unit: Unit, budget: Budget): void {
  const stacks = drowningStacks(unit);
  if (unit.down || stacks <= 0) return;
  if (saveRoll(ctx, unit, SAVE_STAT.drowning, breathDc(stacks), "Hold your breath").ok) return;
  budget.ap = Math.max(0, budget.ap - ACTION_AP);
  ctx.events.push({ t: "choked", id: unit.id });
}

/**
 * The stacks a unit is owed as its turn ends: one for ending it in water with the Curse on it, one for the Black Spot.
 * Counted before its conditions run down (so a curse's last turn still counts), and laid on after (so they run their full count).
 */
export const drowningOwed = (state: ZoneState, unit: Unit): number => (unit.down ? 0 : (cursedInWater(state, unit) ? 1 : 0) + (has(unit, "black_spot") ? 1 : 0));

/** Lay a curse that remembers who laid it (Curse of Drowning, the Black Spot) on an enemy, afresh. */
export function layCurse(ctx: Ctx, by: Unit, target: Unit, kind: "drowning_curse" | "black_spot", rounds: number): void {
  if (target.down) return;
  removeCondition(target, kind);
  addCondition(ctx, target, kind, rounds);
  const laid = target.conditions.find((c) => c.kind === kind);
  if (laid) laid.by = by.id;
}
