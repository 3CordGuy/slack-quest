import type { AbilityDef, FighterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";

export const druidAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "primal_strikes",
    name: "Primal Strikes",
    blurb: "Raw, direct database access — magic modifier adds to attack rolls and damage. Landing attack hits also heal you for 2×mag + attack.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "active",
    id: "regeneration",
    name: "Regeneration",
    blurb: "Set a recurring health check — target ally regenerates mag HP per turn for 4 rounds.",
    icon: "regeneration",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as FighterSnapshot;
      return [fx.fighterRegen(target.id, ctx.caster.magic_mod, 4)];
    },
  },
  {
    kind: "active",
    id: "animal_form",
    name: "Scale Up",
    blurb: "Provision more compute — all core stats surge by mag + 25% of their current value for 4 rounds.",
    icon: "muscle-up",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      const mag = ctx.caster.magic_mod;
      const stats = (ctx.caster as FighterSnapshot & { stats?: { str: number; vit: number; agi: number; dex: number } }).stats;
      const base = (key: number) => Math.floor(mag + key * 0.25);
      const strBonus = stats ? base(stats.str) : Math.max(1, mag);
      const vitBonus = stats ? base(stats.vit) : Math.max(1, mag);
      const agiBonus = stats ? base(stats.agi) : Math.max(1, mag);
      const dexBonus = stats ? base(stats.dex) : Math.max(1, mag);
      return [fx.animalForm(ctx.caster.id, strBonus, vitBonus, agiBonus, dexBonus, 4)];
    },
  },
  {
    kind: "active",
    id: "wildgrowth",
    name: "Deadlock",
    blurb: "Trigger a mutual wait cycle — lash all enemies for 3d6 + mag + attack damage and deadlock them (−4 to-hit) for 2 rounds.",
    icon: "crossed-chains",
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
    name: "Firewall",
    blurb: "Configure inbound rules: deny all — target ally gains +5 AC for 2 rounds.",
    icon: "firewall",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as FighterSnapshot;
      return [fx.barkskin(target.id, 5, 2)];
    },
  },
];
