// The five primary stats, what each class starts with, and how a hero levels.
//
// Class ids are the ones stored on character rows. They keep the names they
// were given in the original game (the Harbor shows its own class names: see
// `CLASSES` in packages/world/src/progression.ts).

export type StatKey = "str" | "int_stat" | "vit" | "agi" | "dex";

export interface Stats {
  str: number;
  int_stat: number;
  vit: number;
  agi: number;
  dex: number;
}

// Mid-range stats: the fallback for a class id nobody knows.
export const DEFAULT_STATS: Stats = { str: 5, int_stat: 5, vit: 5, agi: 5, dex: 5 };

// Class starting allocations. Sum = 30 across 5 stats.
export const STARTING_STATS: Record<string, Stats> = {
  devops_mage:    { str: 4, int_stat: 9,  vit: 5,  agi: 6, dex: 6 },
  qa_paladin:     { str: 9, int_stat: 4,  vit: 9,  agi: 4, dex: 4 },
  backend_druid:  { str: 6, int_stat: 7,  vit: 6,  agi: 5, dex: 6 },
  frontend_bard:  { str: 4, int_stat: 9,  vit: 5,  agi: 6, dex: 6 },
  staff_sage:     { str: 4, int_stat: 10, vit: 6,  agi: 5, dex: 5 },
  refactor_rogue: { str: 7, int_stat: 4,  vit: 4,  agi: 7, dex: 8 },
  sre_warden:     { str: 9, int_stat: 4,  vit: 10, agi: 4, dex: 3 },
  data_warlock:   { str: 4, int_stat: 10, vit: 5,  agi: 5, dex: 6 },
};

// Per-level auto-allocation: each class gets +1 to two stats every level past 1.
export const LEVELUP_AUTO_ALLOC: Record<string, StatKey[]> = {
  devops_mage:    ["int_stat", "dex"],
  qa_paladin:     ["str", "vit"],
  backend_druid:  ["int_stat", "str"],
  frontend_bard:  ["int_stat", "agi"],
  staff_sage:     ["int_stat", "vit"],
  refactor_rogue: ["dex", "agi"],
  sre_warden:     ["vit", "str"],
  data_warlock:   ["int_stat", "vit"],
};

// Free points awarded per level (in addition to the auto-allocation above).
export const FREE_POINTS_PER_LEVEL = 1;

// XP threshold to reach a given level. Curve is gentle early, steeper later.
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.floor(100 * Math.pow(level - 1, 1.8));
}
