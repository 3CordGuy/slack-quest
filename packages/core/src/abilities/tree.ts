// Talent tree registry — wraps the per-class AbilityDef[] arrays with talent
// metadata (category, level/cost per rank, prereqs). The registry is the single
// source of truth for the inventory UI's Abilities tab and for server-side
// validation of buy/equip endpoints.
//
// v1 ships every existing class ability at max_rank: 1 so behavior is
// unchanged. New nodes (per plan) live in `new_nodes.ts` and are merged in.
// Future PRs bump max_rank on specific nodes + add rank-aware branches in the
// underlying ability execute() functions.

import type { AbilityDef } from "../abilities";
import {
  bardAbilities,
  druidAbilities,
  mageAbilities,
  paladinAbilities,
  rogueAbilities,
  sageAbilities,
  wardenAbilities,
  warlockAbilities,
} from "./index";
import { newNodesForClass } from "./new_nodes";
import type { ClassId, TalentCategory, TalentNodeDef } from "./types";

// Hand-curated category assignments for the existing class kits. Drives the
// Abilities tab sub-filters (Damage / Control / Support / Defense / Utility).
const EXISTING_CATEGORY: Record<string, TalentCategory> = {
  // Mage
  fireball: "damage",
  containerize: "control",
  lightning_bolt: "damage",
  mage_armor: "defense",
  mana_font: "support",
  // Paladin
  holy_rage: "damage",
  shield_of_faith: "defense",
  lay_on_hands: "support",
  smite: "damage",
  protect: "defense",
  // Druid
  primal_strikes: "damage",
  regeneration: "support",
  animal_form: "support",
  wildgrowth: "control",
  barkskin: "defense",
  // Bard
  crescendo: "damage",
  verse: "utility",
  battle_hymn: "support",
  serenade: "support",
  bardic_aura: "support",
  // Sage
  foretell: "support",
  ray_of_frost: "control",
  blizzard: "damage",
  good_fortune: "support",
  ill_omen: "damage",
  // Rogue
  lethal_strikes: "damage",
  vanish: "utility",
  envenom_weapon: "damage",
  backstab: "damage",
  debilitate: "control",
  // Warden
  bulwark_strike: "damage",
  taunt: "defense",
  brace: "defense",
  thorns: "defense",
  armor_up: "defense",
  resilient: "defense",
  // Warlock
  sinister_queries: "damage",
  leech_life: "damage",
  hex: "control",
  summon_imp: "utility",
  forbidden_sql: "damage",
};

// Per-ability rank specs for the existing class kit. Abilities that need
// R2/R3 progression list their max_rank + per-rank level/cost gates here.
// Abilities not in the map fall back to the single-rank default (R1 only,
// 1 point, level 1) so adding ranks is purely additive — existing kit
// abilities without an entry behave exactly as they did pre-R2/R3.
//
// Default progression for rankable nodes is { max_rank: 3, level_req: [1, 6, 12],
// point_cost: [1, 2, 3] } unless an ability needs a steeper level gate (e.g.
// signature kit nodes may push R3 to L15).
const RANK_SPEC: Record<string, { max_rank: 1 | 2 | 3; level_req_per_rank: number[]; point_cost_per_rank: number[] }> = {
  // ── DevOps Mage kit ──
  fireball: { max_rank: 3, level_req_per_rank: [1, 6, 12], point_cost_per_rank: [1, 2, 3] },
  containerize: { max_rank: 3, level_req_per_rank: [1, 6, 12], point_cost_per_rank: [1, 2, 3] },
  lightning_bolt: { max_rank: 3, level_req_per_rank: [1, 6, 12], point_cost_per_rank: [1, 2, 3] },
  mage_armor: { max_rank: 3, level_req_per_rank: [1, 6, 12], point_cost_per_rank: [1, 2, 3] },
  // mana_font deliberately omitted — its regen logic lives in combat_machine
  // (applyManaFont), not execute(). Plumbing kit_ranks through CombatFighter
  // so the machine can read rank is a follow-up; for now Mana Font stays R1.
  // ── QA Paladin kit ──
  shield_of_faith: { max_rank: 3, level_req_per_rank: [1, 6, 12], point_cost_per_rank: [1, 2, 3] },
  lay_on_hands: { max_rank: 3, level_req_per_rank: [1, 6, 12], point_cost_per_rank: [1, 2, 3] },
  smite: { max_rank: 3, level_req_per_rank: [1, 6, 12], point_cost_per_rank: [1, 2, 3] },
  protect: { max_rank: 3, level_req_per_rank: [1, 6, 12], point_cost_per_rank: [1, 2, 3] },
  // holy_rage deliberately omitted — its damage buildup is a passive trigger
  // handled inline by the combat machine (on_ally_hit accumulator), not
  // execute(). Same talent_ranks plumbing follow-up as observability/failsafe;
  // for now Regression Rage stays R1.
};

const DEFAULT_RANKS: { max_rank: 1; level_req_per_rank: number[]; point_cost_per_rank: number[] } = {
  max_rank: 1,
  level_req_per_rank: [1],
  point_cost_per_rank: [1],
};

function wrapExisting(classId: ClassId, ability: AbilityDef): TalentNodeDef {
  const ranks = RANK_SPEC[ability.id] ?? DEFAULT_RANKS;
  return {
    id: ability.id,
    class_id: classId,
    category: EXISTING_CATEGORY[ability.id] ?? "utility",
    max_rank: ranks.max_rank,
    level_req_per_rank: ranks.level_req_per_rank,
    point_cost_per_rank: ranks.point_cost_per_rank,
    ability,
  };
}

function buildClassNodes(classId: ClassId, existing: AbilityDef[]): TalentNodeDef[] {
  return [
    ...existing.map((a) => wrapExisting(classId, a)),
    ...newNodesForClass(classId),
  ];
}

export const TALENT_NODES_BY_CLASS: Record<ClassId, TalentNodeDef[]> = {
  devops_mage: buildClassNodes("devops_mage", mageAbilities),
  qa_paladin: buildClassNodes("qa_paladin", paladinAbilities),
  backend_druid: buildClassNodes("backend_druid", druidAbilities),
  frontend_bard: buildClassNodes("frontend_bard", bardAbilities),
  staff_sage: buildClassNodes("staff_sage", sageAbilities),
  refactor_rogue: buildClassNodes("refactor_rogue", rogueAbilities),
  sre_warden: buildClassNodes("sre_warden", wardenAbilities),
  data_warlock: buildClassNodes("data_warlock", warlockAbilities),
};

export const ALL_TALENT_NODES: TalentNodeDef[] = Object.values(TALENT_NODES_BY_CLASS).flat();

export function nodesForClass(classId: ClassId): TalentNodeDef[] {
  return TALENT_NODES_BY_CLASS[classId] ?? [];
}

const NODE_BY_ID: Map<string, TalentNodeDef> = new Map(
  ALL_TALENT_NODES.map((n) => [n.id, n]),
);

export function findNode(id: string): TalentNodeDef | undefined {
  return NODE_BY_ID.get(id);
}

// Re-uses the canonical class-name → id mapping from stats.ts and narrows
// the string to our ClassId union. Returns undefined if the class isn't one
// of the eight talent-tree-registered classes.
import { classIdFromName as canonicalClassId } from "../stats";

const VALID_CLASS_IDS = new Set<string>(Object.keys(TALENT_NODES_BY_CLASS));

export function classIdForTree(className: string): ClassId | undefined {
  const id = canonicalClassId(className);
  return VALID_CLASS_IDS.has(id) ? (id as ClassId) : undefined;
}
