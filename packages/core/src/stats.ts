// Primary stats — STR/INT/VIT/AGI/DEX.
//
// These five numbers are the source of truth for combat math. `attack_mod`,
// `magic_mod`, `max_hp`, dodge, crit, and initiative are all derived from
// them. Class contributes a starting allocation and a per-level auto-alloc
// bonus; players spend one free point per level via `/sq spend <stat>`.
//
// `statSnapshot` is the cross-phase boundary called by all combat init paths.
// It sums equipped slot stat_bonus values on top of the character's base stats
// before deriving combat numbers.

import { classByName, type SkillType } from "./flavor";

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
  max_mana: number;     // requires level; INT-driven scaling
  armor_bonus: number;  // VIT-derived; added on top of equipped armor
  dodge_chance: number; // 0..0.15
  crit_bonus: number;   // 0..0.10
  initiative_bonus: number;
  starting_mana: number;
}

// Default mid-range stats. Used as the DB default and the fallback when a
// character row pre-dates migration 0032.
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

// Max mana — scales with INT and level like HP scales with VIT and level.
// 2 + floor(max(0, int_stat - 4) / 2) + floor(level / 6)
// L1 spread: Sage/Warlock (INT 10) → 5, Mage/Bard (INT 9) → 4, Druid (INT 7) → 3, Paladin/Rogue/Warden (INT 4) → 2
export function deriveMaxMana(intStat: number, level: number): number {
  return 2 + Math.max(0, Math.floor((intStat - 4) / 2)) + Math.floor(level / 6);
}

// Mana at character creation. Kept for legacy read paths; use deriveMaxMana for new code.
export function deriveStartingMana(stats: Stats): number {
  return 1 + Math.floor(stats.int_stat / 4);
}

// Convenience: all derived stats at once.
export function deriveAll(stats: Stats, level: number): DerivedStats {
  return {
    attack_mod: deriveAttackMod(stats),
    magic_mod: deriveMagicMod(stats),
    max_hp: deriveMaxHp(stats, level),
    max_mana: deriveMaxMana(stats.int_stat, level),
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

export function skillsForCharacter(
  _className: string,
  stats: Stats,
): SkillType[] {
  return derivedSkills(stats);
}

// statSnapshot — the cross-phase boundary called by every later phase.
//
// Input: a character (carries stats columns) and optionally equipment
//        stat_bonus summed from all equipped slot items.
// Output: the Stats record + all derived combat numbers.
export interface StatSnapshotInput {
  className: string;
  level: number;
  stats?: Stats; // optional — falls back to statsAtLevel(className, level)
  // Summed stat_bonus from all equipped slot items; added on top of base stats.
  equipBonuses?: Partial<Stats>;
  // Summed non-primary affix bonuses from all equipped items. Flows
  // straight through into the snapshot's `effects` bag for combat-side
  // hooks to read. Keys mirror AFFIX_REGISTRY[*].stat — e.g. crit_pct,
  // lifesteal, fire_dmg, thorns, mana_regen, dodge_pct, resist_fire.
  affixBonuses?: Partial<AffixEffects>;
}

// Non-primary-stat bonuses produced by gear affixes. Resistances mirror the
// existing resist_* keys already read directly by combat.ts; the rest are
// new hooks that combat / regen / proc handlers will pick up in the next
// slice (see docs/gear-affixes-and-uniques.md "Combat hooks" section).
export interface AffixEffects {
  crit_pct: number;
  lifesteal: number;
  fire_dmg: number;
  ice_dmg: number;
  lightning_dmg: number;
  resist_fire: number;
  resist_ice: number;
  resist_lightning: number;
  resist_magic: number;
  thorns: number;
  mana_regen: number;
  dodge_pct: number;
}

export const EMPTY_AFFIX_EFFECTS: AffixEffects = {
  crit_pct: 0,
  lifesteal: 0,
  fire_dmg: 0,
  ice_dmg: 0,
  lightning_dmg: 0,
  resist_fire: 0,
  resist_ice: 0,
  resist_lightning: 0,
  resist_magic: 0,
  thorns: 0,
  mana_regen: 0,
  dodge_pct: 0,
};

// Splits a summed stat_bonus map into (primary-stat deltas, affix-effect deltas).
// Useful for callers that read raw item.stat_bonus JSON and want to feed
// statSnapshot without re-keying everything by hand.
export function splitStatBonus(stat_bonus: Partial<Record<string, number>> | undefined): {
  primary: Partial<Stats>;
  affixes: Partial<AffixEffects>;
} {
  const primary: Partial<Stats> = {};
  const affixes: Partial<AffixEffects> = {};
  if (!stat_bonus) return { primary, affixes };
  for (const [key, raw] of Object.entries(stat_bonus)) {
    if (typeof raw !== "number") continue;
    if (key === "str" || key === "int_stat" || key === "vit" || key === "agi" || key === "dex") {
      primary[key] = (primary[key] ?? 0) + raw;
    } else if (key in EMPTY_AFFIX_EFFECTS) {
      const k = key as keyof AffixEffects;
      affixes[k] = (affixes[k] ?? 0) + raw;
    }
    // Unknown keys are silently ignored — keeps forward-compat with affixes
    // added in newer drops than the reader knows about.
  }
  return { primary, affixes };
}

export interface StatSnapshot {
  stats: Stats;
  derived: DerivedStats;
  // Effects from gear affixes, summed across all equipped items. Combat
  // code reads these at the matching lifecycle hooks: crit_pct adds to
  // crit chance, lifesteal heals on hit, *_dmg adds flat elemental damage,
  // resist_* reduces incoming damage of that type, thorns reflects on
  // melee taken, mana_regen ticks each turn, dodge_pct adds to dodge.
  effects: AffixEffects;
}

export function statSnapshot(input: StatSnapshotInput): StatSnapshot {
  const base = input.stats ?? statsAtLevel(input.className, input.level);
  const eq = input.equipBonuses;
  const stats: Stats = eq ? {
    str: base.str + (eq.str ?? 0),
    int_stat: base.int_stat + (eq.int_stat ?? 0),
    vit: base.vit + (eq.vit ?? 0),
    agi: base.agi + (eq.agi ?? 0),
    dex: base.dex + (eq.dex ?? 0),
  } : base;
  const aff = input.affixBonuses;
  const effects: AffixEffects = aff ? {
    crit_pct: aff.crit_pct ?? 0,
    lifesteal: aff.lifesteal ?? 0,
    fire_dmg: aff.fire_dmg ?? 0,
    ice_dmg: aff.ice_dmg ?? 0,
    lightning_dmg: aff.lightning_dmg ?? 0,
    resist_fire: aff.resist_fire ?? 0,
    resist_ice: aff.resist_ice ?? 0,
    resist_lightning: aff.resist_lightning ?? 0,
    resist_magic: aff.resist_magic ?? 0,
    thorns: aff.thorns ?? 0,
    mana_regen: aff.mana_regen ?? 0,
    dodge_pct: aff.dodge_pct ?? 0,
  } : EMPTY_AFFIX_EFFECTS;
  return {
    stats,
    derived: deriveAll(stats, input.level),
    effects,
  };
}

