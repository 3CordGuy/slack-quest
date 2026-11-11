// Static game content for the overworld game: hero classes, weapons and
// their abilities, enemies, and loot. Data only; the reducers in battle.ts
// and world.ts give it meaning.

import type { StatKey, Stats } from "@gantt-quest/core";
import type { Rng } from "./rng";

/** Effect names match EFFECT_META in packages/core/src/flavor.ts, plus `guarded`. */
export type EffectKind = "bleeding" | "burning" | "stunned" | "guarded";

export const EFFECT_INFO: Record<EffectKind, { name: string; blurb: string; color: string }> = {
  bleeding: { name: "Bleeding", blurb: "Loses 2 HP at the start of each turn.", color: "#f87171" },
  burning: { name: "Burning", blurb: "Loses 3 HP at the start of each turn.", color: "#fb923c" },
  stunned: { name: "Stunned", blurb: "Skips the next turn.", color: "#a78bfa" },
  guarded: { name: "Guarded", blurb: "Takes half damage until its next turn.", color: "#93c5fd" },
};

export const EFFECT_TICK: Partial<Record<EffectKind, number>> = { bleeding: 2, burning: 3 };

// ---------- classes ----------

export interface HeroClass {
  id: string;
  name: string;
  blurb: string;
  /** First entry is the starting weapon; the rest drop as loot. */
  weapons: string[];
}

export const HERO_CLASSES: HeroClass[] = [
  {
    id: "qa_paladin",
    name: "QA Paladin",
    blurb: "Tough front-liner. Hits hard with Strength and shrugs off blows.",
    weapons: ["mace", "greatsword"],
  },
  {
    id: "devops_mage",
    name: "DevOps Mage",
    blurb: "Fragile caster. Burns enemies and patches up allies with Intelligence.",
    weapons: ["staff", "tome"],
  },
  {
    id: "refactor_rogue",
    name: "Refactor Rogue",
    blurb: "Fast and precise. Opens wounds with Dexterity and usually acts first.",
    weapons: ["daggers", "shortbow"],
  },
];

export function heroClass(id: string): HeroClass | undefined {
  return HERO_CLASSES.find((c) => c.id === id);
}

// ---------- abilities ----------

export type AbilityTarget = "enemy" | "all_enemies" | "ally" | "self";

export interface AbilityDef {
  id: string;
  name: string;
  stat: StatKey;
  rolls: number;
  target: AbilityTarget;
  /** Damage at a perfect result, before the level bonus. Scales with successes. */
  damage?: number;
  /** Healing at a perfect result. Scales with successes. */
  heal?: number;
  /** Applied to the user when at least one roll succeeds. */
  selfEffect?: { effect: EffectKind; turns: number };
  /** Applied to the target only on a perfect result. */
  perfect?: { effect: EffectKind; turns: number };
  blurb: string;
}

export const ABILITIES: Record<string, AbilityDef> = {
  smite: { id: "smite", name: "Smite", stat: "str", rolls: 3, target: "enemy", damage: 9, perfect: { effect: "stunned", turns: 1 }, blurb: "Solid blow. Perfect: stuns." },
  shield_wall: { id: "shield_wall", name: "Shield Wall", stat: "vit", rolls: 2, target: "self", heal: 4, selfEffect: { effect: "guarded", turns: 1 }, blurb: "Guard yourself and catch your breath." },
  cleave: { id: "cleave", name: "Cleave", stat: "str", rolls: 4, target: "all_enemies", damage: 7, blurb: "Hits every enemy." },
  heavy_blow: { id: "heavy_blow", name: "Heavy Blow", stat: "str", rolls: 2, target: "enemy", damage: 12, perfect: { effect: "bleeding", turns: 3 }, blurb: "All or nothing. Perfect: bleeding." },
  firebolt: { id: "firebolt", name: "Firebolt", stat: "int_stat", rolls: 3, target: "enemy", damage: 9, perfect: { effect: "burning", turns: 3 }, blurb: "Perfect: sets the target burning." },
  mend: { id: "mend", name: "Mend", stat: "int_stat", rolls: 2, target: "ally", heal: 10, blurb: "Heal an ally (or yourself)." },
  chain_spark: { id: "chain_spark", name: "Chain Spark", stat: "int_stat", rolls: 4, target: "all_enemies", damage: 6, blurb: "Arcs through every enemy." },
  hex_bolt: { id: "hex_bolt", name: "Hex Bolt", stat: "int_stat", rolls: 2, target: "enemy", damage: 6, perfect: { effect: "stunned", turns: 1 }, blurb: "Perfect: stuns." },
  quick_stab: { id: "quick_stab", name: "Quick Stab", stat: "dex", rolls: 2, target: "enemy", damage: 8, perfect: { effect: "bleeding", turns: 3 }, blurb: "Reliable. Perfect: bleeding." },
  flurry: { id: "flurry", name: "Flurry", stat: "dex", rolls: 4, target: "enemy", damage: 12, blurb: "Four cuts; every one has to land." },
  aimed_shot: { id: "aimed_shot", name: "Aimed Shot", stat: "dex", rolls: 3, target: "enemy", damage: 10, blurb: "A careful, heavy shot." },
  pin_down: { id: "pin_down", name: "Pin Down", stat: "agi", rolls: 2, target: "enemy", damage: 4, perfect: { effect: "stunned", turns: 1 }, blurb: "Perfect: stuns." },
};

export interface WeaponDef {
  id: string;
  name: string;
  classId: string;
  abilities: string[];
}

export const WEAPONS: Record<string, WeaponDef> = {
  mace: { id: "mace", name: "Audit Mace", classId: "qa_paladin", abilities: ["smite", "shield_wall"] },
  greatsword: { id: "greatsword", name: "Regression Greatsword", classId: "qa_paladin", abilities: ["cleave", "heavy_blow", "shield_wall"] },
  staff: { id: "staff", name: "Pipeline Staff", classId: "devops_mage", abilities: ["firebolt", "mend"] },
  tome: { id: "tome", name: "Runbook Tome", classId: "devops_mage", abilities: ["chain_spark", "hex_bolt", "mend"] },
  daggers: { id: "daggers", name: "Twin Diff Daggers", classId: "refactor_rogue", abilities: ["quick_stab", "flurry"] },
  shortbow: { id: "shortbow", name: "Hotfix Shortbow", classId: "refactor_rogue", abilities: ["aimed_shot", "pin_down", "quick_stab"] },
};

// ---------- enemies ----------

export interface EnemyAttack {
  name: string;
  rolls: number;
  pct: number;
  damage: number;
  target: "hero" | "all_heroes";
  perfect?: { effect: EffectKind; turns: number };
  weight: number;
}

export interface EnemyDef {
  kind: string;
  name: string;
  hp: number;
  /** Initiative base, on the same 0–100 scale as statPct(agi). */
  speed: number;
  xp: number;
  boss?: boolean;
  attacks: EnemyAttack[];
}

export const ENEMIES: Record<string, EnemyDef> = {
  bandit: {
    kind: "bandit", name: "Bandit", hp: 16, speed: 60, xp: 12,
    attacks: [
      { name: "Slash", rolls: 3, pct: 60, damage: 6, target: "hero", weight: 3 },
      { name: "Cheap Shot", rolls: 2, pct: 55, damage: 5, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 1 },
    ],
  },
  wolf: {
    kind: "wolf", name: "Dire Wolf", hp: 12, speed: 75, xp: 10,
    attacks: [{ name: "Bite", rolls: 2, pct: 70, damage: 5, target: "hero", perfect: { effect: "bleeding", turns: 2 }, weight: 1 }],
  },
  cultist: {
    kind: "cultist", name: "Cultist", hp: 14, speed: 50, xp: 14,
    attacks: [
      { name: "Dark Bolt", rolls: 3, pct: 65, damage: 7, target: "hero", weight: 3 },
      { name: "Immolate", rolls: 2, pct: 50, damage: 4, target: "hero", perfect: { effect: "burning", turns: 2 }, weight: 1 },
    ],
  },
  villain: {
    kind: "villain", name: "Villain", hp: 34, speed: 55, xp: 40, boss: true,
    attacks: [
      { name: "Crushing Strike", rolls: 3, pct: 70, damage: 9, target: "hero", perfect: { effect: "stunned", turns: 1 }, weight: 3 },
      { name: "Sweeping Ruin", rolls: 4, pct: 60, damage: 6, target: "all_heroes", weight: 2 },
    ],
  },
};

// ---------- loot ----------

export type Rarity = "common" | "uncommon" | "rare";

/** A persistent item: written to the player's inventory when it drops. */
export interface ItemDef {
  kind: "weapon" | "trinket";
  /** Weapon id, or trinket id. */
  ref: string;
  name: string;
  rarity: Rarity;
  slot: "weapon" | "trinket";
  statBonus: Partial<Stats>;
}

const TRINKETS: ItemDef[] = [
  { kind: "trinket", ref: "lucky_lanyard", name: "Lucky Lanyard", rarity: "common", slot: "trinket", statBonus: { dex: 1 } },
  { kind: "trinket", ref: "standup_whistle", name: "Stand-up Whistle", rarity: "common", slot: "trinket", statBonus: { agi: 1 } },
  { kind: "trinket", ref: "rubber_duck", name: "Rubber Duck of Insight", rarity: "common", slot: "trinket", statBonus: { int_stat: 1 } },
  { kind: "trinket", ref: "iron_mug", name: "Iron Coffee Mug", rarity: "common", slot: "trinket", statBonus: { vit: 1 } },
  { kind: "trinket", ref: "grip_tape", name: "Grip Tape Wraps", rarity: "common", slot: "trinket", statBonus: { str: 1 } },
  { kind: "trinket", ref: "oncall_pager", name: "On-call Pager", rarity: "uncommon", slot: "trinket", statBonus: { agi: 1, dex: 1 } },
  { kind: "trinket", ref: "blameless_badge", name: "Blameless Badge", rarity: "uncommon", slot: "trinket", statBonus: { vit: 1, str: 1 } },
  { kind: "trinket", ref: "root_token", name: "Root Access Token", rarity: "rare", slot: "trinket", statBonus: { int_stat: 2, dex: 1 } },
  { kind: "trinket", ref: "legacy_keystone", name: "Legacy Keystone", rarity: "rare", slot: "trinket", statBonus: { str: 2, vit: 1 } },
];

export function weaponItem(weaponId: string): ItemDef {
  const w = WEAPONS[weaponId];
  return { kind: "weapon", ref: w.id, name: w.name, rarity: "uncommon", slot: "weapon", statBonus: {} };
}

/**
 * Roll one persistent item for a hero. `quality` 0..1 shifts the odds toward
 * rarer trinkets and the class's second weapon.
 */
export function rollItem(rng: Rng, classId: string, quality: number): ItemDef {
  const cls = heroClass(classId);
  const second = cls?.weapons[1];
  if (second && rng.chance(0.2 + quality * 0.3)) return weaponItem(second);
  const r = rng.next() + quality * 0.35;
  const rarity: Rarity = r > 1.05 ? "rare" : r > 0.65 ? "uncommon" : "common";
  const pool = TRINKETS.filter((t) => t.rarity === rarity);
  return { ...rng.pick(pool) };
}

// ---------- run-scoped key items ----------

export interface KeyItemDef {
  id: string;
  /** What holding it does, applied once when received. */
  grant: { maxFocus?: number; potions?: number };
}

export const KEY_ITEMS: Record<string, KeyItemDef> = {
  charm: { id: "charm", grant: { maxFocus: 2 } },
};
