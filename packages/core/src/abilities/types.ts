import type { AbilityDef } from "../abilities";

export type TalentCategory =
  | "damage"
  | "control"
  | "support"
  | "defense"
  | "utility";

export type ClassId =
  | "devops_mage"
  | "qa_paladin"
  | "backend_druid"
  | "frontend_bard"
  | "staff_sage"
  | "refactor_rogue"
  | "sre_warden"
  | "data_warlock";

export interface TalentNodeDef {
  id: string;
  class_id: ClassId;
  category: TalentCategory;
  max_rank: 1 | 2 | 3;
  level_req_per_rank: number[];
  point_cost_per_rank: number[];
  prereq?: { node_id: string; min_rank: number }[];
  ability: AbilityDef;
}

export interface AbilityLoadout {
  active: (string | null)[];
  passive: (string | null)[];
}

export const MAX_ACTIVE_SLOTS = 4;

export function passiveSlotsForLevel(level: number): number {
  if (level >= 30) return 3;
  if (level >= 10) return 2;
  return 1;
}

export function emptyLoadoutForLevel(level: number): AbilityLoadout {
  return {
    active: Array.from({ length: MAX_ACTIVE_SLOTS }, () => null),
    passive: Array.from({ length: passiveSlotsForLevel(level) }, () => null),
  };
}

export function totalPointsCost(node: TalentNodeDef, targetRank: number): number {
  let sum = 0;
  for (let r = 1; r <= targetRank; r++) sum += node.point_cost_per_rank[r - 1] ?? 0;
  return sum;
}

export function levelReqForRank(node: TalentNodeDef, rank: number): number {
  return node.level_req_per_rank[rank - 1] ?? 1;
}

export function pointCostForRank(node: TalentNodeDef, rank: number): number {
  return node.point_cost_per_rank[rank - 1] ?? 1;
}
