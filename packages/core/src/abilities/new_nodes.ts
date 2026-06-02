// New talent-tree nodes introduced by the abilities rework. Each class gets
// one representative new active in v1 to validate the end-to-end loop
// (buy → equip → cast → rank up). The remaining nodes in the plan (Bisect,
// CDN Surge, Compost Heap, Encore, Hailstorm, etc.) land in follow-up PRs
// per the design doc.
//
// All v1 new nodes ship as max_rank: 1 with level_req: [1], cost: [1].
// Adding R2/R3 later: bump max_rank in the node entry below + branch on
// ctx.rank inside the ability's execute().

import type { AbilityDef, MonsterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";
import type { ClassId, TalentNodeDef } from "./types";

// ---- Per-class new ability defs ----

const rollingRestart: AbilityDef = {
  kind: "active",
  id: "rolling_restart",
  name: "Rolling Restart",
  blurb: "Cycle the target out of rotation — deals mag×d6 magic damage to a single enemy.",
  icon: "cycle",
  mana_cost: 2,
  routing: "damage",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const mag = Math.max(1, ctx.caster.magic_mod);
    const amount = rollSum(ctx.roll, mag, 6);
    return [fx.damage(monster.id, amount, `${mag}d6`, { damageType: "magic" })];
  },
};

const sanityCheck: AbilityDef = {
  kind: "active",
  id: "sanity_check",
  name: "Sanity Check",
  blurb: "Verify the contract from a safe distance — ranged physical strike for 1d8 + attack.",
  icon: "magnifying-glass",
  mana_cost: 1,
  routing: "damage",
  target: "single_enemy",
  range_tiles: 2,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const atk = ctx.caster.attack_mod;
    const amount = ctx.roll(8) + atk;
    return [fx.damage(monster.id, amount, `1d8+${atk}a`, { damageType: "physical" })];
  },
};

const pruning: AbilityDef = {
  kind: "active",
  id: "pruning",
  name: "Pruning",
  blurb: "Cut back the dead branches — melee strike for 1d6 + attack and applies 3 bleed stacks.",
  icon: "axe-swing",
  mana_cost: 1,
  routing: "damage",
  target: "single_enemy",
  range_tiles: 1,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const atk = ctx.caster.attack_mod;
    const amount = ctx.roll(6) + atk;
    return [
      fx.damage(monster.id, amount, `1d6+${atk}a`, { damageType: "physical" }),
      fx.bleed(monster.id, 3, 2),
    ];
  },
};

const standupMeeting: AbilityDef = {
  kind: "active",
  id: "standup_meeting",
  name: "Standup Meeting",
  blurb: "Sync the team — every ally rolls their next 2 attacks with advantage.",
  icon: "conversation",
  mana_cost: 2,
  cooldown_turns: 3,
  routing: "utility",
  target: "all_allies",
  execute(ctx) {
    return ctx.party.map((m) => fx.encourage(m.id, 2));
  },
};

const frostBolt: AbilityDef = {
  kind: "active",
  id: "frost_bolt",
  name: "Frost Bolt",
  blurb: "Lob a hardened ice shard — mag×d4 ice damage with 25% chance to freeze.",
  icon: "frozen-arrow",
  mana_cost: 1,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const amount = rollSum(ctx.roll, Math.max(1, mag), 4);
    return [fx.attackRollDamage(monster.id, mag, amount, `${Math.max(1, mag)}d4`, "ice", undefined, undefined, 25)];
  },
};

const codeAudit: AbilityDef = {
  kind: "active",
  id: "code_audit",
  name: "Code Audit",
  blurb: "Trace every call path — deals 1d6 + magic damage and hexes the target for 6 of its turns.",
  icon: "magnifying-glass",
  mana_cost: 2,
  cooldown_turns: 3,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 3,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const amount = ctx.roll(6) + mag;
    return [
      fx.damage(monster.id, amount, `1d6+${mag}m`, { damageType: "magic" }),
      fx.hexMonster(monster.id, 6),
    ];
  },
};

const postmortem: AbilityDef = {
  kind: "active",
  id: "postmortem",
  name: "Postmortem",
  blurb: "Document every failure — single-target physical strike for 1d8 + attack + 2 bonus dmg per debuff on the target.",
  icon: "tombstone",
  mana_cost: 1,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 1,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const atk = ctx.caster.attack_mod;
    const debuffCount = (monster.effects ?? []).filter((e) =>
      ["bleeding", "poisoned", "burning", "stunned", "hexed", "entangled", "shocked", "frozen"].includes(e.type),
    ).length;
    const amount = ctx.roll(8) + atk + debuffCount * 2;
    return [fx.damage(monster.id, amount, `1d8+${atk}a+${debuffCount}×2dbf`, { damageType: "physical" })];
  },
};

const indexScan: AbilityDef = {
  kind: "active",
  id: "index_scan",
  name: "Index Scan",
  blurb: "Walk every row of the target — 1d6 + magic damage and applies 3 poison stacks.",
  icon: "magnifying-glass",
  mana_cost: 2,
  routing: "damage",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const amount = ctx.roll(6) + mag;
    return [
      fx.damage(monster.id, amount, `1d6+${mag}m`, { damageType: "magic" }),
      fx.poison(monster.id, 3, 3),
    ];
  },
};

// ---- Class → new node list ----

const NEW_NODES_BY_CLASS: Record<ClassId, TalentNodeDef[]> = {
  devops_mage: [
    {
      id: "rolling_restart",
      class_id: "devops_mage",
      category: "damage",
      max_rank: 1,
      level_req_per_rank: [1],
      point_cost_per_rank: [1],
      ability: rollingRestart,
    },
  ],
  qa_paladin: [
    {
      id: "sanity_check",
      class_id: "qa_paladin",
      category: "damage",
      max_rank: 1,
      level_req_per_rank: [1],
      point_cost_per_rank: [1],
      ability: sanityCheck,
    },
  ],
  backend_druid: [
    {
      id: "pruning",
      class_id: "backend_druid",
      category: "damage",
      max_rank: 1,
      level_req_per_rank: [1],
      point_cost_per_rank: [1],
      ability: pruning,
    },
  ],
  frontend_bard: [
    {
      id: "standup_meeting",
      class_id: "frontend_bard",
      category: "support",
      max_rank: 1,
      level_req_per_rank: [1],
      point_cost_per_rank: [1],
      ability: standupMeeting,
    },
  ],
  staff_sage: [
    {
      id: "frost_bolt",
      class_id: "staff_sage",
      category: "control",
      max_rank: 1,
      level_req_per_rank: [1],
      point_cost_per_rank: [1],
      ability: frostBolt,
    },
  ],
  refactor_rogue: [
    {
      id: "code_audit",
      class_id: "refactor_rogue",
      category: "control",
      max_rank: 1,
      level_req_per_rank: [1],
      point_cost_per_rank: [1],
      ability: codeAudit,
    },
  ],
  sre_warden: [
    {
      id: "postmortem",
      class_id: "sre_warden",
      category: "damage",
      max_rank: 1,
      level_req_per_rank: [1],
      point_cost_per_rank: [1],
      ability: postmortem,
    },
  ],
  data_warlock: [
    {
      id: "index_scan",
      class_id: "data_warlock",
      category: "damage",
      max_rank: 1,
      level_req_per_rank: [1],
      point_cost_per_rank: [1],
      ability: indexScan,
    },
  ],
};

export function newNodesForClass(classId: ClassId): TalentNodeDef[] {
  return NEW_NODES_BY_CLASS[classId] ?? [];
}

export const ALL_NEW_NODES: TalentNodeDef[] = Object.values(NEW_NODES_BY_CLASS).flat();

// Re-export the ability defs for any callers that need to iterate or test them.
export const NEW_ABILITY_DEFS: AbilityDef[] = [
  rollingRestart,
  sanityCheck,
  pruning,
  standupMeeting,
  frostBolt,
  codeAudit,
  postmortem,
  indexScan,
];

