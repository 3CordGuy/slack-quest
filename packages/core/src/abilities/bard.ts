import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

export const bardAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "crescendo",
    name: "Crescendo",
    blurb: "A rising melody that crescendos into a strike — rolls d20 + magic to hit; deals 1d6 + magic + party×2 + weapon on hit.",
    icon: "horn-call",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const party = Math.max(1, ctx.party.length);
      const r = ctx.roll(6);
      const amount = r + ctx.caster.magic_mod + party * 2 + wpn;
      return [fx.attackRollDamage(monster.id, ctx.caster.magic_mod, amount, `1d6 + ${ctx.caster.magic_mod}m + ${party}p×2 + ${wpn}w`)];
    },
  },
  {
    kind: "active",
    id: "verse",
    name: "Verse",
    blurb: "Pick a target: mock an enemy (disadvantage on their next 2 rolls) or encourage an ally (advantage on their next 2 rolls). 2-turn cooldown.",
    icon: "quill-ink",
    mana_cost: 0,
    cooldown_turns: 2,
    routing: "utility",
    target: "any",
    execute(ctx) {
      const target = ctx.target as { id: string; hp?: number; max_hp?: number } | undefined;
      if (!target) return [];
      // Fighters have max_hp; monsters do not always — distinguish by checking the
      // party array so we don't rely on a fragile field heuristic.
      const isAlly = (ctx.party as Array<{ id: string }>).some((f) => f.id === target.id);
      return isAlly ? [fx.encourage(target.id, 2)] : [fx.discourage(target.id, 2)];
    },
  },
  {
    kind: "active",
    id: "battle_hymn",
    name: "Battle Hymn",
    blurb: "Morale Boost surges for 3 rounds (+2 + magic bonus damage on top of the base aura) and restores mana to all allies.",
    icon: "aura",
    mana_cost: 2,
    routing: "utility",
    target: "all_allies",
    execute(ctx) {
      const manaRestore = 1 + Math.floor(ctx.caster.level / 8);
      return [
        fx.battleHymn(3),
        ...ctx.party.map((m) => fx.restoreMana(m.id, manaRestore)),
      ];
    },
  },
  {
    kind: "active",
    id: "serenade",
    name: "Serenade",
    blurb: "A soothing melody that heals and shields a chosen ally for 2d6 + magic HP and a small shield.",
    icon: "music-spell",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as { id: string };
      const healAmt = ctx.roll(6) + ctx.roll(6) + ctx.caster.magic_mod;
      const shieldAmt = 2 + Math.floor(ctx.caster.level / 5);
      return [fx.heal(target.id, healAmt), fx.shield(target.id, shieldAmt)];
    },
  },
  {
    kind: "passive",
    id: "bardic_aura",
    name: "Morale Boost",
    blurb: "The whole party (including yourself and ally NPCs) deals +(1 + floor(level/5)) bonus damage. Battle Hymn boosts it by +2 more.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
