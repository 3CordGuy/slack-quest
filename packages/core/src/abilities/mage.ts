import type { AbilityDef } from "../abilities";
import { fx, rollSum } from "./effects";

export const mageAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "fireball",
    name: "Fireball",
    blurb: "Rains fire on every enemy at once.",
    icon: "fire",
    mana_cost: 2,
    target: "all_enemies",
    execute(ctx) {
      const r = rollSum(ctx.roll, 2, 6);
      const amount = r + ctx.caster.magic_mod;
      const formula = `2d6 + ${ctx.caster.magic_mod}m`;
      return ctx.monsters.map((m) => fx.damage(m.id, amount, formula));
    },
  },
  {
    kind: "active",
    id: "containerize",
    name: "Containerize",
    blurb: "Locks the monster in a stasis container. Each stunned turn it has a 30% cumulative chance to break free (capped at 100% on the fourth turn).",
    icon: "cubes",
    mana_cost: 2,
    target: "single_enemy",
    execute(_ctx) {
      return [fx.stunMonster()];
    },
  },
  {
    kind: "passive",
    id: "mana_font",
    name: "Mana Font",
    blurb: "Tap into an endless reservoir — regain 1 mana every 3 turns.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
