// The dice. An attack is one d20 plus a bonus against the target's Defence;
// advantage and disadvantage roll two and keep the better or the worse; a
// natural 20 is a critical hit and rolls its damage dice twice. Damage and
// healing are dice too. Everything here is plain arithmetic on a seeded Rng.

import type { StatKey, Stats } from "@gantt-quest/core";
import type { Rng } from "../rng";
import type { Roll, Unit } from "./types";

export interface Dice {
  n: number;
  d: number;
  plus: number;
}

/** A hero's modifier for a stat: 5 is average. */
export const mod = (stat: number): number => Math.floor((stat - 5) / 2);

/** What practice adds to every attack and save difficulty: 2, and one more every four levels. */
export const proficiency = (level: number): number => 2 + Math.floor((Math.max(1, level) - 1) / 4);

export const statOf = (unit: Pick<Unit, "stats">, stat: StatKey): number => unit.stats?.[stat] ?? 5;

/** Steps of open ground a hero can cover in a turn: 5, shifted by Agility, never under 4 or over 8. */
export function heroMove(stats: Stats): number {
  return Math.max(4, Math.min(8, 5 + Math.floor((stats.agi - 5) / 3)));
}

/** A hero's Defence: 10, plus Agility, plus half their armor (armor counts for 6 at most). */
export function heroDefence(stats: Stats, armor: number): number {
  return 10 + mod(stats.agi) + Math.min(6, Math.floor(armor / 2));
}

/**
 * Dice that average about `amount`: one die up to 8, two beyond, and whatever is left over as a flat bonus.
 * 6 is 1d8+2; 12 is 2d8+3. The old fights' damage numbers are turned into dice with this.
 */
export function diceFor(amount: number): Dice {
  const want = Math.max(1, amount);
  const n = want <= 8 ? 1 : 2;
  const sizes = [4, 6, 8, 10, 12];
  const ideal = (want / n) * 1.3;
  const d = sizes.reduce((best, s) => (Math.abs(s - ideal) < Math.abs(best - ideal) ? s : best), sizes[0]);
  const plus = Math.max(0, Math.round(want - (n * (d + 1)) / 2));
  return { n, d, plus };
}

export const diceAverage = (dice: Dice): number => (dice.n * (dice.d + 1)) / 2 + dice.plus;

export const diceText = (dice: Dice): string => `${dice.n}d${dice.d}${dice.plus > 0 ? `+${dice.plus}` : dice.plus < 0 ? `${dice.plus}` : ""}`;

/** Roll damage or healing. A critical hit rolls the dice (not the flat part) twice. */
export function rollDice(rng: Rng, dice: Dice, crit = false): number {
  let total = dice.plus;
  for (let i = 0; i < dice.n * (crit ? 2 : 1); i++) total += rng.int(1, dice.d);
  return Math.max(0, total);
}

/** Advantage and disadvantage cancel: any of each leaves a plain roll. */
export const netAdvantage = (advantage: boolean, disadvantage: boolean): -1 | 0 | 1 => (advantage === disadvantage ? 0 : advantage ? 1 : -1);

/**
 * One d20 against a number to reach. A natural 20 always makes it and a natural 1 never does, on attacks;
 * saves and shoves just add up.
 */
export function d20(rng: Rng, opts: Pick<Roll, "kind" | "id" | "target" | "label" | "bonus" | "vs" | "adv">): Roll {
  const dice = opts.adv === 0 ? [rng.int(1, 20)] : [rng.int(1, 20), rng.int(1, 20)];
  const kept = opts.adv === 1 ? Math.max(...dice) : opts.adv === -1 ? Math.min(...dice) : dice[0];
  const total = kept + opts.bonus;
  const attack = opts.kind === "attack";
  const crit = attack && kept === 20;
  const ok = crit || (!(attack && kept === 1) && total >= opts.vs);
  return { ...opts, d20: dice, kept, total, ok, crit };
}

/** The chance, 0 to 1, that an attack with this bonus reaches this Defence. For the tooltip, and for the enemy weighing its moves. */
export function hitChance(bonus: number, vs: number, adv: -1 | 0 | 1): number {
  // Faces that hit: a 20 always, a 1 never, the rest by the sum.
  let faces = 0;
  for (let face = 1; face <= 20; face++) if (face === 20 || (face !== 1 && face + bonus >= vs)) faces++;
  const p = faces / 20;
  return adv === 1 ? 1 - (1 - p) ** 2 : adv === -1 ? p ** 2 : p;
}
