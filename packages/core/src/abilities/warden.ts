import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

export const wardenAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "bulwark_strike",
    name: "Bulwark Strike",
    blurb: "Rolls d20 + attack to hit; deals 1d10 + attack + 50% armor on hit.",
    icon: "shield",
    mana_cost: 0,
    cooldown_turns: 2,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const armorBonus = Math.floor(ctx.caster.armor_power * 0.5);
      const amount = ctx.roll(10) + ctx.caster.attack_mod + armorBonus;
      return [fx.attackRollDamage(monster.id, ctx.caster.attack_mod, amount, `1d10 + ${ctx.caster.attack_mod}a + ${armorBonus}`)];
    },
  },
  {
    kind: "active",
    id: "taunt",
    name: "Taunt",
    blurb: "Force all monsters to attack you for the next 2 swings, overriding the telegraph.",
    icon: "shield-reflect",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      return [fx.taunt(ctx.caster.id, 2)];
    },
  },
  {
    kind: "active",
    id: "brace",
    name: "Brace",
    blurb: "Restore 50% of your max armor as shield and take 20% reduced damage for 2 turns.",
    icon: "aura",
    mana_cost: 0,
    cooldown_turns: 4,
    routing: "utility",
    target: "self",
    execute(ctx) {
      const shieldAmount = Math.floor(ctx.caster.armor_power * 0.5);
      return [
        fx.shield(ctx.caster.id, shieldAmount),
        fx.damageReduction(ctx.caster.id, 20, 2),
      ];
    },
  },
  {
    kind: "passive",
    id: "thorns",
    name: "Thorns",
    blurb: "When hit, deal 25% of your armor value back to the attacker.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "passive",
    id: "armor_up",
    name: "Armor Up",
    blurb: "Regenerate 2 + ⌊level/4⌋ shield at the start of each of your turns.",
    trigger: "on_action",
    once_per_fight: false,
    execute: () => [],
  },
];
