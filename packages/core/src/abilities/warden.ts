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
    range_tiles: 3, // synthetic-load probe from a few hexes away
    aoe_radius_tiles: 0, // single-target stress probe
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as { id: string };
      const shieldBonus = Math.floor(ctx.caster.shield * 0.5);
      // R1 ×1, R2 ×1.25, R3 ×1.5. Shield→damage conversion stays at 50%;
      // only the final strike scales so the trade-off remains intuitive.
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const base = ctx.roll(10) + ctx.caster.attack_mod + shieldBonus;
      const amount = Math.round(base * mult);
      const formula = rank > 1
        ? `(1d10 + ${ctx.caster.attack_mod}a + ${shieldBonus}sh)×${mult}`
        : `1d10 + ${ctx.caster.attack_mod}a + ${shieldBonus}sh`;
      return [fx.attackRollDamage(monster.id, ctx.caster.attack_mod, amount, formula)];
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
      const rank = ctx.rank ?? 1;
      const vit = ctx.caster.stats?.vit ?? 0;
      const str = ctx.caster.stats?.str ?? 0;
      const base = Math.floor((vit + str) / 8);
      const solo = ctx.party.length === 1;
      // R1 ×1, R2 ×1.5, R3 ×2 shield. Fortify duration also bumps
      // (R1 2, R2 3, R3 4 turns) so the routing window grows with rank.
      const shieldMult = rank >= 3 ? 2 : rank >= 2 ? 1.5 : 1;
      const fortifyTurns = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
      const shieldAmt = Math.round((solo ? base * 2 : base) * shieldMult);
      return [fx.taunt(ctx.caster.id, 2), fx.shield(ctx.caster.id, shieldAmt), fx.tauntFortify(ctx.caster.id, fortifyTurns)];
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
      const rank = ctx.rank ?? 1;
      // R1 20%, R2 25%, R3 30% reduction. Shield-from-armor fraction unchanged.
      const reductionPct = rank >= 3 ? 30 : rank >= 2 ? 25 : 20;
      return [
        fx.shieldFromArmor(ctx.caster.id, 0.5),
        fx.damageReduction(ctx.caster.id, reductionPct, 2),
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
