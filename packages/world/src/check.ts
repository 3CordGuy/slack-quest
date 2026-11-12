// The one roll mechanic. A check is N independent rolls against a
// percentage derived from one stat. Weapon attacks, persuasion, movement and
// overworld actions all resolve through rollCheck.

import type { StatKey } from "@gantt-quest/core";
import type { Rng } from "./rng";

export interface CheckResult {
  label: string;
  stat: StatKey | null;
  pct: number;
  /** One entry per roll, in order. Focus-guaranteed rolls come first. */
  rolls: boolean[];
  focus: number;
  successes: number;
  perfect: boolean;
  fumble: boolean;
}

export const MIN_PCT = 20;
export const MAX_PCT = 95;

/**
 * Stat value → success chance per roll. 4 → 42%, 9 → 57%, 15 → 75%, 22 → 95%.
 * Shallow on purpose: a class's main stat starts near 9 and gains about one
 * point a level, so there is room to grow until roughly level 12.
 */
export function statPct(stat: number, bonus = 0): number {
  return Math.max(MIN_PCT, Math.min(MAX_PCT, 30 + stat * 3 + bonus));
}

export function rollCheck(
  rng: Rng,
  opts: { label: string; stat?: StatKey | null; pct: number; count: number; focus?: number },
): CheckResult {
  const count = Math.max(1, Math.floor(opts.count));
  const focus = Math.max(0, Math.min(count, Math.floor(opts.focus ?? 0)));
  const pct = Math.max(0, Math.min(100, opts.pct));
  const rolls: boolean[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(i < focus ? true : rng.next() * 100 < pct);
  }
  const successes = rolls.filter(Boolean).length;
  return {
    label: opts.label,
    stat: opts.stat ?? null,
    pct,
    rolls,
    focus,
    successes,
    perfect: successes === count,
    fumble: successes === 0,
  };
}
