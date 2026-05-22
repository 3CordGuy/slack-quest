import type { AbilityDef } from "../abilities";
import { fx, rollSum } from "./effects";

export const rogueAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "backstab",
    name: "Backstab",
    blurb: "Slips through the diff and finds the soft spot.",
    icon: "daggers",
    mana_cost: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string; hp: number; max_hp: number };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const r = rollSum(ctx.roll, 3, 4);
      const raw = r + ctx.caster.attack_mod + wpn;
      // Auto-crit when monster is at or below 50% HP.
      const isCrit = monster.hp <= monster.max_hp / 2;
      const amount = isCrit ? raw * 2 : raw;
      const formulaBase = `3d4 + ${ctx.caster.attack_mod}a + ${wpn}w`;
      const formula = isCrit ? `${formulaBase} ×2 (backstab)` : formulaBase;
      return [fx.damage(monster.id, amount, formula, { isCrit, drinkBuff: "ability" })];
    },
  },
  {
    kind: "active",
    id: "vanish",
    name: "Vanish",
    blurb: "Disappear into the shadows — the monster can't target you for its next 2 swings.",
    icon: "abstract-006",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      return [fx.vanish(ctx.caster.id, 2)];
    },
  },
  {
    kind: "passive",
    id: "first_strike",
    name: "First Strike",
    blurb: "Your first basic attack each fight is a guaranteed crit.",
    trigger: "always_on",
    once_per_fight: true,
    execute: () => [],
  },
];
