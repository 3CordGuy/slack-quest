// Primary stats — STR/INT/VIT/AGI/DEX. Phase 1 of the gameplay overhaul.
//
// These five numbers are the source of truth for combat math. `attack_mod`,
// `magic_mod`, `max_hp`, dodge, crit, and initiative are all derived from
// them. Class only contributes a starting allocation and a per-level
// auto-allocation bonus — flat class-fixed attack_mod/magic_mod is gone.
//
// `statSnapshot(character, equipment)` is the cross-phase boundary: every
// later phase (slot inventory, multi-enemy, dungeon graph) calls it instead
// of touching DB rows. Phase 2 will extend it to sum stat_bonus from
// equipped slot items.

import { CLASSES, classByName, type SkillType } from "./flavor";

export type StatKey = "str" | "int_stat" | "vit" | "agi" | "dex";

export interface Stats {
  str: number;
  int_stat: number;
  vit: number;
  agi: number;
  dex: number;
}

export interface DerivedStats {
  attack_mod: number;
  magic_mod: number;
  max_hp: number;       // requires level
  armor_bonus: number;  // VIT-derived; added on top of equipped armor
  dodge_chance: number; // 0..0.15
  crit_bonus: number;   // 0..0.10
  initiative_bonus: number;
  starting_mana: number;
}

// Default mid-range stats. Used as the DB default and the fallback when a
// character row pre-dates migration 0032.
export const DEFAULT_STATS: Stats = { str: 5, int_stat: 5, vit: 5, agi: 5, dex: 5 };

// Class starting allocations. Sum = 30 across 5 stats. Chosen so a level-1
// stock character of each class matches the legacy class-fixed attack_mod /
// magic_mod / base_hp within ±1.
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

// Per-level auto-allocation. Each class gets +1 to two stats every level
// past 1. Players also get +1 free point per level into `unspent_points`,
// spent via `/gq spend <stat>` or the web level-up modal.
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

// Class lookup that resolves a class name (display string) to its id. Falls
// back via classByName's alias table so legacy class strings still work.
export function classIdFromName(className: string): string {
  return classByName(className).id;
}

// Starting stats for a freshly-rolled character of the given class.
export function startingStatsForClass(className: string): Stats {
  const id = classIdFromName(className);
  return STARTING_STATS[id] ?? DEFAULT_STATS;
}

// Returns the stats a fresh character of `className` should have at the
// given level (level 1 = starting; level N = starting + (N-1) auto-allocs).
// Used by /gq spend backfill and by migration verification tests.
export function statsAtLevel(className: string, level: number): Stats {
  const start = startingStatsForClass(className);
  const id = classIdFromName(className);
  const allocs = LEVELUP_AUTO_ALLOC[id] ?? [];
  const bonusLevels = Math.max(0, level - 1);
  const out: Stats = { ...start };
  for (const key of allocs) {
    out[key] += bonusLevels;
  }
  return out;
}

// Derivation formulas. Constants chosen so a level-1 stock character matches
// legacy combat math ±1 across all classes.
export function deriveAttackMod(stats: Stats): number {
  return Math.floor((stats.str - 5) / 2);
}

export function deriveMagicMod(stats: Stats): number {
  return Math.floor((stats.int_stat - 5) / 2);
}

export function deriveMaxHp(stats: Stats, level: number): number {
  return 16 + 2 * stats.vit + 2 * level;
}

// Extra armor on top of equipped armor_power. Small payoff for VIT-heavy
// builds wearing cloth.
export function deriveArmorBonus(stats: Stats): number {
  return Math.floor(Math.max(0, stats.vit - 5) / 4);
}

// AGI > 5 grants dodge chance, capped at 15%. Rolled before damage in
// resolveMonsterHit; on dodge, emit a monster_miss event and skip damage.
export function deriveDodgeChance(stats: Stats): number {
  return Math.min(0.15, Math.max(0, stats.agi - 5) * 0.01);
}

// DEX > 5 grants extra crit chance on attack/cast on top of the existing
// nat-max-face crit. Caps at 10% so Rogues (DEX 8) get +3%, end-game DEX 15
// gets +10%.
export function deriveCritBonus(stats: Stats): number {
  return Math.min(0.10, Math.max(0, stats.dex - 5) * 0.01);
}

// Added to the 1d6 initiative roll at combat start.
export function deriveInitiativeBonus(stats: Stats): number {
  return Math.floor((stats.agi - 5) / 2);
}

// Mana at character creation. Above-average INT carries an extra point.
export function deriveStartingMana(stats: Stats): number {
  return 1 + Math.floor(stats.int_stat / 4);
}

// Convenience: all derived stats at once.
export function deriveAll(stats: Stats, level: number): DerivedStats {
  return {
    attack_mod: deriveAttackMod(stats),
    magic_mod: deriveMagicMod(stats),
    max_hp: deriveMaxHp(stats, level),
    armor_bonus: deriveArmorBonus(stats),
    dodge_chance: deriveDodgeChance(stats),
    crit_bonus: deriveCritBonus(stats),
    initiative_bonus: deriveInitiativeBonus(stats),
    starting_mana: deriveStartingMana(stats),
  };
}

// Trap auto-pass derivation. A character's STR/INT/DEX ≥ 8 grants the
// corresponding skill, replacing the old class-fixed skills[] array.
export function derivedSkills(stats: Stats): SkillType[] {
  const out: SkillType[] = [];
  if (stats.str >= 8) out.push("str");
  if (stats.dex >= 8) out.push("dex");
  if (stats.int_stat >= 8) out.push("int");
  return out;
}

// Bridge for the legacy class.skills array. statSnapshot uses derivedSkills
// when STATS_V2 is on; falls back to the class-fixed array otherwise.
export function skillsForCharacter(
  className: string,
  stats: Stats,
  v2Enabled: boolean,
): SkillType[] {
  if (v2Enabled) return derivedSkills(stats);
  const cls = classByName(className);
  return cls.skills;
}

// Sentinel feature flag. Wired through env at the worker boundary; pure
// functions in this module take a boolean. Off = legacy class-fixed mods;
// on = stats-derived mods.
export const STATS_V2_FLAG = "STATS_V2";

// statSnapshot — the cross-phase boundary called by every later phase.
//
// Input: a character (post-migration; carries stats columns) and optionally
//        equipment (Phase 2 will add slot stat_bonus summing).
// Output: the Stats record + the derived combat numbers + the legacy
//         attack_mod/magic_mod values for back-compat readers.
//
// Phase 1 ignores equipment.stat_bonus (it doesn't exist yet); Phase 2 will
// sum it before derivation. The boundary stays stable across phases so
// callers don't need to change when slots land.
export interface StatSnapshotInput {
  className: string;
  level: number;
  stats?: Stats; // optional — falls back to statsAtLevel(className, level)
  v2Enabled: boolean;
  // Phase 2: summed stat_bonus from all equipped slot items. Added on top of
  // the character's base stats before derivation when v2Enabled is true.
  equipBonuses?: Partial<Stats>;
}

export interface StatSnapshot {
  stats: Stats;
  derived: DerivedStats;
}

export function statSnapshot(input: StatSnapshotInput): StatSnapshot {
  const base = input.stats ?? statsAtLevel(input.className, input.level);
  if (!input.v2Enabled) {
    // Legacy path: produce stats that exactly reproduce the class-fixed
    // attack_mod/magic_mod values, so downstream combat math is unchanged.
    // We synthesize them by inverting the derivation: STR = 5 + 2*attack_mod,
    // INT = 5 + 2*magic_mod. VIT/AGI/DEX use defaults.
    const cls = classByName(input.className);
    const legacy: Stats = {
      str: 5 + 2 * cls.attack_mod,
      int_stat: 5 + 2 * cls.magic_mod,
      vit: base.vit, // preserve real VIT so HP scaling stays consistent
      agi: 5,
      dex: 5,
    };
    return {
      stats: legacy,
      derived: deriveAll(legacy, input.level),
    };
  }
  // Phase 2: sum equip bonuses from slot items into base stats.
  const eq = input.equipBonuses;
  const stats: Stats = eq ? {
    str: base.str + (eq.str ?? 0),
    int_stat: base.int_stat + (eq.int_stat ?? 0),
    vit: base.vit + (eq.vit ?? 0),
    agi: base.agi + (eq.agi ?? 0),
    dex: base.dex + (eq.dex ?? 0),
  } : base;
  return {
    stats,
    derived: deriveAll(stats, input.level),
  };
}

// Sanity check used by tests + the migration smoke script. Returns true when
// the derived attack_mod / magic_mod for a stock level-1 character match the
// legacy class-fixed values within ±1.
export function legacyParity(): { className: string; ok: boolean; delta: { atk: number; mag: number } }[] {
  return CLASSES.map((cls) => {
    const stats = STARTING_STATS[cls.id] ?? DEFAULT_STATS;
    const derived = deriveAll(stats, 1);
    const atkDelta = derived.attack_mod - cls.attack_mod;
    const magDelta = derived.magic_mod - cls.magic_mod;
    return {
      className: cls.name,
      ok: Math.abs(atkDelta) <= 1 && Math.abs(magDelta) <= 1,
      delta: { atk: atkDelta, mag: magDelta },
    };
  });
}
