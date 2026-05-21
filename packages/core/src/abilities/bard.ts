import type { AbilityDef } from "../abilities";
import { fx, rollSum } from "./effects";

export const bardAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "crescendo",
    name: "Crescendo",
    blurb: "A rising chorus the whole party joins.",
    icon: "musical-notes",
    mana_cost: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const party = Math.max(1, ctx.party.length);
      const r = rollSum(ctx.roll, 1, 6);
      const amount = r + ctx.caster.magic_mod + party * 2 + wpn;
      return [fx.damage(monster.id, amount, `1d6 + ${ctx.caster.magic_mod}m + ${party}p×2 + ${wpn}w`, { drinkBuff: "ability" })];
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
      const healAmt = rollSum(ctx.roll, 2, 6) + ctx.caster.magic_mod;
      const shieldAmt = 2 + Math.floor(ctx.caster.level / 5);
      return [fx.heal(lowest.id, healAmt), fx.shield(lowest.id, shieldAmt)];
    },
  },
  {
    kind: "active",
    id: "discord",
    name: "Discord",
    blurb: "A wall of dissonant noise that damages all enemies.",
    icon: "sonic-shout",
    mana_cost: 3,
    routing: "aoe_damage",
    target: "all_enemies",
    execute(ctx) {
      const amount = rollSum(ctx.roll, 1, 4) + ctx.caster.magic_mod;
      return ctx.monsters.map((m) =>
        fx.damage(m.id, amount, `1d4 + ${ctx.caster.magic_mod}m`),
      );
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
