import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

export const bardAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "crescendo",
    name: "Crescendo",
    blurb: "A rising melody that crescendos into a strike — deals 1d6 + magic + party×2 + weapon damage.",
    icon: "music-spell",
    mana_cost: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const party = Math.max(1, ctx.party.length);
      const r = ctx.roll(6);
      const amount = r + ctx.caster.magic_mod + party * 2 + wpn;
      return [fx.damage(monster.id, amount, `1d6 + ${ctx.caster.magic_mod}m + ${party}p×2 + ${wpn}w`, { drinkBuff: "ability" })];
    },
  },
  {
    kind: "active",
    id: "verse",
    name: "Verse",
    blurb: "Pick a target: mock an enemy (disadvantage on their next 2 rolls) or encourage an ally (advantage on their next 2 rolls). Free but 2-turn cooldown.",
    icon: "morbid-humour",
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
    blurb: "Bardic aura charges up (+3 damage for next few party attacks) and restores mana to all allies.",
    icon: "aura",
    mana_cost: 2,
    routing: "utility",
    target: "all_allies",
    execute(ctx) {
      const charges = 2 + Math.floor(ctx.caster.level / 5);
      const manaRestore = 1 + Math.floor(ctx.caster.level / 8);
      return [
        fx.battleHymn(charges),
        ...ctx.party.map((m) => fx.restoreMana(m.id, manaRestore)),
      ];
    },
  },
  {
    kind: "active",
    id: "serenade",
    name: "Serenade",
    blurb: "A soothing melody that heals and shields the most wounded ally (auto-targets lowest HP%).",
    icon: "music-spell",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      const lowest = ctx.party.reduce((a, b) =>
        a.hp / a.max_hp <= b.hp / b.max_hp ? a : b,
      );
      const healAmt = ctx.roll(6) + ctx.roll(6) + ctx.caster.magic_mod;
      const shieldAmt = 2 + Math.floor(ctx.caster.level / 5);
      return [fx.heal(lowest.id, healAmt), fx.shield(lowest.id, shieldAmt)];
    },
  },
  {
    kind: "passive",
    id: "bardic_aura",
    name: "Bardic Aura",
    blurb: "While you're alive, partymates deal +(1 + floor(level/5)) bonus damage. Battle Hymn boosts it by +2 more.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
