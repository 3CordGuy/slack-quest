import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

export const wardenAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "bulwark_strike",
    name: "Stress Test",
    blurb: "Push the system to its limit — rolls d20 + attack to hit; converts 50% of current shield into bonus strike damage.",
    icon: "cracked-disc",
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
    blurb: "Own the incident — force all monsters to target you for 2 swings, routing all incoming damage through your armor for 2 turns. Gain (vit + str) / 8 shield, doubled if you're the last one standing.",
    icon: "screaming",
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
    blurb: "Activate defensive mode — restore 50% of effective armor as shield and take 20% reduced damage for 2 turns.",
    icon: "shieldcomb",
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
    name: "Backpressure",
    blurb: "The load stops here and bounces back — passively return 25% of your armor value to any attacker.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "passive",
    id: "armor_up",
    name: "Armor Up",
    blurb: "Auto-provision defenses — regenerate 2 + ⌊level/4⌋ shield at the start of each turn.",
    trigger: "on_action",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "passive",
    id: "resilient",
    name: "Resilient",
    blurb: "Each hit that lands builds your tolerance — gain a Resilient stack per successful hit (lasts 4 rounds). Each stack raises shield cap and effective armor by 2 + ⌊vit/4⌋.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
