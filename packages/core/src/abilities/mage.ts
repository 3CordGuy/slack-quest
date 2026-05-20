import type { AbilityDef } from "../abilities";
import { fx, rollSum } from "./effects";

export const mageAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "detonate",
    name: "Detonate",
    blurb: "Drops a payload that bursts on impact.",
    icon: "fire-bomb",
    mana_cost: 1,
    target: "single_enemy",
    mana_free_first_use: true, // Mana Catalyst passive
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const r = rollSum(ctx.roll, 2, 6);
      const amount = r + ctx.caster.magic_mod + wpn;
      return [fx.damage(monster.id, amount, `2d6 + ${ctx.caster.magic_mod}m + ${wpn}w`, { drinkBuff: "ability" })];
    },
  },
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
    blurb: "Locks the monster in a stasis container. It skips its next swing entirely.",
    icon: "cubes",
    mana_cost: 2,
    target: "single_enemy",
    execute(_ctx) {
      return [fx.skipSwings(1)];
    },
  },
  {
    kind: "passive",
    id: "mana_catalyst",
    name: "Mana Catalyst",
    blurb: "First active ability each fight costs 0 mana.",
    trigger: "always_on",
    once_per_fight: true,
    execute: () => [],
  },
];
