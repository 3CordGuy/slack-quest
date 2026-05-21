import type { AbilityDef } from "../abilities";
import { fx, rollSum } from "./effects";

const FORESEE_TURNS = 2;

export const sageAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "manifest",
    name: "Manifest",
    blurb: "Pure intent shaped into pure damage.",
    icon: "crystal-ball",
    mana_cost: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const r = rollSum(ctx.roll, 2, 8);
      const amount = r + wpn;
      return [fx.damage(monster.id, amount, `2d8 + ${wpn}w`, { drinkBuff: "ability" })];
    },
  },
  {
    kind: "active",
    id: "foresee",
    name: "Foresee",
    blurb: "Full battle read: next swing target with net damage range, targeting odds, party triage. Persists 2 turns.",
    icon: "scroll-unfurled",
    mana_cost: 1,
    routing: "utility",
    target: "self",
    execute(_ctx) {
      return [fx.foreseeTurns(FORESEE_TURNS)];
    },
  },
  {
    kind: "passive",
    id: "sages_reading",
    name: "Sage's Reading",
    blurb: "When viewing combat, see the monster's next-swing damage range.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
