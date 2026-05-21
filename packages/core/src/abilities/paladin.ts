import type { AbilityDef } from "../abilities";
import { fx, rollSum } from "./effects";

const PALADIN_AUTO_HEAL_AMOUNT = 8;
const PALADIN_AUTO_HEAL_THRESHOLD = 0.3;
const SHIELD_AMOUNT_BASE = 3;

export const paladinAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "smite",
    name: "Smite",
    blurb: "Strikes with the weight of a thousand failed builds.",
    icon: "axe-swing",
    mana_cost: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const r = rollSum(ctx.roll, 2, 6);
      const amount = r + ctx.caster.attack_mod * 2 + wpn;
      return [fx.damage(monster.id, amount, `2d6 + ${ctx.caster.attack_mod}a×2 + ${wpn}w`, { drinkBuff: "ability" })];
    },
  },
  {
    kind: "active",
    id: "regression_shield",
    name: "Regression Shield",
    blurb: "Grants 🛡 +3 shield to every alive partymate.",
    icon: "fairy-wand",
    mana_cost: 2,
    routing: "utility",
    target: "all_allies",
    execute(ctx) {
      const perLevel = Math.floor(ctx.caster.level / 4);
      return [fx.shieldAll(SHIELD_AMOUNT_BASE + perLevel)];
    },
  },
  {
    kind: "passive",
    id: "lay_on_hands",
    name: "Lay on Hands",
    blurb: "Once per fight, when an ally drops below 30% HP after a hit, auto-heal them.",
    trigger: "on_ally_hit",
    once_per_fight: true,
    condition(ctx) {
      const target = ctx.target as { hp: number; max_hp: number } | undefined;
      if (!target) return false;
      return target.hp > 0 && target.hp < target.max_hp * PALADIN_AUTO_HEAL_THRESHOLD;
    },
    execute(ctx) {
      const target = ctx.target as { id: string; max_hp: number };
      const healAmount = PALADIN_AUTO_HEAL_AMOUNT + Math.floor((ctx.caster.level ?? 1) / 4);
      return [fx.heal(target.id, healAmount)];
    },
  },
];
