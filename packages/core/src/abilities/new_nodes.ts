// New talent-tree nodes introduced by the abilities rework. PR #167 shipped
// the framework + 8 representative abilities (one active per class) to prove
// the end-to-end loop. This file extends the roster toward the plan's full
// 41-node target with abilities that can be implemented using the current
// AbilityEffect primitives.
//
// Abilities requiring new engine work (e.g. cooldown reset, buff strip,
// position swap, HP-cost casting, scaling-passive triggers) are deferred to
// a follow-up "engine primitives" PR and listed in the design doc.
//
// All nodes ship at max_rank: 1 today. Adding R2/R3 later: bump max_rank
// in the per-class registry below + branch on ctx.rank inside execute().

import type { AbilityDef, FighterSnapshot, MonsterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";
import type { ClassId, TalentNodeDef } from "./types";

// ────────────────────────────────────────────────────────────────────────
// DevOps Mage
// ────────────────────────────────────────────────────────────────────────

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

const cdnSurge: AbilityDef = {
  kind: "active",
  id: "cdn_surge",
  name: "CDN Surge",
  blurb: "Push a lightning surge through the edge — strikes every enemy within 2 hexes for mag×d4 lightning damage.",
  icon: "arcing-bolt",
  mana_cost: 0,
  cooldown_turns: 4,
  routing: "aoe_damage",
  target: "all_enemies",
  range_tiles: 5,
  aoe_radius_tiles: 2,
  execute(ctx) {
    const mag = Math.max(1, ctx.caster.magic_mod);
    const amount = rollSum(ctx.roll, mag, 4);
    const formula = `${mag}d4`;
    return ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "lightning" }));
  },
};

const canaryDeploy: AbilityDef = {
  kind: "active",
  id: "canary_deploy",
  name: "Canary Deploy",
  blurb: "Ship the small risky change first — single-target fire strike for 1d6 + magic damage.",
  icon: "fire",
  mana_cost: 1,
  routing: "damage",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const amount = ctx.roll(6) + mag;
    return [fx.damage(monster.id, amount, `1d6+${mag}m`, { damageType: "fire" })];
  },
};

// ────────────────────────────────────────────────────────────────────────
// QA Paladin
// ────────────────────────────────────────────────────────────────────────

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

const codeReview: AbilityDef = {
  kind: "active",
  id: "code_review",
  name: "Code Review",
  blurb: "Audit an ally's state and clean up — strips every debuff from the target and restores 1d4 + vit HP.",
  icon: "scroll-unfurled",
  mana_cost: 2,
  cooldown_turns: 2,
  routing: "utility",
  target: "single_ally",
  range_tiles: 3,
  execute(ctx) {
    const target = ctx.target as FighterSnapshot;
    const vit = (ctx.caster as FighterSnapshot & { stats?: { vit: number } }).stats?.vit ?? 5;
    const heal = ctx.roll(4) + vit;
    return [fx.cleanseSingleAlly(target.id), fx.heal(target.id, heal)];
  },
};

const staticAnalysis: AbilityDef = {
  kind: "passive",
  id: "static_analysis",
  name: "Static Analysis",
  blurb: "When you're alone in the call stack, you focus — gain +1 AC barkskin at the start of every turn you have no adjacent allies.",
  icon: "convergence-target",
  trigger: "on_action",
  once_per_fight: false,
  execute(ctx) {
    // Without hex positions we can't truly measure adjacency from execute();
    // approximate with "no living allies besides self" — a strict version of
    // the design that fires when the Paladin is the last one standing.
    const livingAllies = ctx.party.filter((p) => p.id !== ctx.caster.id);
    if (livingAllies.length > 0) return [];
    return [fx.barkskin(ctx.caster.id, 1, 1)];
  },
};

const defensiveProgramming: AbilityDef = {
  kind: "passive",
  id: "defensive_programming",
  name: "Defensive Programming",
  blurb: "Tighten the guards when things go wrong — gain +2 AC barkskin at the start of every turn while below 50% HP.",
  icon: "round-shield",
  trigger: "on_action",
  once_per_fight: false,
  execute(ctx) {
    if (ctx.caster.hp * 2 > ctx.caster.max_hp) return [];
    return [fx.barkskin(ctx.caster.id, 2, 1)];
  },
};

const bisect: AbilityDef = {
  kind: "active",
  id: "bisect",
  name: "Bisect",
  blurb: "Split the failure space in half — sweep all adjacent enemies for 1d8 + attack and entangle them for 2 rounds.",
  icon: "battle-axe",
  mana_cost: 0,
  cooldown_turns: 3,
  routing: "aoe_damage",
  target: "all_enemies",
  range_tiles: 1,
  aoe_radius_tiles: 1,
  execute(ctx) {
    const atk = ctx.caster.attack_mod;
    const amount = ctx.roll(8) + atk;
    const formula = `1d8+${atk}a`;
    const damageEffects = ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "physical" }));
    const entangleEffects = ctx.monsters.map((m) => fx.entangleMonster(m.id, 2));
    return [...damageEffects, ...entangleEffects];
  },
};

// ────────────────────────────────────────────────────────────────────────
// Backend Druid
// ────────────────────────────────────────────────────────────────────────

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

const mycelialWeb: AbilityDef = {
  kind: "active",
  id: "mycelial_web",
  name: "Mycelial Web",
  blurb: "Lash every enemy in a 2-hex bloom for 2d6 + magic damage and root them for 1 round.",
  icon: "grass",
  mana_cost: 3,
  cooldown_turns: 4,
  routing: "utility",
  target: "all_enemies",
  range_tiles: 3,
  aoe_radius_tiles: 2,
  execute(ctx) {
    const mag = ctx.caster.magic_mod;
    const amount = rollSum(ctx.roll, 2, 6) + mag;
    const formula = `2d6+${mag}m`;
    const damageEffects = ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "magic" }));
    // Root one random enemy in addition to AoE damage; entangle reuses the
    // existing Druid Deadlock primitive.
    const rooted = ctx.monsters.length > 0
      ? [fx.entangleMonster(ctx.monsters[Math.floor((ctx.roll(20) - 1) / 20 * ctx.monsters.length)].id, 1)]
      : [];
    return [...damageEffects, ...rooted];
  },
};

const compostHeap: AbilityDef = {
  kind: "active",
  id: "compost_heap",
  name: "Compost Heap",
  blurb: "Seed a regen patch — every ally regenerates magic HP per turn for 3 rounds.",
  icon: "health-increase",
  mana_cost: 0,
  cooldown_turns: 4,
  routing: "utility",
  target: "all_allies",
  execute(ctx) {
    const mag = Math.max(1, ctx.caster.magic_mod);
    return ctx.party.map((p) => fx.fighterRegen(p.id, mag, 3));
  },
};

const deepRoots: AbilityDef = {
  kind: "passive",
  id: "deep_roots",
  name: "Deep Roots",
  blurb: "Roots run deep before the fight starts — gain +2 AC barkskin for the entire combat.",
  icon: "tree-roots",
  trigger: "on_action",
  once_per_fight: true,
  execute(ctx) {
    return [fx.barkskin(ctx.caster.id, 2, 99)];
  },
};

const cronJob: AbilityDef = {
  kind: "passive",
  id: "cron_job",
  name: "Cron Job",
  blurb: "Schedules a steady patch — regenerate 1 HP at the start of every turn.",
  icon: "cycle",
  trigger: "on_action",
  once_per_fight: false,
  execute(ctx) {
    return [fx.heal(ctx.caster.id, 1)];
  },
};

// ────────────────────────────────────────────────────────────────────────
// Frontend Bard
// ────────────────────────────────────────────────────────────────────────

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

const encore: AbilityDef = {
  kind: "active",
  id: "encore",
  name: "Encore",
  blurb: "Call for one more take — wipes every cooldown on the targeted ally so they can immediately re-cast.",
  icon: "musical-notes",
  mana_cost: 0,
  cooldown_turns: 5,
  routing: "utility",
  target: "single_ally",
  range_tiles: 3,
  execute(ctx) {
    const target = ctx.target as { id: string } | undefined;
    if (!target) return [];
    return [fx.resetCooldowns(target.id)];
  },
};

const unsubscribeFromAll: AbilityDef = {
  kind: "active",
  id: "unsubscribe_from_all",
  name: "Unsubscribe from All",
  blurb: "Strip every positive buff from the enemy field at once — regen, barkskin, animal_form, empowered. The party gets a clean slate to push.",
  icon: "trash-can",
  mana_cost: 0,
  cooldown_turns: 6,
  routing: "utility",
  target: "all_enemies",
  execute() {
    return [fx.dispelEnemyBuffs()];
  },
};

const discordNotification: AbilityDef = {
  kind: "active",
  id: "discord_notification",
  name: "Discord Notification",
  blurb: "A jarring ping locks the target up — 1d6 + magic damage and stun (30% break chance per turn).",
  icon: "sound-on",
  mana_cost: 2,
  cooldown_turns: 2,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const amount = ctx.roll(6) + mag;
    return [
      fx.damage(monster.id, amount, `1d6+${mag}m`, { damageType: "magic" }),
      fx.stunMonster(monster.id, 30, 50),
    ];
  },
};

// ────────────────────────────────────────────────────────────────────────
// Staff Sage
// ────────────────────────────────────────────────────────────────────────

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

// Time Dilation — re-designed from the original "AoE adds +1 to enemy
// cooldowns" because monsters in this engine don't have player-style
// cooldowns. The replacement still reads as "slow them down" — applies a
// 2-turn entangled debuff (-4 to-hit) to every enemy in a 1-hex blast
// around the picked target. Pure control, no damage.
const timeDilation: AbilityDef = {
  kind: "active",
  id: "time_dilation",
  name: "Time Dilation",
  blurb: "Stretch the clock around the target — every enemy in a 1-hex radius is entangled (-4 to-hit) for 2 rounds.",
  icon: "stopwatch",
  mana_cost: 0,
  cooldown_turns: 5,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 1,
  execute(ctx) {
    return ctx.monsters.map((m) => fx.entangleMonster(m.id, 2));
  },
};

const hailstorm: AbilityDef = {
  kind: "active",
  id: "hailstorm",
  name: "Hailstorm",
  blurb: "Drop a wall of icy hail — every enemy in a 2-hex blast takes magic×d4 ice damage, with a 15% freeze chance per target.",
  icon: "icicles-fence",
  mana_cost: 0,
  cooldown_turns: 5,
  routing: "utility",
  target: "all_enemies",
  range_tiles: 4,
  aoe_radius_tiles: 2,
  execute(ctx) {
    const mag = Math.max(1, ctx.caster.magic_mod);
    return ctx.monsters.map((m) =>
      fx.attackRollDamage(m.id, mag, rollSum(ctx.roll, mag, 4), `${mag}d4`, "ice", undefined, undefined, 15),
    );
  },
};

// ────────────────────────────────────────────────────────────────────────
// Refactor Rogue
// ────────────────────────────────────────────────────────────────────────

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

const smokeTest: AbilityDef = {
  kind: "active",
  id: "smoke_test",
  name: "Smoke Test",
  blurb: "Trip every alarm at once — vanish for 1 swing and pepper every nearby enemy with 1d4 + magic chip damage.",
  icon: "cloak-dagger",
  mana_cost: 0,
  cooldown_turns: 3,
  routing: "utility",
  target: "self",
  execute(ctx) {
    const mag = ctx.caster.magic_mod;
    const amount = ctx.roll(4) + mag;
    const formula = `1d4+${mag}m`;
    const damageEffects = ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "magic" }));
    return [fx.vanish(ctx.caster.id, 1), ...damageEffects];
  },
};

const silentMode: AbilityDef = {
  kind: "passive",
  id: "silent_mode",
  name: "Silent Mode",
  blurb: "When the logs are clean, the rogue is dangerous — gain +1 AC barkskin at the start of every turn while at full HP.",
  icon: "cloak-dagger",
  trigger: "on_action",
  once_per_fight: false,
  execute(ctx) {
    if (ctx.caster.hp < ctx.caster.max_hp) return [];
    return [fx.barkskin(ctx.caster.id, 1, 1)];
  },
};

// ────────────────────────────────────────────────────────────────────────
// SRE Warden
// ────────────────────────────────────────────────────────────────────────

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

const circuitBreaker: AbilityDef = {
  kind: "active",
  id: "circuit_breaker",
  name: "Circuit Breaker",
  blurb: "Trip the breaker — every ally gains 1d6 + vit shield, and the nearest enemy is entangled for 2 rounds.",
  icon: "energy-shield",
  mana_cost: 3,
  cooldown_turns: 4,
  routing: "utility",
  target: "all_allies",
  execute(ctx) {
    const vit = (ctx.caster as FighterSnapshot & { stats?: { vit: number } }).stats?.vit ?? 5;
    const shieldAmt = ctx.roll(6) + vit;
    const allyShields = ctx.party.map((p) => fx.shield(p.id, shieldAmt));
    const entangle = ctx.monsters.length > 0 ? [fx.entangleMonster(ctx.monsters[0].id, 2)] : [];
    return [...allyShields, ...entangle];
  },
};

const failover: AbilityDef = {
  kind: "active",
  id: "failover",
  name: "Failover",
  blurb: "Take an ally's slot in the rotation — swap hex positions with the targeted ally and absorb 8 shield for yourself.",
  icon: "cycle",
  mana_cost: 0,
  cooldown_turns: 4,
  routing: "utility",
  target: "single_ally",
  range_tiles: 2,
  execute(ctx) {
    const target = ctx.target as FighterSnapshot;
    if (target.id === ctx.caster.id) return [];
    return [
      fx.swapPositions(ctx.caster.id, target.id),
      fx.shield(ctx.caster.id, 8),
    ];
  },
};

const capacityPlanning: AbilityDef = {
  kind: "passive",
  id: "capacity_planning",
  name: "Capacity Planning",
  blurb: "Provision headroom for the team — gain 2 shield per living ally at the start of every turn.",
  icon: "energy-shield",
  trigger: "on_action",
  once_per_fight: false,
  execute(ctx) {
    const livingAllies = ctx.party.filter((p) => p.hp > 0 && p.id !== ctx.caster.id).length;
    if (livingAllies <= 0) return [];
    return [fx.shield(ctx.caster.id, livingAllies * 2)];
  },
};

// ────────────────────────────────────────────────────────────────────────
// Data Warlock
// ────────────────────────────────────────────────────────────────────────

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

const dropTable: AbilityDef = {
  kind: "active",
  id: "drop_table",
  name: "Drop Table",
  blurb: "Pay 5 HP — no mana — to detonate a magic AoE on every enemy in a 1-hex blast for 2d6 + magic damage. Caster floors at 1 HP.",
  icon: "blood",
  mana_cost: 0,
  cooldown_turns: 4,
  routing: "utility",
  target: "all_enemies",
  range_tiles: 4,
  aoe_radius_tiles: 1,
  execute(ctx) {
    const mag = ctx.caster.magic_mod;
    const amount = rollSum(ctx.roll, 2, 6) + mag;
    const formula = `2d6+${mag}m`;
    const damage = ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "magic" }));
    return [fx.deductCasterHp(ctx.caster.id, 5), ...damage];
  },
};

const staleCache: AbilityDef = {
  kind: "passive",
  id: "stale_cache",
  name: "Stale Cache",
  blurb: "Every nearby kill leaks something back — restore 1 mana whenever an enemy dies within 2 hexes of you.",
  icon: "database",
  trigger: "on_kill",
  once_per_fight: false,
  nearby_radius_tiles: 2,
  execute(ctx) {
    return [fx.restoreMana(ctx.caster.id, 1)];
  },
};

const garbageCollection: AbilityDef = {
  kind: "passive",
  id: "garbage_collection",
  name: "Garbage Collection",
  blurb: "Reap the dead allocations — restore 3 HP whenever any enemy dies on the field.",
  icon: "trash-can",
  trigger: "on_kill",
  once_per_fight: false,
  execute(ctx) {
    return [fx.heal(ctx.caster.id, 3)];
  },
};

const stackTrace: AbilityDef = {
  kind: "active",
  id: "stack_trace",
  name: "Stack Trace",
  blurb: "Unwind the failure path — magic strike for magic + 2 extra damage per DoT stack already on the target.",
  icon: "stack",
  mana_cost: 0,
  cooldown_turns: 3,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const dotStacks = (monster.effects ?? [])
      .filter((e) => ["bleeding", "poisoned", "burning"].includes(e.type))
      .reduce((sum, e) => sum + e.magnitude, 0);
    const amount = Math.max(1, mag) + dotStacks * 2;
    return [fx.damage(monster.id, amount, `${mag}m+${dotStacks}×2dot`, { damageType: "magic" })];
  },
};

// ────────────────────────────────────────────────────────────────────────
// Registry — per-class TalentNodeDef list
// ────────────────────────────────────────────────────────────────────────

function activeNode(classId: ClassId, ability: AbilityDef, category: TalentNodeDef["category"]): TalentNodeDef {
  return {
    id: ability.id,
    class_id: classId,
    category,
    max_rank: 1,
    level_req_per_rank: [1],
    point_cost_per_rank: [1],
    ability,
  };
}

const NEW_NODES_BY_CLASS: Record<ClassId, TalentNodeDef[]> = {
  devops_mage: [
    activeNode("devops_mage", rollingRestart, "damage"),
    activeNode("devops_mage", cdnSurge, "damage"),
    activeNode("devops_mage", canaryDeploy, "damage"),
  ],
  qa_paladin: [
    activeNode("qa_paladin", sanityCheck, "damage"),
    activeNode("qa_paladin", bisect, "damage"),
    activeNode("qa_paladin", codeReview, "support"),
    activeNode("qa_paladin", staticAnalysis, "defense"),
    activeNode("qa_paladin", defensiveProgramming, "defense"),
  ],
  backend_druid: [
    activeNode("backend_druid", pruning, "damage"),
    activeNode("backend_druid", mycelialWeb, "damage"),
    activeNode("backend_druid", compostHeap, "support"),
    activeNode("backend_druid", deepRoots, "defense"),
    activeNode("backend_druid", cronJob, "support"),
  ],
  frontend_bard: [
    activeNode("frontend_bard", standupMeeting, "support"),
    activeNode("frontend_bard", discordNotification, "control"),
    activeNode("frontend_bard", encore, "utility"),
    activeNode("frontend_bard", unsubscribeFromAll, "utility"),
  ],
  staff_sage: [
    activeNode("staff_sage", frostBolt, "control"),
    activeNode("staff_sage", hailstorm, "damage"),
    activeNode("staff_sage", timeDilation, "control"),
  ],
  refactor_rogue: [
    activeNode("refactor_rogue", codeAudit, "control"),
    activeNode("refactor_rogue", smokeTest, "utility"),
    activeNode("refactor_rogue", silentMode, "defense"),
  ],
  sre_warden: [
    activeNode("sre_warden", postmortem, "damage"),
    activeNode("sre_warden", circuitBreaker, "defense"),
    activeNode("sre_warden", failover, "utility"),
    activeNode("sre_warden", capacityPlanning, "defense"),
  ],
  data_warlock: [
    activeNode("data_warlock", indexScan, "damage"),
    activeNode("data_warlock", stackTrace, "damage"),
    activeNode("data_warlock", dropTable, "damage"),
    activeNode("data_warlock", staleCache, "support"),
    activeNode("data_warlock", garbageCollection, "support"),
  ],
};

export function newNodesForClass(classId: ClassId): TalentNodeDef[] {
  return NEW_NODES_BY_CLASS[classId] ?? [];
}

export const ALL_NEW_NODES: TalentNodeDef[] = Object.values(NEW_NODES_BY_CLASS).flat();

export const NEW_ABILITY_DEFS: AbilityDef[] = [
  rollingRestart, cdnSurge, canaryDeploy,
  sanityCheck, bisect, codeReview, staticAnalysis, defensiveProgramming,
  pruning, mycelialWeb, compostHeap, deepRoots, cronJob,
  standupMeeting, discordNotification, encore, unsubscribeFromAll,
  frostBolt, hailstorm, timeDilation,
  codeAudit, smokeTest, silentMode,
  postmortem, circuitBreaker, failover, capacityPlanning,
  indexScan, stackTrace, dropTable, staleCache, garbageCollection,
];
