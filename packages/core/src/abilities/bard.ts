import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

export const bardAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "crescendo",
    name: "Crescendo",
    blurb: "A rising build that crescendos into a deploy strike — rolls d20 + magic to hit; deals 1d6 + magic + party×2 + weapon on hit.",
    icon: "sound-on",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    range_tiles: 3, // musical wave carries a few hexes
    aoe_radius_tiles: 1, // crescendo wave catches adjacent foes
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as { id: string };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const party = Math.max(1, ctx.party.length);
      const r = ctx.roll(6);
      const baseAmount = r + ctx.caster.magic_mod + party * 2 + wpn;
      // R1 ×1, R2 ×1.25, R3 ×1.5.
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const amount = Math.round(baseAmount * mult);
      const baseFormula = `1d6 + ${ctx.caster.magic_mod}m + ${party}p×2 + ${wpn}w`;
      const formula = rank > 1 ? `(${baseFormula})×${mult}` : baseFormula;
      return [fx.attackRollDamage(monster.id, ctx.caster.magic_mod, amount, formula)];
    },
  },
  {
    kind: "active",
    id: "verse",
    name: "Verse",
    blurb: "Drop a pointed PR comment — mock an enemy (disadvantage on their next 2 rolls) or leave glowing feedback for an ally (advantage on their next 2 rolls). 2-turn cooldown.",
    icon: "scroll-quill",
    mana_cost: 0,
    cooldown_turns: 2,
    routing: "utility",
    target: "any",
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const target = ctx.target as { id: string; hp?: number; max_hp?: number } | undefined;
      if (!target) return [];
      // Fighters have max_hp; monsters do not always — distinguish by checking the
      // party array so we don't rely on a fragile field heuristic.
      const isAlly = (ctx.party as Array<{ id: string }>).some((f) => f.id === target.id);
      // R1 2 charges, R2 3 charges, R3 4 charges.
      const charges = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
      return isAlly ? [fx.encourage(target.id, charges)] : [fx.discourage(target.id, charges)];
    },
  },
  {
    kind: "active",
    id: "battle_hymn",
    name: "Battle Hymn",
    blurb: "Fire the all-hands — Morale Boost surges for 3 rounds (+2 + magic bonus damage) and restores mana to all allies.",
    icon: "aura",
    mana_cost: 2,
    routing: "utility",
    target: "all_allies",
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      // R1: 1+lvl/8 mana. R2: +1 mana per ally. R3: +2 mana per ally and +1 round duration.
      const baseRestore = 1 + Math.floor(ctx.caster.level / 8);
      const manaRestore = baseRestore + (rank >= 3 ? 2 : rank >= 2 ? 1 : 0);
      const rounds = rank >= 3 ? 4 : 3;
      return [
        fx.battleHymn(rounds),
        ...ctx.party.map((m) => fx.restoreMana(m.id, manaRestore)),
      ];
    },
  },
  {
    kind: "active",
    id: "serenade",
    name: "Serenade",
    blurb: "A quiet 1:1 with the most stressed teammate — heals and shields a chosen ally for 2d6 + magic HP and a small shield.",
    icon: "music-spell",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const target = ctx.target as { id: string };
      const baseHeal = ctx.roll(6) + ctx.roll(6) + ctx.caster.magic_mod;
      const baseShield = 2 + Math.floor(ctx.caster.level / 5);
      // R1 ×1, R2 ×1.25, R3 ×1.5 on both heal and shield.
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const healAmt = Math.round(baseHeal * mult);
      const shieldAmt = Math.round(baseShield * mult);
      return [fx.heal(target.id, healAmt), fx.shield(target.id, shieldAmt)];
    },
  },
  {
    kind: "passive",
    id: "bardic_aura",
    name: "Morale Boost",
    blurb: "Your presence is a force multiplier — the whole party deals +(1 + floor(level/5)) bonus damage. Battle Hymn amplifies it further.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
    // Morale damage bonus is computed inline by the combat machine (reads
    // caster level), not execute(). Plumbing kit_ranks to the bonus formula
    // is a follow-up — same situation as Mana Font in the Mage kit. Stays R1.
  },
];
