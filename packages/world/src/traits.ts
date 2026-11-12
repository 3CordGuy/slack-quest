// Class traits: passives a hero picks as they level, one of two at each
// trait level. They grew out of the old game's talent trees, cut down to the
// shape of a For the King voyage: no points or ranks, just a choice at level
// 2 and another at level 4. Each trait is one rule from a small set that
// battle.ts knows how to apply. Data only here.

import type { EffectKind } from "./content";

/** The levels a hero picks a trait at; tier 1 is the first, tier 2 the second. */
export const TRAIT_LEVELS = [2, 4] as const;

export type TraitRule =
  /** Extra damage on direct hits against a target carrying `effect`. */
  | { t: "vs_effect"; effect: EffectKind; bonus: number }
  /** Extra damage per distinct debuff on the target. */
  | { t: "per_debuff"; bonus: number }
  /** Damage multiplied by `mult` against a target under a quarter of its max HP. */
  | { t: "finisher"; mult: number }
  /** Once a fight, a blow that would put the hero down leaves them on 1 HP. */
  | { t: "last_stand" }
  /** Guarded at the start of each of the hero's turns while under a third of max HP. */
  | { t: "low_hp_guard" }
  /** HP back at the start of each of the hero's turns. */
  | { t: "regen"; amount: number }
  /** HP back whenever any enemy goes down. */
  | { t: "on_kill_heal"; amount: number }
  /** +1 focus whenever another hero lands a perfect. */
  | { t: "ally_perfect_focus" }
  /** The first focus the hero spends in a fight comes back. */
  | { t: "first_focus_free" }
  /** Effects the hero puts on anyone last `turns` longer. */
  | { t: "longer"; effects: EffectKind[]; turns: number }
  /** The hero's perfect hits also leave `effect` on the target. */
  | { t: "perfect_effect"; effect: EffectKind; turns: number }
  /** The hero starts every fight with `effect`. */
  | { t: "start_effect"; effect: EffectKind; turns: number }
  /** Potions the hero hands out (to themselves or an ally) heal this much more. */
  | { t: "potion_bonus"; amount: number };

export interface TraitDef {
  id: string;
  classId: string;
  /** 1: picked at TRAIT_LEVELS[0]; 2: at TRAIT_LEVELS[1]. */
  tier: 1 | 2;
  name: string;
  blurb: string;
  rule: TraitRule;
}

/** Debuffs, for rules that count them. */
export const DEBUFFS: EffectKind[] = ["bleeding", "burning", "stunned", "slowed", "glitched", "exposed"];

const t = (classId: string, tier: 1 | 2, id: string, name: string, blurb: string, rule: TraitRule): TraitDef => ({ id, classId, tier, name, blurb, rule });

export const TRAITS: TraitDef[] = [
  // Tidewall Paladin
  t("qa_paladin", 1, "breakwater_stance", "Breakwater Stance", "While under a third of your HP, you start each turn Guarded.", { t: "low_hp_guard" }),
  t("qa_paladin", 1, "keelhaul", "Keelhaul", "+5 damage against Stunned enemies.", { t: "vs_effect", effect: "stunned", bonus: 5 }),
  t("qa_paladin", 2, "last_bulkhead", "Last Bulkhead", "Once a fight, a blow that would put you down leaves you on 1 HP.", { t: "last_stand" }),
  t("qa_paladin", 2, "read_the_wreckage", "Read the Wreckage", "+2 damage for each different debuff on the target.", { t: "per_debuff", bonus: 2 }),
  // Stormcall Mage
  t("devops_mage", 1, "st_elmos_fire", "St. Elmo's Fire", "+2 damage against Burning enemies.", { t: "vs_effect", effect: "burning", bonus: 2 }),
  t("devops_mage", 1, "ride_the_storm", "Ride the Storm", "Start every fight with a Fair Wind.", { t: "start_effect", effect: "hasted", turns: 1 }),
  t("devops_mage", 2, "eye_of_the_storm", "Eye of the Storm", "The first focus you spend in a fight comes back.", { t: "first_focus_free" }),
  t("devops_mage", 2, "squall_line", "Squall Line", "Burning and Fouled that you cause last a turn longer.", { t: "longer", effects: ["burning", "glitched"], turns: 1 }),
  // Smuggler Rogue
  t("refactor_rogue", 1, "cutthroat", "Cutthroat", "Half again as much damage to enemies under a quarter of their HP.", { t: "finisher", mult: 1.5 }),
  t("refactor_rogue", 1, "bleed_em_dry", "Bleed 'Em Dry", "+2 damage against Bleeding enemies.", { t: "vs_effect", effect: "bleeding", bonus: 2 }),
  t("refactor_rogue", 2, "slip_the_noose", "Slip the Noose", "Once a fight, a blow that would put you down leaves you on 1 HP.", { t: "last_stand" }),
  t("refactor_rogue", 2, "spyglass", "Spyglass", "Your perfect hits also leave the target Holed.", { t: "perfect_effect", effect: "exposed", turns: 2 }),
  // Reef Druid
  t("backend_druid", 1, "tide_pools", "Tide Pools", "Grow back 1 more HP at the start of each turn.", { t: "regen", amount: 1 }),
  t("backend_druid", 1, "rip_current", "Rip Current", "+2 damage against Becalmed enemies.", { t: "vs_effect", effect: "slowed", bonus: 2 }),
  t("backend_druid", 2, "carrion_crabs", "Carrion Crabs", "Heal 3 HP whenever an enemy goes down.", { t: "on_kill_heal", amount: 3 }),
  t("backend_druid", 2, "kelp_snare", "Kelp Snare", "Becalmed that you cause lasts a turn longer.", { t: "longer", effects: ["slowed"], turns: 1 }),
  // Shanty Bard
  t("frontend_bard", 1, "call_and_response", "Call and Response", "+1 focus whenever a crewmate lands a perfect.", { t: "ally_perfect_focus" }),
  t("frontend_bard", 1, "sea_legs", "Sea Legs", "Potions you hand out, to yourself or a crewmate, heal 6 more.", { t: "potion_bonus", amount: 6 }),
  t("frontend_bard", 2, "heave_ho", "Heave Ho", "Fair Wind that you give lasts a turn longer.", { t: "longer", effects: ["hasted"], turns: 1 }),
  t("frontend_bard", 2, "jeers_from_the_rigging", "Jeers from the Rigging", "Your perfect hits also leave the target Holed.", { t: "perfect_effect", effect: "exposed", turns: 2 }),
  // Starchart Sage
  t("staff_sage", 1, "dead_reckoning", "Dead Reckoning", "The first focus you spend in a fight comes back.", { t: "first_focus_free" }),
  t("staff_sage", 1, "star_chart", "Star Chart", "+2 damage for each different debuff on the target.", { t: "per_debuff", bonus: 2 }),
  t("staff_sage", 2, "conjunction", "Conjunction", "Double damage to enemies under a quarter of their HP.", { t: "finisher", mult: 2 }),
  t("staff_sage", 2, "weather_the_gale", "Weather the Gale", "While under a third of your HP, you start each turn Guarded.", { t: "low_hp_guard" }),
  // Lighthouse Warden
  t("sre_warden", 1, "steady_light", "Steady Light", "Grow back 1 HP at the start of each turn.", { t: "regen", amount: 1 }),
  t("sre_warden", 1, "hold_fast", "Hold Fast", "Once a fight, a blow that would put you down leaves you on 1 HP.", { t: "last_stand" }),
  t("sre_warden", 2, "lamp_oil", "Lamp Oil", "+3 damage against Holed enemies.", { t: "vs_effect", effect: "exposed", bonus: 3 }),
  t("sre_warden", 2, "keepers_watch", "Keeper's Watch", "While under a third of your HP, you start each turn Guarded.", { t: "low_hp_guard" }),
  // Wreck Warlock
  t("data_warlock", 1, "drowned_debts", "Drowned Debts", "Heal 3 HP whenever an enemy goes down.", { t: "on_kill_heal", amount: 3 }),
  t("data_warlock", 1, "shipworm", "Shipworm", "+2 damage against Bleeding enemies.", { t: "vs_effect", effect: "bleeding", bonus: 2 }),
  t("data_warlock", 2, "salt_the_wound", "Salt the Wound", "+2 damage for each different debuff on the target.", { t: "per_debuff", bonus: 2 }),
  t("data_warlock", 2, "cursed_tide", "Cursed Tide", "Bleeding and Fouled that you cause last a turn longer.", { t: "longer", effects: ["bleeding", "glitched"], turns: 1 }),
];

export const TRAIT_BY_ID: Record<string, TraitDef> = Object.fromEntries(TRAITS.map((d) => [d.id, d]));

/** A class's traits, tier by tier. */
export function traitsFor(classId: string): TraitDef[] {
  return TRAITS.filter((d) => d.classId === classId);
}

/** The rules a hero's picked traits add up to. Unknown ids are ignored. */
export function traitRules(ids: readonly string[] | undefined): TraitRule[] {
  return (ids ?? []).map((id) => TRAIT_BY_ID[id]?.rule).filter((r): r is TraitRule => !!r);
}

/** Tiers the hero has reached but not picked a trait for yet. */
export function pendingTraitTiers(classId: string, level: number, picked: readonly string[]): (1 | 2)[] {
  const out: (1 | 2)[] = [];
  TRAIT_LEVELS.forEach((at, i) => {
    const tier = (i + 1) as 1 | 2;
    if (level < at) return;
    if (!picked.some((id) => TRAIT_BY_ID[id]?.classId === classId && TRAIT_BY_ID[id]?.tier === tier)) out.push(tier);
  });
  return out;
}

/** Why a hero can't pick `id` now, or null if they can. Picks are for keeps: one per tier. */
export function traitPickError(classId: string, level: number, picked: readonly string[], id: string): string | null {
  const def = TRAIT_BY_ID[id];
  if (!def || def.classId !== classId) return "That isn't one of your class's traits.";
  if (level < TRAIT_LEVELS[def.tier - 1]) return `That opens at level ${TRAIT_LEVELS[def.tier - 1]}.`;
  if (!pendingTraitTiers(classId, level, picked).includes(def.tier)) return "You've already picked that tier's trait.";
  return null;
}

/** Parse a stored traits list, dropping anything malformed. */
export function parseTraits(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!TRAIT_BY_ID[x]) : [];
  } catch {
    return [];
  }
}
