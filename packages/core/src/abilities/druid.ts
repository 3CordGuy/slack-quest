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
    icon: "health-increase",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const target = ctx.target as FighterSnapshot;
      // R1 mag/turn, R2 ×1.25 regen, R3 ×1.5 regen. Duration bumps deferred —
      // would need per-rank turn count and matching UI copy.
      const mag = ctx.caster.magic_mod;
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const amount = Math.max(1, Math.round(mag * mult));
      return [fx.fighterRegen(target.id, amount, 4)];
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
      const rank = ctx.rank ?? 1;
      const mag = ctx.caster.magic_mod;
      const stats = (ctx.caster as FighterSnapshot & { stats?: { str: number; vit: number; agi: number; dex: number } }).stats;
      // R1 base, R2 ×1.25 stat bonuses, R3 ×1.5 stat bonuses. Duration bump
      // (R3 +2 turns) deferred — would split the turn count off the kit blurb.
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const base = (key: number) => Math.max(1, Math.floor((mag + key * 0.25) * mult));
      const strBonus = stats ? base(stats.str) : Math.max(1, Math.round(mag * mult));
      const vitBonus = stats ? base(stats.vit) : Math.max(1, Math.round(mag * mult));
      const agiBonus = stats ? base(stats.agi) : Math.max(1, Math.round(mag * mult));
      const dexBonus = stats ? base(stats.dex) : Math.max(1, Math.round(mag * mult));
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
      const rank = ctx.rank ?? 1;
      const mag = ctx.caster.magic_mod;
      const atk = ctx.caster.attack_mod;
      // R1 ×1, R2 ×1.25 dmg, R3 ×1.5 dmg. Entangle-duration bump deferred —
      // 2-turn root is already strong; longer would shift the ability identity.
      const baseRoll = rollSum(ctx.roll, 3, 6) + mag + atk;
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const dmg = Math.round(baseRoll * mult);
      const formula = rank > 1 ? `3d6+${mag}m+${atk}a×${mult}` : `3d6+${mag}m+${atk}a`;
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
      const rank = ctx.rank ?? 1;
      const target = ctx.target as FighterSnapshot;
      // R1 +5 AC, R2 +6 AC, R3 +7 AC. Duration bumps deferred — would split
      // the 2-turn cadence off the blurb.
      const bonus = rank >= 3 ? 7 : rank >= 2 ? 6 : 5;
      return [fx.barkskin(target.id, bonus, 2)];
    },
  },
];
