import type { AbilityDef, MonsterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";

export const warlockAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "sinister_queries",
    name: "Sinister Queries",
    blurb: "Every query bleeds the target — dealing damage applies 1 + floor(level/5) bleed stacks.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
    // Bleed is applied inline by the machine via applySinisterQueries; this
    // definition exists for display and classHasPassive() lookups.
  },
  {
    kind: "active",
    id: "leech_life",
    name: "Data Siphon",
    blurb: "Tap a live data source and drain it — deal 2d6 + magic damage and absorb half as health.",
    icon: "heart-drop",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    range_tiles: 4, // siphon a remote target
    aoe_radius_tiles: 0, // single-tap drain
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as MonsterSnapshot;
      const roll1 = ctx.roll(6);
      const roll2 = ctx.roll(6);
      const baseDamage = roll1 + roll2 + ctx.caster.magic_mod;
      // R1 ×1, R2 ×1.25, R3 ×1.5. Lifesteal stays half at R1/R2; R3 boosts
      // lifesteal ratio by ×1.5 (i.e. ~75% of damage healed).
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const damage = Math.round(baseDamage * mult);
      const lifestealMult = rank >= 3 ? 1.5 : 1;
      const heal = Math.floor((damage / 2) * lifestealMult);
      const formula = rank > 1
        ? `2d6(${roll1}+${roll2})+${ctx.caster.magic_mod}m×${mult}`
        : `2d6(${roll1}+${roll2})+${ctx.caster.magic_mod}m`;
      return [
        fx.damage(monster.id, damage, formula),
        fx.heal(ctx.caster.id, heal),
      ];
    },
  },
  {
    kind: "active",
    id: "hex",
    name: "Corrupt Index",
    blurb: "Corrupt the lookup table — reduce monster damage by 25%; every hit it takes spawns 3 bleed stacks from cascading errors.",
    icon: "wax-seal",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    range_tiles: 5, // hex from across the battlefield
    aoe_radius_tiles: 0, // pinpoint corruption
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as MonsterSnapshot;
      // R1 10 turns, R2 +2 (12), R3 +4 (14).
      const duration = rank >= 3 ? 14 : rank >= 2 ? 12 : 10;
      return [fx.hexMonster(monster.id, duration)];
    },
  },
  {
    kind: "active",
    id: "summon_imp",
    name: "Spawn Service Worker",
    blurb: "Fork a new process into combat — the worker attacks independently, dealing damage equal to your magic modifier.",
    icon: "vintage-robot",
    mana_cost: 2,
    cooldown_turns: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const mag = ctx.caster.magic_mod;
      const baseHp = 5 + ctx.caster.level + mag;
      // R2 hp ×1.25 / mag ×1.25, R3 hp ×1.5 / mag ×1.5.
      const hpMult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const magMult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const hp = Math.round(baseHp * hpMult);
      const scaledMag = Math.max(0, Math.round(mag * magMult));
      return [
        fx.summonAllyNpc(
          {
            name: "Service Worker",
            class_label: "Service Worker",
            level: ctx.caster.level,
            hp,
            attack_mod: scaledMag,
            weapon_power: scaledMag,
            position: "front",
            weapon_range: "melee",
            damage_roll: '0'
          },
          "spawn-node",
        ),
      ];
    },
  },
  {
    kind: "active",
    id: "forbidden_sql",
    name: "Forbidden SQL",
    blurb: "Execute the query that should never run — consume all bleed stacks on a target for (2 + floor(magic/4)) damage each.",
    icon: "blood",
    mana_cost: 2,
    routing: "utility",
    target: "single_enemy",
    range_tiles: 5, // ranged dark-magic burst
    aoe_radius_tiles: 1, // consume-and-burst splashes adjacent foes
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as MonsterSnapshot;
      const bleedEffect = monster.effects?.find((e) => e.type === "bleeding");
      const stacks = bleedEffect?.magnitude ?? 0;
      if (stacks === 0) return [];
      // R1 +0 / R2 +1 / R3 +2 bonus damage per stack.
      const rankBonus = rank >= 3 ? 2 : rank >= 2 ? 1 : 0;
      const dmgPerStack = 2 + Math.floor(ctx.caster.magic_mod / 4) + rankBonus;
      const total = stacks * dmgPerStack;
      return [
        fx.consumeMonsterBleed(monster.id),
        fx.damage(monster.id, total, `${stacks}×${dmgPerStack}(3+${Math.floor(ctx.caster.magic_mod / 4)}${rankBonus ? `+${rankBonus}r` : ""})`),
      ];
    },
  },
];
