// Character creation rolls and levelling. Uses the stat set and per-class
// tables from packages/core/src/stats.ts so characters grow the way they do
// in the existing game.

import {
  DEFAULT_STATS,
  FREE_POINTS_PER_LEVEL,
  LEVELUP_AUTO_ALLOC,
  STARTING_STATS,
  deriveMaxHp,
  xpForLevel,
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

/** What each stat does in this game, in a line. Shown wherever stats are listed. */
export const STAT_BLURB: Record<StatKey, string> = {
  str: "Heavy weapon abilities: Smite, Cleave, Heavy Blow.",
  int_stat: "Every spell, song and heal (Mages, Druids, Bards, Sages), and persuading islanders.",
  vit: "+2 max HP per point. Also powers Shield Wall.",
  agi: "Movement each turn, acting first in a fight, and fleeing.",
  dex: "Dagger and bow abilities, and searching caches.",
};

/**
 * Starting stats for a new character: the class baseline with each stat
 * nudged by -1..+1, so a lucky roll is worth about a level, not three.
 * Re-rolling just calls this again.
 */
export function rollStartingStats(rng: Rng, classId: string): Stats {
  const base = STARTING_STATS[classId] ?? DEFAULT_STATS;
  const out = { ...base };
  for (const key of STAT_KEYS) {
    out[key] = Math.max(2, base[key] + rng.pick([-1, 0, 0, 1]));
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

/**
 * XP needed to go from `level` to `level + 1`, on the original game's curve
 * (`xpForLevel`): 100, 248, 374, 490, 599… A won voyage pays very roughly 150
 * to 200, so the first level comes in one voyage and each later one takes
 * longer than the last.
 */
export function xpToNext(level: number): number {
  return xpForLevel(level + 1) - xpForLevel(level);
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
