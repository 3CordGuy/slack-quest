import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

export const warlockAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "hex",
    name: "Hex",
    blurb: "Curses the foe with a slow query that bleeds them out.",
    icon: "death-skull",
    mana_cost: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string; max_hp: number };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const slowQuery = Math.floor(Math.max(0, monster.max_hp) * 0.05);
      const r = ctx.roll(6);
      const amount = r + ctx.caster.magic_mod + slowQuery + wpn;
      return [fx.damage(monster.id, amount, `1d6 + ${ctx.caster.magic_mod}m + ${slowQuery}% + ${wpn}w`, { drinkBuff: "ability" })];
    },
  },
  {
    kind: "active",
    id: "soul_drain",
    name: "Soul Drain",
    blurb: "Deal 1d6 + magic_mod damage and heal yourself for 50% of damage dealt.",
    icon: "death-skull",
    mana_cost: 2,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string; hp: number };
      const d6 = ctx.roll(6);
      const rawDamage = d6 + ctx.caster.magic_mod;
      // Cap at monster_hp - 1 so soul_drain never delivers the killing blow.
      const damage = Math.min(rawDamage, Math.max(1, monster.hp - 1));
      const heal = Math.floor(damage / 2);
      return [
        fx.damage(monster.id, damage, `${d6}+${ctx.caster.magic_mod}m, half drained`),
        fx.heal(ctx.caster.id, heal),
      ];
    },
  },
  {
    kind: "passive",
    id: "cursed_strike",
    name: "Cursed Strike",
    blurb: "Critical attacks/casts inflict a 2-turn 🩸 bleed on the monster.",
    trigger: "on_crit",
    once_per_fight: false,
    execute: () => [],
    // Bleed is applied inline by the machine via applyWarlockBleed; this
    // definition exists for display and class-passive lookups.
  },
];
