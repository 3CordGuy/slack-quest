import type { AbilityDef, FighterSnapshot, MonsterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";

export const mageAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "fireball",
    name: "Prod Fire",
    blurb: "When prod ignites, everything burns — deals magic×d6 arcane fire damage to all enemies.",
    icon: "fire",
    mana_cost: 2,
    cooldown_turns: 1,
    routing: "aoe_damage",
    target: "all_enemies",
    execute(ctx) {
      const mag = ctx.caster.magic_mod;
      const r = rollSum(ctx.roll, Math.max(1, mag), 6);
      const amount = r;
      const formula = `${Math.max(1, mag)}d6`;
      return ctx.monsters.map((m) => fx.damage(m.id, amount, formula, { damageType: "fire" }));
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
    execute(ctx) {
      const target = ctx.target as { id: string } | undefined;
      if (!target) return [];
      return [fx.stunMonster(target.id, 30, 50)];
    },
  },
  {
    kind: "active",
    id: "lightning_bolt",
    name: "Zero-Day Strike",
    blurb: "A precision strike through an unpatched vulnerability — rolls d20 + magic to hit; deals magic × d8 damage on hit.",
    icon: "cpu-shot",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as MonsterSnapshot;
      const mag = ctx.caster.magic_mod;
      const amount = rollSum(ctx.roll, Math.max(1, mag), 8);
      return [fx.attackRollDamage(monster.id, mag, amount, `${Math.max(1, mag)}d8`, "lightning")];
    },
  },
  {
    kind: "active",
    id: "mage_armor",
    name: "Encapsulate",
    blurb: "Wrap an ally in a protective abstraction layer — grants 3d6 + magic shield.",
    icon: "energy-shield",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as FighterSnapshot;
      const amount = rollSum(ctx.roll, 3, 6) + ctx.caster.magic_mod;
      return [fx.shield(target.id, amount)];
    },
  },
  {
    kind: "passive",
    id: "mana_font",
    name: "Mana Font",
    blurb: "An always-on background process — quietly regenerates 1 mana every 3 turns.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
];
