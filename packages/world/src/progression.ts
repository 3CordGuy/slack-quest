// Character creation rolls and levelling. Uses the stat set and per-class
// tables from packages/core/src/stats.ts so characters grow the way they do
// in the existing game.

import {
  DEFAULT_STATS,
  FREE_POINTS_PER_LEVEL,
  LEVELUP_AUTO_ALLOC,
  STARTING_STATS,
  deriveMaxHp,
  type StatKey,
  type Stats,
} from "@gantt-quest/core";
import type { Rng } from "./rng";

export const STAT_KEYS: StatKey[] = ["str", "int_stat", "vit", "agi", "dex"];

export const STAT_LABEL: Record<StatKey, string> = {
  str: "Strength",
  int_stat: "Intelligence",
  vit: "Vitality",
  agi: "Agility",
  dex: "Dexterity",
};

/**
 * Starting stats for a new character: the class baseline with each stat
 * nudged by -1..+2. Re-rolling just calls this again.
 */
export function rollStartingStats(rng: Rng, classId: string): Stats {
  const base = STARTING_STATS[classId] ?? DEFAULT_STATS;
  const out = { ...base };
  for (const key of STAT_KEYS) {
    out[key] = Math.max(2, base[key] + rng.pick([-1, 0, 0, 1, 1, 2]));
  }
  return out;
}

export function addStats(base: Stats, ...bonuses: Partial<Stats>[]): Stats {
  const out = { ...base };
  for (const b of bonuses) {
    for (const key of STAT_KEYS) out[key] += b[key] ?? 0;
  }
  return out;
}

/** XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return 30 + level * 20;
}

export interface Progress {
  classId: string;
  level: number;
  xp: number;
  stats: Stats;
  unspent: number;
}

/** Add XP and apply any level-ups: class auto-allocation plus one free point. */
export function applyXp(p: Progress, amount: number): Progress & { levelsGained: number } {
  const out = { ...p, stats: { ...p.stats }, xp: p.xp + Math.max(0, Math.floor(amount)) };
  let levelsGained = 0;
  while (out.xp >= xpToNext(out.level)) {
    out.xp -= xpToNext(out.level);
    out.level += 1;
    levelsGained += 1;
    for (const key of LEVELUP_AUTO_ALLOC[out.classId] ?? []) out.stats[key] += 1;
    out.unspent += FREE_POINTS_PER_LEVEL;
  }
  return { ...out, levelsGained };
}

export function maxHpFor(stats: Stats, level: number): number {
  return deriveMaxHp(stats, level);
}

/** Focus pool: 2, plus one per five levels. */
export function maxFocusFor(level: number): number {
  return 2 + Math.floor(level / 5);
}
