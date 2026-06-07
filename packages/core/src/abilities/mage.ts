import type { AbilityDef, FighterSnapshot, MonsterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";

export const mageAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "fireball",
    name: "Prod Fire",
    blurb: "When prod ignites, everything within 3 hexes burns — deals magic×d6 arcane fire damage to every enemy in the blast, with a 15% chance to leave each one burning.",
    icon: "fire",
    mana_cost: 2,
    cooldown_turns: 1,
    routing: "aoe_damage",
    target: "all_enemies",
    aoe_radius_tiles: 3, // burst centered on the mage; misses stragglers across the field
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const mag = ctx.caster.magic_mod;
      const baseRoll = rollSum(ctx.roll, Math.max(1, mag), 6);
      // R1 = ×1, R2 = ×1.25, R3 = ×1.5. Radius bump for R3 deferred — would
      // need to recompose AbilityDef.aoe_radius_tiles per-rank.
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const amount = Math.round(baseRoll * mult);
      const formula = rank > 1 ? `${Math.max(1, mag)}d6×${mult}` : `${Math.max(1, mag)}d6`;
      // Burn proc per-target. Lower than single-target frost (matches Sage
      // Hailstorm's AoE scaling: 15/20/25) so AoE doesn't trivialize the
      // status game.
      const burnChance = rank >= 3 ? 25 : rank >= 2 ? 20 : 15;
      return ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "fire", burnChance }));
    },
  },
  {
    kind: "active",
    id: "containerize",
    name: "Containerize",
    blurb: "Spin up an arcane containment pod around the target — stunned for up to 4 turns with a 30% cumulative chance to break free each turn.",
    icon: "cubes",
    mana_cost: 2,
    cooldown_turns: 1,
    routing: "utility",
    target: "single_enemy",
    range_tiles: 4, // arcane containment lobs across the room
    aoe_radius_tiles: 0, // single-target lockdown
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const target = ctx.target as { id: string } | undefined;
      if (!target) return [];
      // Lower break chance → longer effective stun. R1 30%/50% boss, R2 20%/40%, R3 10%/30%.
      const breakPct = rank >= 3 ? 10 : rank >= 2 ? 20 : 30;
      const bossBreakPct = rank >= 3 ? 30 : rank >= 2 ? 40 : 50;
      return [fx.stunMonster(target.id, breakPct, bossBreakPct)];
    },
  },
  {
    kind: "active",
    id: "lightning_bolt",
    name: "Zero-Day Strike",
    blurb: "A precision strike through an unpatched vulnerability — rolls d20 + magic to hit; deals magic × d8 damage + chain damage to enemies within 1 hex, with a 25% chance to leave the primary target shocked.",
    icon: "lightning-branches",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    range_tiles: 5, // long-range hex/lightning strike
    aoe_radius_tiles: 1, // arcing lightning chains to adjacent foes
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as MonsterSnapshot;
      const mag = ctx.caster.magic_mod;
      const baseRoll = rollSum(ctx.roll, Math.max(1, mag), 8);
      // R1 ×1, R2 ×1.25, R3 ×1.5. Adding a chain hop at R2 would need
      // recomposing aoe_radius_tiles per-rank — deferred.
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const amount = Math.round(baseRoll * mult);
      const formula = rank > 1 ? `${Math.max(1, mag)}d8×${mult}` : `${Math.max(1, mag)}d8`;
      // Single-target shock proc. Matches Sage Ray of Frost's 25/25/30
      // since both are pinpoint elemental strikes.
      const shockChance = rank >= 3 ? 30 : 25;
      return [fx.attackRollDamage(monster.id, mag, amount, formula, "lightning", undefined, undefined, undefined, undefined, shockChance)];
    },
  },
  {
    kind: "active",
    id: "mage_armor",
    name: "Encapsulate",
    blurb: "Wrap an ally in a protective abstraction layer — grants 3d6 + magic shield.",
    icon: "aura",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const target = ctx.target as FighterSnapshot;
      const baseAmount = rollSum(ctx.roll, 3, 6) + ctx.caster.magic_mod;
      // R1 ×1, R2 ×1.5, R3 ×2. Reflect-on-blocked-damage capstone deferred —
      // needs a new AbilityEffect kind for the on-absorb counter.
      const mult = rank >= 3 ? 2 : rank >= 2 ? 1.5 : 1;
      const amount = Math.round(baseAmount * mult);
      return [fx.shield(target.id, amount)];
    },
  },
  {
    kind: "passive",
    id: "mana_font",
    name: "Mana Font",
    blurb: "An always-on background process — quietly regenerates 1 mana every 3 turns.",
    icon: "droplets",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
