import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

export const bardAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "mock",
    name: "Mock",
    blurb: "A cutting jeer rattles the enemy — disadvantage on their next 2 to-hit rolls.",
    icon: "screaming",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      return [fx.discourage(monster.id, 2)];
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
    kind: "active",
    id: "encourage",
    name: "Encourage",
    blurb: "A rallying word fills an ally with confidence — advantage on their next 2 to-hit rolls.",
    icon: "conversation",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as { id: string } | undefined;
      const targetId = target?.id ?? ctx.caster.id;
      return [fx.encourage(targetId, 2)];
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
