import type { AbilityDef, MonsterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";

export const warlockAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "sinister_queries",
    name: "Sinister Queries",
    blurb: "Dealing damage applies 1 + floor(level/5) bleed stacks to the target.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
    // Bleed is applied inline by the machine via applySinisterQueries; this
    // definition exists for display and classHasPassive() lookups.
  },
  {
    kind: "active",
    id: "leech_life",
    name: "Leech Life",
    blurb: "Deal 2d6 + magic damage to an enemy and heal for half the damage dealt.",
    icon: "death-skull",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
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
    name: "Hex",
    blurb: "Reduce a monster's damage by 25%. While hexed, it takes 3 bleed stacks whenever it takes damage.",
    icon: "wax-seal",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as MonsterSnapshot;
      return [fx.hexMonster(monster.id, 10)];
    },
  },
  {
    kind: "active",
    id: "summon_imp",
    name: "Summon Imp",
    blurb: "Summon an imp into battle. Its attacks deal damage equal to your magic modifier.",
    icon: "aura",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      const mag = ctx.caster.magic_mod;
      const hp = 5 + ctx.caster.level + mag;
      return [
        fx.summonAllyNpc(
          {
            name: "Imp",
            class_label: "Imp",
            level: ctx.caster.level,
            hp,
            attack_mod: mag, 
            weapon_power: mag,
            position: "front",
            weapon_range: "melee",
            damage_roll: '0'
          },
          "imp",
        ),
      ];
    },
  },
  {
    kind: "active",
    id: "forbidden_sql",
    name: "Forbidden SQL",
    blurb: "Consume all bleed stacks on a target to deal (2 + floor(magic/4)) damage per stack.",
    icon: "scroll-unfurled",
    mana_cost: 2,
    routing: "utility",
    target: "single_enemy",
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
