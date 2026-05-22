import type { AbilityDef, FighterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";

export const druidAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "primal_strikes",
    name: "Primal Strikes",
    blurb: "Adds your magic modifier to attack to-hit and damage. Dealing attack damage heals you for 2×mag + attack.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "active",
    id: "regeneration",
    name: "Regeneration",
    blurb: "Target ally regenerates 3×mag HP per turn for 4 rounds.",
    icon: "regeneration",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as FighterSnapshot;
      const magnitude = 3 * ctx.caster.magic_mod;
      return [fx.fighterRegen(target.id, magnitude, 4)];
    },
  },
  {
    kind: "active",
    id: "animal_form",
    name: "Animal Form",
    blurb: "Transform — Might, Vit, Agi, and Dex each increase by 2 + mag + 25% of their current value for 4 rounds.",
    icon: "wolf-head",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      const mag = ctx.caster.magic_mod;
      const stats = (ctx.caster as FighterSnapshot & { stats?: { str: number; vit: number; agi: number; dex: number } }).stats;
      const base = (key: number) => Math.floor(2 + mag + key * 0.25);
      const strBonus = stats ? base(stats.str) : Math.max(1, 2 + mag);
      const vitBonus = stats ? base(stats.vit) : Math.max(1, 2 + mag);
      const agiBonus = stats ? base(stats.agi) : Math.max(1, 2 + mag);
      const dexBonus = stats ? base(stats.dex) : Math.max(1, 2 + mag);
      return [fx.animalForm(ctx.caster.id, strBonus, vitBonus, agiBonus, dexBonus, 4)];
    },
  },
  {
    kind: "active",
    id: "wildgrowth",
    name: "Wildgrowth",
    blurb: "Vines lash every enemy for 3d6 + mag + attack damage and entangle them (−4 to-hit) for 2 rounds.",
    icon: "grass",
    mana_cost: 2,
    cooldown_turns: 2,
    routing: "utility",
    target: "all_enemies",
    execute(ctx) {
      const mag = ctx.caster.magic_mod;
      const atk = ctx.caster.attack_mod;
      const dmg = rollSum(ctx.roll, 3, 6) + mag + atk;
      const formula = `3d6+${mag}m+${atk}a`;
      return [
        ...ctx.monsters.map((m) => fx.damage(m.id, dmg, formula)),
        ...ctx.monsters.map((m) => fx.entangleMonster(m.id, 2)),
      ];
    },
  },
  {
    kind: "active",
    id: "barkskin",
    name: "Barkskin",
    blurb: "Target ally's skin hardens — +5 AC for 2 rounds.",
    icon: "oak-leaf",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as FighterSnapshot;
      return [fx.barkskin(target.id, 5, 2)];
    },
  },
];
