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
import { GRID_DEFAULT, hexBlast, hexLine, hexRing, type HexPos } from "../hex";
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
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const mag = Math.max(1, ctx.caster.magic_mod);
    const baseRoll = rollSum(ctx.roll, mag, 6);
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `${mag}d6×${mult}` : `${mag}d6`;
    return [fx.damage(monster.id, amount, formula, { damageType: "magic" })];
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
    const rank = ctx.rank ?? 1;
    const mag = Math.max(1, ctx.caster.magic_mod);
    const baseRoll = rollSum(ctx.roll, mag, 4);
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `${mag}d4×${mult}` : `${mag}d4`;
    return ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "lightning" }));
  },
};

const failsafe: AbilityDef = {
  kind: "passive",
  id: "failsafe",
  name: "Failsafe",
  blurb: "Provision a kill switch — once per fight, the lethal blow that would down you leaves you at 1 HP instead.",
  icon: "bolt-shield",
  trigger: "always_on",
  once_per_fight: true,
  execute: () => [],
  // Guard is applied inline by the monster-attacks-fighter handler via
  // applyFailsafe(). Triggers once, then markPassiveUsed locks it for the
  // rest of the combat.
};

const observability: AbilityDef = {
  kind: "passive",
  id: "observability",
  name: "Observability",
  blurb: "Read the chaos on the field — every distinct debuff on the enemy team adds +1 damage to your strikes.",
  icon: "crystal-ball",
  trigger: "always_on",
  once_per_fight: false,
  execute: () => [],
  // Damage bonus is applied inline by handleDamageAbility +
  // the attack_roll_damage handler via observabilityBonus().
};

const canaryDeploy: AbilityDef = {
  kind: "active",
  id: "canary_deploy",
  name: "Canary Deploy",
  blurb: "Ship the small risky change first — single-target fire strike for 1d6 + magic damage.",
  icon: "firework-rocket",
  mana_cost: 1,
  routing: "damage",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const baseRoll = ctx.roll(6) + mag;
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `1d6+${mag}m×${mult}` : `1d6+${mag}m`;
    return [fx.damage(monster.id, amount, formula, { damageType: "fire" })];
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
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const atk = ctx.caster.attack_mod;
    const baseRoll = ctx.roll(8) + atk;
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `(1d8+${atk}a)×${mult}` : `1d8+${atk}a`;
    return [fx.damage(monster.id, amount, formula, { damageType: "physical" })];
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
    const rank = ctx.rank ?? 1;
    const target = ctx.target as FighterSnapshot;
    const vit = (ctx.caster as FighterSnapshot & { stats?: { vit: number } }).stats?.vit ?? 5;
    const baseHeal = ctx.roll(4) + vit;
    const mult = rank >= 3 ? 2 : rank >= 2 ? 1.5 : 1;
    const heal = Math.round(baseHeal * mult);
    return [fx.cleanseSingleAlly(target.id), fx.heal(target.id, heal)];
  },
};

const staticAnalysis: AbilityDef = {
  kind: "passive",
  id: "static_analysis",
  name: "Static Analysis",
  blurb: "When you're alone in the call stack, you focus — gain +1 AC barkskin at the start of every turn you have no adjacent allies.",
  icon: "umbrella",
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
  icon: "parachute",
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
    const rank = ctx.rank ?? 1;
    const atk = ctx.caster.attack_mod;
    const baseRoll = ctx.roll(8) + atk;
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `(1d8+${atk}a)×${mult}` : `1d8+${atk}a`;
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
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const atk = ctx.caster.attack_mod;
    // R1 ×1, R2 ×1.25, R3 ×1.5. Bleed-stack bump deferred — extra stacks shift
    // the ability identity toward a bleed-stacker rather than a strike.
    const baseRoll = ctx.roll(6) + atk;
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `1d6+${atk}a×${mult}` : `1d6+${atk}a`;
    return [
      fx.damage(monster.id, amount, formula, { damageType: "physical" }),
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
    const rank = ctx.rank ?? 1;
    const mag = ctx.caster.magic_mod;
    const baseRoll = rollSum(ctx.roll, 2, 6) + mag;
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `2d6+${mag}m×${mult}` : `2d6+${mag}m`;
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
  icon: "flower-twirl",
  mana_cost: 0,
  cooldown_turns: 4,
  routing: "utility",
  target: "all_allies",
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    // R1 mag/turn, R2 ×1.5 regen, R3 ×2 regen.
    const mag = Math.max(1, ctx.caster.magic_mod);
    const mult = rank >= 3 ? 2 : rank >= 2 ? 1.5 : 1;
    const amount = Math.max(1, Math.round(mag * mult));
    return ctx.party.map((p) => fx.fighterRegen(p.id, amount, 3));
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
    const rank = ctx.rank ?? 1;
    // R1 +2 AC, R2 +3 AC, R3 +4 AC. on_action passives still pass ctx.rank
    // through the engine, so we scale the barkskin bonus here.
    const bonus = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
    return [fx.barkskin(ctx.caster.id, bonus, 99)];
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
    const rank = ctx.rank ?? 1;
    // R1 1 HP/turn, R2 2 HP/turn, R3 3 HP/turn.
    const amount = rank >= 3 ? 3 : rank >= 2 ? 2 : 1;
    return [fx.heal(ctx.caster.id, amount)];
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
    const rank = ctx.rank ?? 1;
    // R1 2 charges, R2 3 charges, R3 4 charges.
    const charges = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
    return ctx.party.map((m) => fx.encourage(m.id, charges));
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
    const rank = ctx.rank ?? 1;
    const target = ctx.target as { id: string } | undefined;
    if (!target) return [];
    // R1 just resets cooldowns. R2 also restores 2 mana to the target.
    // R3 restores 3 mana to the target. Cooldown reset is binary; layering
    // mana restore is the cleanest scaling without new effect kinds.
    const effects = [fx.resetCooldowns(target.id)];
    if (rank >= 2) {
      const mana = rank >= 3 ? 3 : 2;
      effects.push(fx.restoreMana(target.id, mana));
    }
    return effects;
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
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    // R1 dispels enemy buffs. R2 also cleanses every ally's debuffs.
    // R3 same plus restore 1 mana to the bard.
    const effects = [fx.dispelEnemyBuffs()];
    if (rank >= 2) effects.push(fx.cleanseAllyDebuffs());
    if (rank >= 3) effects.push(fx.restoreMana(ctx.caster.id, 1));
    return effects;
  },
};

const a11yFirst: AbilityDef = {
  kind: "passive",
  id: "a11y_first",
  name: "A11y First",
  blurb: "Audit every interaction — gain +1 to your attack rolls and +1% dodge chance, always on.",
  icon: "swan-breeze",
  trigger: "always_on",
  once_per_fight: false,
  execute: () => [],
  // Bonuses are applied inline by the combat machine: +1 to hitTotal in the
  // attack_roll_damage handler and +1% to the AGI dodge threshold in the
  // monster-vs-fighter dodge check.
};

const earworm: AbilityDef = {
  kind: "passive",
  id: "earworm",
  name: "Earworm",
  blurb: "Every brilliant moment becomes a song — gain +1 mana whenever any party member lands a crit.",
  icon: "swirl-ring",
  trigger: "always_on",
  once_per_fight: false,
  execute: () => [],
  // Mana refund is applied inline by applyEarwormOnCrit() at every crit
  // resolution site: basic attack, handleDamageAbility, attack_roll_damage.
};

const discordNotification: AbilityDef = {
  kind: "active",
  id: "discord_notification",
  name: "Discord Notification",
  blurb: "A jarring ping locks the target up — 1d6 + magic damage and stun (30% break chance per turn).",
  icon: "lightning-storm",
  mana_cost: 2,
  cooldown_turns: 2,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const baseRoll = ctx.roll(6) + mag;
    // R1 ×1, R2 ×1.25, R3 ×1.5 on damage. Stun break% drops at higher
    // ranks → longer effective stun.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `(1d6+${mag}m)×${mult}` : `1d6+${mag}m`;
    const breakPct = rank >= 3 ? 10 : rank >= 2 ? 20 : 30;
    const bossBreakPct = rank >= 3 ? 30 : rank >= 2 ? 40 : 50;
    return [
      fx.damage(monster.id, amount, formula, { damageType: "magic" }),
      fx.stunMonster(monster.id, breakPct, bossBreakPct),
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
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const baseRoll = rollSum(ctx.roll, Math.max(1, mag), 4);
    // R1 ×1 dmg + 25% freeze, R2 ×1.25 dmg + 35% freeze, R3 ×1.5 dmg + 45% freeze.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const freezeChance = rank >= 3 ? 45 : rank >= 2 ? 35 : 25;
    const formula = rank > 1 ? `${Math.max(1, mag)}d4×${mult}` : `${Math.max(1, mag)}d4`;
    return [fx.attackRollDamage(monster.id, mag, amount, formula, "ice", undefined, undefined, freezeChance)];
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
    const rank = ctx.rank ?? 1;
    // R1 = 2 turns, R2 = 3 turns, R3 = 4 turns of entangle (-4 to-hit).
    const duration = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
    return ctx.monsters.map((m) => fx.entangleMonster(m.id, duration));
  },
};

const cacheWarmer: AbilityDef = {
  kind: "passive",
  id: "cache_warmer",
  name: "Cache Warmer",
  blurb: "Pressure compiles wisdom — your next ability cast after taking damage costs no mana.",
  icon: "fire",
  trigger: "always_on",
  once_per_fight: false,
  execute: () => [],
  // Priming is done inline by the monster-attacks-fighter damage path
  // (adds the sage to ability_state.cache_warmer_primed). The cast handler
  // zeroes mana_cost for primed casters and unprimes them after.
};

const memoization: AbilityDef = {
  kind: "passive",
  id: "memoization",
  name: "Memoization",
  blurb: "Cache the answer once — the first cast of each ability this combat costs no mana.",
  icon: "fluffy-trefoil",
  trigger: "always_on",
  once_per_fight: false,
  execute: () => [],
  // Mana refund is applied inline by the ability cast handler — when the
  // caster has this passive and the ability id isn't in their per-fight
  // memoization_casts list, the cost is zeroed and the id is appended.
};

const hailstorm: AbilityDef = {
  kind: "active",
  id: "hailstorm",
  name: "Hailstorm",
  blurb: "Drop a wall of icy hail — every enemy in a 2-hex blast takes magic×d4 ice damage, with a 15% freeze chance per target.",
  icon: "snowing",
  mana_cost: 0,
  cooldown_turns: 5,
  routing: "utility",
  target: "all_enemies",
  range_tiles: 4,
  aoe_radius_tiles: 2,
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    const mag = Math.max(1, ctx.caster.magic_mod);
    // R1 ×1 dmg + 15% freeze, R2 ×1.25 dmg + 20% freeze, R3 ×1.5 dmg + 25% freeze.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const freezeChance = rank >= 3 ? 25 : rank >= 2 ? 20 : 15;
    const formula = rank > 1 ? `${mag}d4×${mult}` : `${mag}d4`;
    return ctx.monsters.map((m) =>
      fx.attackRollDamage(m.id, mag, Math.round(rollSum(ctx.roll, mag, 4) * mult), formula, "ice", undefined, undefined, freezeChance),
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
  blurb: "Trace every call path — deals 1d6 + magic damage and flags the target for 6 of its turns (cascading errors apply 3 bleed stacks per hit).",
  icon: "magnifying-glass",
  mana_cost: 2,
  cooldown_turns: 3,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 3,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const baseRoll = ctx.roll(6) + mag;
    // R1 ×1 / 6 turns, R2 ×1.25 / 8 turns, R3 ×1.5 / 10 turns.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const hexTurns = rank >= 3 ? 10 : rank >= 2 ? 8 : 6;
    const formula = rank > 1 ? `1d6+${mag}m×${mult}` : `1d6+${mag}m`;
    return [
      fx.damage(monster.id, amount, formula, { damageType: "magic" }),
      fx.hexMonster(monster.id, hexTurns),
    ];
  },
};

const smokeTest: AbilityDef = {
  kind: "active",
  id: "smoke_test",
  name: "Smoke Test",
  blurb: "Trip every alarm at once — vanish for 1 swing and pepper every nearby enemy with 1d4 + magic chip damage.",
  icon: "dust-cloud",
  mana_cost: 0,
  cooldown_turns: 3,
  routing: "utility",
  target: "self",
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    const mag = ctx.caster.magic_mod;
    const baseRoll = ctx.roll(4) + mag;
    // R1 ×1 / 1 swing, R2 ×1.25 / 2 swings, R3 ×1.5 / 3 swings.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const swings = rank >= 3 ? 3 : rank >= 2 ? 2 : 1;
    const formula = rank > 1 ? `1d4+${mag}m×${mult}` : `1d4+${mag}m`;
    const damageEffects = ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "magic" }));
    return [fx.vanish(ctx.caster.id, swings), ...damageEffects];
  },
};

// Hotpath — leap to a hex adjacent to the target, then strike. The leap
// auto-resolves: the engine picks the unoccupied neighbor closest to the
// rogue's current position (least-jarring jump). Player only picks the target
// enemy — no new hex picker needed in the UI.
const hotpath: AbilityDef = {
  kind: "active",
  id: "hotpath",
  name: "Hotpath",
  blurb: "Sprint the hot path — leap to the target's flank and strike for 1d8 + attack physical damage.",
  icon: "run",
  mana_cost: 1,
  cooldown_turns: 2,
  routing: "utility",
  target: "single_enemy",
  range_tiles: 4,
  aoe_radius_tiles: 0,
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const atk = ctx.caster.attack_mod;
    const baseRoll = ctx.roll(8) + atk;
    // R1 ×1, R2 ×1.25, R3 ×1.5. Leap behavior is unchanged across ranks.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `1d8+${atk}a×${mult}` : `1d8+${atk}a`;
    return [
      fx.leapAdjacentTo(ctx.caster.id, monster.id),
      fx.damage(monster.id, amount, formula, { damageType: "physical" }),
    ];
  },
};

const cherryPick: AbilityDef = {
  kind: "passive",
  id: "cherry_pick",
  name: "Cherry-Pick",
  blurb: "Finish the broken builds first — your damage on enemies under 25% HP is increased by 50%.",
  icon: "cursed-star",
  trigger: "always_on",
  once_per_fight: false,
  execute: () => [],
  // Effect is applied inline by handleDamageAbility via fighterHasPassive.
};

const silentMode: AbilityDef = {
  kind: "passive",
  id: "silent_mode",
  name: "Silent Mode",
  blurb: "When the logs are clean, the rogue is dangerous — gain +1 AC barkskin at the start of every turn while at full HP.",
  icon: "fog",
  trigger: "on_action",
  once_per_fight: false,
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    if (ctx.caster.hp < ctx.caster.max_hp) return [];
    // R1 +1 AC, R2 +2 AC, R3 +2 AC (dodge bump deferred — needs a new fx
    // kind for transient dodge buffs, or plumbing rank into the AGI
    // dodge-check site in combat_machine).
    const bonus = rank >= 2 ? 2 : 1;
    return [fx.barkskin(ctx.caster.id, bonus, 1)];
  },
};

// ────────────────────────────────────────────────────────────────────────
// SRE Warden
// ────────────────────────────────────────────────────────────────────────

const loadBalancer: AbilityDef = {
  kind: "passive",
  id: "load_balancer",
  name: "Load Balancer",
  blurb: "Distribute the hit across the cluster — soak 25% of HP damage taken by any adjacent ally.",
  icon: "crossed-air-flows",
  trigger: "always_on",
  once_per_fight: false,
  execute: () => [],
  // Redirect is applied inline by the monster-attacks-fighter damage path:
  // when a fighter takes hp damage, if an adjacent warden has this passive
  // equipped, 25% of the damage is reassigned to the warden BEFORE Protect
  // splits the remainder.
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
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const atk = ctx.caster.attack_mod;
    const debuffCount = (monster.effects ?? []).filter((e) =>
      ["bleeding", "poisoned", "burning", "stunned", "hexed", "entangled", "shocked", "frozen"].includes(e.type),
    ).length;
    // R1 ×1 base + 2/debuff, R2 ×1.25 + 3/debuff, R3 ×1.5 + 4/debuff.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const perDebuff = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
    const base = ctx.roll(8) + atk;
    const amount = Math.round(base * mult) + debuffCount * perDebuff;
    const formula = rank > 1
      ? `(1d8+${atk}a)×${mult}+${debuffCount}×${perDebuff}dbf`
      : `1d8+${atk}a+${debuffCount}×2dbf`;
    return [fx.damage(monster.id, amount, formula, { damageType: "physical" })];
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
    const rank = ctx.rank ?? 1;
    const vit = (ctx.caster as FighterSnapshot & { stats?: { vit: number } }).stats?.vit ?? 5;
    // R1 ×1, R2 ×1.5, R3 ×2 shield amount. Entangle duration unchanged.
    const mult = rank >= 3 ? 2 : rank >= 2 ? 1.5 : 1;
    const shieldAmt = Math.round((ctx.roll(6) + vit) * mult);
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
    const rank = ctx.rank ?? 1;
    const target = ctx.target as FighterSnapshot;
    if (target.id === ctx.caster.id) return [];
    // R1 8, R2 12 (×1.5), R3 16 (×2) shield on swap-in.
    const shieldAmt = rank >= 3 ? 16 : rank >= 2 ? 12 : 8;
    return [
      fx.swapPositions(ctx.caster.id, target.id),
      fx.shield(ctx.caster.id, shieldAmt),
    ];
  },
};

const capacityPlanning: AbilityDef = {
  kind: "passive",
  id: "capacity_planning",
  name: "Capacity Planning",
  blurb: "Provision headroom for the team — gain 2 shield per living ally at the start of every turn.",
  icon: "cloud-ring",
  trigger: "on_action",
  once_per_fight: false,
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    const livingAllies = ctx.party.filter((p) => p.hp > 0 && p.id !== ctx.caster.id).length;
    if (livingAllies <= 0) return [];
    // R1 ×2/ally, R2 ×3/ally, R3 ×4/ally shield each turn.
    const perAlly = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
    return [fx.shield(ctx.caster.id, livingAllies * perAlly)];
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
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const baseRoll = ctx.roll(6) + mag;
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    // R1 3 stacks, R2 4 stacks, R3 5 stacks of poison.
    const stacks = rank >= 3 ? 5 : rank >= 2 ? 4 : 3;
    const formula = rank > 1 ? `1d6+${mag}m×${mult}` : `1d6+${mag}m`;
    return [
      fx.damage(monster.id, amount, formula, { damageType: "magic" }),
      fx.poison(monster.id, stacks, 3),
    ];
  },
};

const dropTable: AbilityDef = {
  kind: "active",
  id: "drop_table",
  name: "Drop Table",
  blurb: "Pay 5 HP — no mana — to detonate a magic AoE on every enemy in a 1-hex blast for 2d6 + magic damage. Caster floors at 1 HP.",
  icon: "stomp-tornado",
  mana_cost: 0,
  cooldown_turns: 4,
  routing: "utility",
  target: "all_enemies",
  range_tiles: 4,
  aoe_radius_tiles: 1,
  execute(ctx) {
    const rank = ctx.rank ?? 1;
    const mag = ctx.caster.magic_mod;
    const baseRoll = rollSum(ctx.roll, 2, 6) + mag;
    // R1 ×1, R2 ×1.25, R3 ×1.5. HP cost stays 5.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const amount = Math.round(baseRoll * mult);
    const formula = rank > 1 ? `2d6+${mag}m×${mult}` : `2d6+${mag}m`;
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
    const rank = ctx.rank ?? 1;
    // R1 +1 mana, R2 +2 mana, R3 +3 mana + 1 HP.
    const mana = rank >= 3 ? 3 : rank >= 2 ? 2 : 1;
    const effects = [fx.restoreMana(ctx.caster.id, mana)];
    if (rank >= 3) effects.push(fx.heal(ctx.caster.id, 1));
    return effects;
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
    const rank = ctx.rank ?? 1;
    // R1 +3 HP, R2 +5 HP, R3 +5 HP + 1 mana.
    const heal = rank >= 2 ? 5 : 3;
    const effects = [fx.heal(ctx.caster.id, heal)];
    if (rank >= 3) effects.push(fx.restoreMana(ctx.caster.id, 1));
    return effects;
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
    const rank = ctx.rank ?? 1;
    const monster = ctx.target as MonsterSnapshot;
    const mag = ctx.caster.magic_mod;
    const dotStacks = (monster.effects ?? [])
      .filter((e) => ["bleeding", "poisoned", "burning"].includes(e.type))
      .reduce((sum, e) => sum + e.magnitude, 0);
    // R1 2 / R2 3 / R3 4 damage per DoT stack.
    const perStack = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
    const amount = Math.max(1, mag) + dotStacks * perStack;
    return [fx.damage(monster.id, amount, `${mag}m+${dotStacks}×${perStack}dot`, { damageType: "magic" })];
  },
};

// ────────────────────────────────────────────────────────────────────────
// Ground-effect abilities (see docs/ground-effects.md)
// ────────────────────────────────────────────────────────────────────────
//
// Six starter abilities exercising the GroundEffect system. Each places a
// persistent tile effect — the shape is baked at placement time inside the
// execute() callback using hex.ts helpers (hexLine / hexRing / hexBlast).
// Potency, duration and shape are pinned per the design doc.

const fireWall: AbilityDef = {
  kind: "active",
  id: "fire_wall",
  name: "Fire Wall",
  blurb: "Conjure a wall of flame — a line of 3 hexes ignites for 2 rounds, burning anyone (friend or foe) who stands in it for magic damage on their turn.",
  icon: "fire",
  mana_cost: 2,
  cooldown_turns: 2,
  routing: "utility",
  target: "ground",
  range_tiles: 4,
  execute(ctx) {
    const center = ctx.target_pos;
    if (!center) return [];
    const grid = ctx.grid ?? GRID_DEFAULT;
    // V1 picks horizontal orientation by default (axial right vector). UI
    // can pass an oriented center later; for now this is "wall along the
    // row containing the picked hex" — see design doc open question #1.
    const hexes = hexLine(center, 3, grid, { q: 1, r: 0 });
    const rank = ctx.rank ?? 1;
    const mag = Math.max(1, ctx.caster.magic_mod);
    const potency = rank >= 3 ? Math.round(mag * 1.5) : rank >= 2 ? Math.round(mag * 1.25) : mag;
    return [fx.placeGroundEffect("fire", hexes, "tick", potency, 2)];
  },
};

const ringOfFrost: AbilityDef = {
  kind: "active",
  id: "ring_of_frost",
  name: "Ring of Frost",
  blurb: "Encircle a hex with biting frost — every hex on the ring inflicts magic/2 cold damage at the start of any actor's turn for 2 rounds.",
  icon: "frozen-ring",
  mana_cost: 2,
  cooldown_turns: 3,
  routing: "utility",
  target: "ground",
  range_tiles: 4,
  execute(ctx) {
    const center = ctx.target_pos;
    if (!center) return [];
    const grid = ctx.grid ?? GRID_DEFAULT;
    const hexes = hexRing(center, 1, grid);
    const rank = ctx.rank ?? 1;
    const base = Math.max(1, Math.floor(ctx.caster.magic_mod / 2));
    const potency = rank >= 3 ? Math.round(base * 1.5) : rank >= 2 ? Math.round(base * 1.25) : base;
    return [fx.placeGroundEffect("frost", hexes, "tick", Math.max(1, potency), 2)];
  },
};

const brambles: AbilityDef = {
  kind: "active",
  id: "brambles",
  name: "Brambles",
  blurb: "Snarl the ground with thorned vines — a 7-hex blast deals magic/2 piercing damage to anyone standing in it each round for 3 rounds.",
  icon: "thorn-helix",
  mana_cost: 2,
  cooldown_turns: 3,
  routing: "utility",
  target: "ground",
  range_tiles: 3,
  execute(ctx) {
    const center = ctx.target_pos;
    if (!center) return [];
    const grid = ctx.grid ?? GRID_DEFAULT;
    const hexes = hexBlast(center, 1, grid);
    const rank = ctx.rank ?? 1;
    const base = Math.max(1, Math.floor(ctx.caster.magic_mod / 2));
    const potency = rank >= 3 ? Math.round(base * 1.5) : rank >= 2 ? Math.round(base * 1.25) : base;
    return [fx.placeGroundEffect("brambles", hexes, "tick", Math.max(1, potency), 3)];
  },
};

const consecrate: AbilityDef = {
  kind: "active",
  id: "consecrate",
  name: "Consecrate",
  blurb: "Bless a 7-hex area with holy light — allies standing within heal for magic HP each round for 3 rounds. Enemies are unaffected.",
  icon: "sun-spear",
  mana_cost: 3,
  cooldown_turns: 4,
  routing: "utility",
  target: "ground",
  range_tiles: 3,
  execute(ctx) {
    const center = ctx.target_pos;
    if (!center) return [];
    const grid = ctx.grid ?? GRID_DEFAULT;
    const hexes = hexBlast(center, 1, grid);
    const rank = ctx.rank ?? 1;
    const mag = Math.max(1, ctx.caster.magic_mod);
    const potency = rank >= 3 ? Math.round(mag * 1.5) : rank >= 2 ? Math.round(mag * 1.25) : mag;
    return [fx.placeGroundEffect("consecrated", hexes, "tick", potency, 3)];
  },
};

const caltrops: AbilityDef = {
  kind: "active",
  id: "caltrops",
  name: "Caltrops",
  blurb: "Strew razor-sharp caltrops on a single hex — the next actor to step on them takes dex×d4 piercing damage and the trap is consumed. Lingers 4 rounds.",
  icon: "metal-spikes",
  mana_cost: 1,
  cooldown_turns: 2,
  routing: "utility",
  target: "ground",
  range_tiles: 3,
  execute(ctx) {
    const center = ctx.target_pos;
    if (!center) return [];
    const hexes: HexPos[] = [center];
    const rank = ctx.rank ?? 1;
    const dex = Math.max(1, ctx.caster.stats?.dex ?? 5);
    // dex × d4. Rank multiplier scales the dex term.
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const roll = ctx.roll(4);
    const potency = Math.max(1, Math.round(dex * roll * mult));
    return [fx.placeGroundEffect("caltrops", hexes, "on_enter", potency, 4)];
  },
};

const trappedRune: AbilityDef = {
  kind: "active",
  id: "trapped_rune",
  name: "Trapped Rune",
  blurb: "Etch a volatile rune on a hex — the next actor to step on it suffers magic×d6 arcane damage and the rune detonates. Lingers 4 rounds.",
  icon: "stone-tower",
  mana_cost: 2,
  cooldown_turns: 3,
  routing: "utility",
  target: "ground",
  range_tiles: 4,
  execute(ctx) {
    const center = ctx.target_pos;
    if (!center) return [];
    const hexes: HexPos[] = [center];
    const rank = ctx.rank ?? 1;
    const mag = Math.max(1, ctx.caster.magic_mod);
    const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
    const roll = ctx.roll(6);
    const potency = Math.max(1, Math.round(mag * roll * mult));
    return [fx.placeGroundEffect("rune", hexes, "on_enter", potency, 4)];
  },
};

// ────────────────────────────────────────────────────────────────────────
// Registry — per-class TalentNodeDef list
// ────────────────────────────────────────────────────────────────────────

// Optional per-node rank config. Defaults to single-rank (R1, 1 point, level 1)
// for any caller that omits it — keeps the helper backward-compatible while
// letting ranked nodes declare their progression inline.
type NodeRanks = {
  max_rank: 1 | 2 | 3;
  level_req_per_rank: number[];
  point_cost_per_rank: number[];
};
const SINGLE_RANK: NodeRanks = {
  max_rank: 1,
  level_req_per_rank: [1],
  point_cost_per_rank: [1],
};
// Standard 3-rank progression. Use for most ranked nodes — signature nodes
// can push their R3 gate higher inline (e.g. { ...RANK_3, level_req_per_rank: [1, 8, 15] }).
const RANK_3: NodeRanks = {
  max_rank: 3,
  level_req_per_rank: [1, 6, 12],
  point_cost_per_rank: [1, 2, 3],
};

function activeNode(
  classId: ClassId,
  ability: AbilityDef,
  category: TalentNodeDef["category"],
  ranks: NodeRanks = SINGLE_RANK,
  rankProgression?: string,
): TalentNodeDef {
  return {
    id: ability.id,
    class_id: classId,
    category,
    max_rank: ranks.max_rank,
    level_req_per_rank: ranks.level_req_per_rank,
    point_cost_per_rank: ranks.point_cost_per_rank,
    ability,
    ...(rankProgression ? { rank_progression: rankProgression } : {}),
  };
}

const NEW_NODES_BY_CLASS: Record<ClassId, TalentNodeDef[]> = {
  devops_mage: [
    activeNode("devops_mage", rollingRestart, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("devops_mage", cdnSurge, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("devops_mage", canaryDeploy, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("devops_mage", observability, "damage", RANK_3, "R2: +2 dmg per debuff. R3: +3 dmg per debuff."),
    activeNode("devops_mage", failsafe, "defense", RANK_3, "R2: +5 shield on save. R3: +10 shield on save."),
    activeNode("devops_mage", fireWall, "damage", RANK_3, "R2: ×1.25 tick dmg. R3: ×1.5 tick dmg."),
    activeNode("devops_mage", ringOfFrost, "control", RANK_3, "R2: ×1.25 tick dmg. R3: ×1.5 tick dmg."),
  ],
  qa_paladin: [
    activeNode("qa_paladin", sanityCheck, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("qa_paladin", bisect, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("qa_paladin", codeReview, "support", RANK_3, "R2: ×1.5 heal. R3: ×2 heal."),
    activeNode("qa_paladin", staticAnalysis, "defense"),
    activeNode("qa_paladin", defensiveProgramming, "defense"),
    activeNode("qa_paladin", consecrate, "support", RANK_3, "R2: ×1.25 heal. R3: ×1.5 heal."),
  ],
  backend_druid: [
    activeNode("backend_druid", pruning, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("backend_druid", mycelialWeb, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("backend_druid", compostHeap, "support", RANK_3, "R2: ×1.5 regen. R3: ×2 regen."),
    activeNode("backend_druid", deepRoots, "defense", RANK_3, "R2: +3 AC barkskin. R3: +4 AC barkskin."),
    activeNode("backend_druid", cronJob, "support", RANK_3, "R2: 2 HP/turn. R3: 3 HP/turn."),
    activeNode("backend_druid", brambles, "damage", RANK_3, "R2: ×1.25 tick dmg. R3: ×1.5 tick dmg."),
  ],
  frontend_bard: [
    activeNode("frontend_bard", standupMeeting, "support", RANK_3, "R2: 3 advantage charges. R3: 4 charges."),
    activeNode("frontend_bard", discordNotification, "control", RANK_3, "R2: ×1.25 dmg + lower break%. R3: ×1.5 dmg + lowest break%."),
    activeNode("frontend_bard", encore, "utility", RANK_3, "R2: also refund half mana. R3: also makes ally's next ability crit."),
    activeNode("frontend_bard", unsubscribeFromAll, "utility", RANK_3, "R2: also cleanses ally debuffs. R3: also +1 mana to bard."),
    activeNode("frontend_bard", a11yFirst, "support", RANK_3, "R2: +2 dodge / +2 hit. R3: +3 dodge / +3 hit."),
    activeNode("frontend_bard", earworm, "support", RANK_3, "R2: +2 mana per party crit. R3: +3 mana per crit."),
  ],
  staff_sage: [
    activeNode("staff_sage", frostBolt, "control", RANK_3, "R2: ×1.25 dmg + 35% freeze. R3: ×1.5 dmg + 45% freeze."),
    activeNode("staff_sage", hailstorm, "damage", RANK_3, "R2: ×1.25 dmg + 20% freeze. R3: ×1.5 dmg + 25% freeze."),
    activeNode("staff_sage", timeDilation, "control", RANK_3, "R2: entangle 3 turns. R3: entangle 4 turns."),
    activeNode("staff_sage", memoization, "support"),
    activeNode("staff_sage", cacheWarmer, "support"),
    activeNode("staff_sage", trappedRune, "damage", RANK_3, "R2: ×1.25 trigger dmg. R3: ×1.5 trigger dmg."),
  ],
  refactor_rogue: [
    activeNode("refactor_rogue", codeAudit, "control", RANK_3, "R2: ×1.25 dmg + 8 turn hex. R3: ×1.5 dmg + 10 turn hex."),
    activeNode("refactor_rogue", smokeTest, "utility", RANK_3, "R2: 2 swings vanish + ×1.25 chip. R3: 3 swings + ×1.5 chip."),
    activeNode("refactor_rogue", silentMode, "defense", RANK_3, "R2: +2 AC at full HP. R3: +2 AC + small dodge."),
    activeNode("refactor_rogue", hotpath, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("refactor_rogue", cherryPick, "damage", RANK_3, "R2: ×1.75 dmg on low-HP enemies. R3: ×2.0 dmg."),
    activeNode("refactor_rogue", caltrops, "control", RANK_3, "R2: ×1.25 trigger dmg. R3: ×1.5 trigger dmg."),
  ],
  sre_warden: [
    activeNode("sre_warden", postmortem, "damage", RANK_3, "R2: ×1.25 dmg + 3/debuff. R3: ×1.5 dmg + 4/debuff."),
    activeNode("sre_warden", circuitBreaker, "defense", RANK_3, "R2: ×1.5 ally shield. R3: ×2 ally shield."),
    activeNode("sre_warden", failover, "utility", RANK_3, "R2: 12 self-shield. R3: 16 self-shield."),
    activeNode("sre_warden", capacityPlanning, "defense", RANK_3, "R2: 3 shield per ally. R3: 4 shield per ally."),
    activeNode("sre_warden", loadBalancer, "defense", RANK_3, "R2: 35% damage redirect. R3: 45% redirect."),
  ],
  data_warlock: [
    activeNode("data_warlock", indexScan, "damage", RANK_3, "R2: ×1.25 dmg + 4 poison stacks. R3: ×1.5 dmg + 5 poison stacks."),
    activeNode("data_warlock", stackTrace, "damage", RANK_3, "R2: 3 dmg per DoT stack. R3: 4 dmg per stack."),
    activeNode("data_warlock", dropTable, "damage", RANK_3, "R2: ×1.25 dmg. R3: ×1.5 dmg."),
    activeNode("data_warlock", staleCache, "support", RANK_3, "R2: +2 mana on nearby kill. R3: +3 mana + 1 HP."),
    activeNode("data_warlock", garbageCollection, "support", RANK_3, "R2: +5 HP on kill. R3: +5 HP + 1 mana."),
  ],
};

export function newNodesForClass(classId: ClassId): TalentNodeDef[] {
  return NEW_NODES_BY_CLASS[classId] ?? [];
}

export const ALL_NEW_NODES: TalentNodeDef[] = Object.values(NEW_NODES_BY_CLASS).flat();

export const NEW_ABILITY_DEFS: AbilityDef[] = [
  rollingRestart, cdnSurge, canaryDeploy, observability, failsafe,
  sanityCheck, bisect, codeReview, staticAnalysis, defensiveProgramming,
  pruning, mycelialWeb, compostHeap, deepRoots, cronJob,
  standupMeeting, discordNotification, encore, unsubscribeFromAll, a11yFirst, earworm,
  frostBolt, hailstorm, timeDilation, memoization, cacheWarmer,
  codeAudit, smokeTest, silentMode, hotpath, cherryPick,
  postmortem, circuitBreaker, failover, capacityPlanning, loadBalancer,
  indexScan, stackTrace, dropTable, staleCache, garbageCollection,
  // Ground-effect actives (see docs/ground-effects.md)
  fireWall, ringOfFrost, brambles, consecrate, caltrops, trappedRune,
];
