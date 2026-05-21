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
    blurb: "Bardic aura jumps from +1 to +3 damage for the next 2 partymate attacks.",
    icon: "aura",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      // Charges scale with Bard level: +1 every 5 levels beyond 1.
      const charges = 2 + Math.floor(ctx.caster.level / 5);
      return [fx.battleHymn(charges)];
    },
  },
  {
    kind: "passive",
    id: "bardic_aura",
    name: "Bardic Aura",
    blurb: "While you're alive, other party members' attacks deal +1 damage.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
