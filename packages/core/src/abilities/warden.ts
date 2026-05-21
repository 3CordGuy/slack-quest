import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

const WARDEN_STARTING_SHIELD_BASE = 5;

export const wardenAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "bulwark_strike",
    name: "Bulwark Strike",
    blurb: "Turns armor into a weapon.",
    icon: "shield",
    mana_cost: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      // Armor power is passed in the weapon_power slot by the machine for the
      // Warden — the machine pre-adds armor when it resolves the ability.
      // We read weapon_power here which the machine populates from armor_power.
      const armorPower = ctx.caster.weapon_power;
      const r = ctx.roll(10);
      const amount = r + ctx.caster.attack_mod + armorPower;
      return [fx.damage(monster.id, amount, `1d10 + ${ctx.caster.attack_mod}a + ${armorPower}`, { drinkBuff: "ability" })];
    },
  },
  {
    kind: "active",
    id: "taunt",
    name: "Taunt",
    blurb: "Force the monster to target you for its next 2 swings, overriding the telegraph.",
    icon: "shield-reflect",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      return [fx.taunt(ctx.caster.id, 2)];
    },
  },
  {
    kind: "passive",
    id: "harden_up",
    name: "Harden Up",
    blurb: "Gain a small starting shield on your first action each fight.",
    trigger: "on_action",
    once_per_fight: true,
    execute(ctx) {
      const wardenShield = ctx.caster.level
        ? WARDEN_STARTING_SHIELD_BASE + Math.floor(ctx.caster.level / 6)
        : WARDEN_STARTING_SHIELD_BASE;
      const cap = Math.floor(ctx.caster.armor_power / 2);
      const newShield = Math.min(cap, ctx.caster.shield + wardenShield);
      const added = newShield - ctx.caster.shield;
      if (added <= 0) return [];
      return [fx.shield(ctx.caster.id, added)];
    },
  },
];
