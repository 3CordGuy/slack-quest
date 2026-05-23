import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

export const wardenAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "bulwark_strike",
    name: "Bulwark Strike",
    blurb: "Rolls d20 + attack to hit; deals 1d10 + attack + 50% current shield on hit.",
    icon: "shield",
    mana_cost: 0,
    cooldown_turns: 2,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const shieldBonus = Math.floor(ctx.caster.shield * 0.5);
      const amount = ctx.roll(10) + ctx.caster.attack_mod + shieldBonus;
      return [fx.attackRollDamage(monster.id, ctx.caster.attack_mod, amount, `1d10 + ${ctx.caster.attack_mod}a + ${shieldBonus}sh`)];
    },
  },
  {
    kind: "active",
    id: "taunt",
    name: "Taunt",
    blurb: "Force all monsters to attack you for 2 swings. All incoming damage routes through your armor for 2 turns. Grants (vit + str) / 8 shield, doubled if you're the last one standing.",
    icon: "shield-reflect",
    mana_cost: 2,
    cooldown_turns: 1,
    routing: "utility",
    target: "self",
    execute(ctx) {
      const vit = ctx.caster.stats?.vit ?? 0;
      const str = ctx.caster.stats?.str ?? 0;
      const base = Math.floor((vit + str) / 8);
      const solo = ctx.party.length === 1;
      const shieldAmt = solo ? base * 2 : base;
      return [fx.taunt(ctx.caster.id, 2), fx.shield(ctx.caster.id, shieldAmt), fx.tauntFortify(ctx.caster.id, 2)];
    },
  },
  {
    kind: "active",
    id: "brace",
    name: "Brace",
    blurb: "Restore 50% of your effective armor (armor + Resilient bonus) as shield, and take 20% reduced damage for 2 turns.",
    icon: "aura",
    mana_cost: 0,
    cooldown_turns: 4,
    routing: "utility",
    target: "self",
    execute(ctx) {
      return [
        fx.shieldFromArmor(ctx.caster.id, 0.5),
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
  {
    kind: "passive",
    id: "resilient",
    name: "Resilient",
    blurb: "On each successful attack hit, gain a Resilient stack (lasts 4 rounds). Each active stack raises your shield cap and effective armor by 2 + ⌊vit/4⌋, boosting Thorns, Brace, and the maximum shield you can hold.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
