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
      const monster = ctx.target as MonsterSnapshot;
      const roll1 = ctx.roll(6);
      const roll2 = ctx.roll(6);
      const damage = roll1 + roll2 + ctx.caster.magic_mod;
      const heal = Math.floor(damage / 2);
      return [
        fx.damage(monster.id, damage, `2d6(${roll1}+${roll2})+${ctx.caster.magic_mod}m`),
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
      const monster = ctx.target as MonsterSnapshot;
      return [fx.hexMonster(monster.id, 10)];
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
      const mag = ctx.caster.magic_mod;
      const hp = 5 + ctx.caster.level + mag;
      return [
        fx.summonAllyNpc(
          {
            name: "Service Worker",
            class_label: "Service Worker",
            level: ctx.caster.level,
            hp,
            attack_mod: mag,
            weapon_power: mag,
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
      const monster = ctx.target as MonsterSnapshot;
      const bleedEffect = monster.effects?.find((e) => e.type === "bleeding");
      const stacks = bleedEffect?.magnitude ?? 0;
      if (stacks === 0) return [];
      const dmgPerStack = 2 + Math.floor(ctx.caster.magic_mod / 4);
      const total = stacks * dmgPerStack;
      return [
        fx.consumeMonsterBleed(monster.id),
        fx.damage(monster.id, total, `${stacks}×${dmgPerStack}(3+${Math.floor(ctx.caster.magic_mod / 4)})`),
      ];
    },
  },
];
