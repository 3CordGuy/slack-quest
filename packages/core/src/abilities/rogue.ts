import type { AbilityDef } from "../abilities";
import type { MonsterSnapshot } from "../abilities";
import { fx } from "./effects";

export const rogueAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "lethal_strikes",
    name: "Lethal Strikes",
    blurb: "Critical hits apply 2 + floor(lev/2) stacks of bleed.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "active",
    id: "vanish",
    name: "Vanish",
    blurb: "Become untargetable for 2 rounds. Attacking while obscured auto-crits on hit.",
    icon: "abstract-006",
    mana_cost: 2,
    routing: "utility",
    target: "self",
    execute(ctx) {
      return [fx.vanish(ctx.caster.id, 2)];
    },
  },
  {
    kind: "active",
    id: "envenom_weapon",
    name: "Envenom Weapon",
    blurb: "Apply venom to your weapon — your next 2 hits each apply 2 + lev stacks of poison.",
    icon: "vial",
    mana_cost: 1,
    routing: "utility",
    target: "self",
    execute(ctx) {
      const stacks = 2 + ctx.caster.level;
      return [fx.envenomWeapon(stacks)];
    },
  },
  {
    kind: "active",
    id: "backstab",
    name: "Backstab",
    blurb: "Attack with advantage; if it hits, roll damage twice and take the higher roll.",
    icon: "daggers",
    mana_cost: 0,
    cooldown_turns: 2,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as MonsterSnapshot;
      const wpn = Math.max(0, ctx.caster.weapon_power);
      // Roll damage twice up front; the machine resolves the hit check.
      const r1 = ctx.roll(6) + ctx.caster.attack_mod + wpn;
      const r2 = ctx.roll(6) + ctx.caster.attack_mod + wpn;
      const amount = Math.max(r1, r2);
      return [fx.attackRollDamage(monster.id, ctx.caster.attack_mod, amount, `max(${r1}, ${r2})`, undefined, true)];
    },
  },
  {
    kind: "active",
    id: "debilitate",
    name: "Debilitate",
    blurb: "Stun the target for 1 round and make it take 20% increased damage for 2 rounds.",
    icon: "crossed-swords",
    mana_cost: 1,
    cooldown_turns: 3,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as MonsterSnapshot;
      return [
        fx.stunMonster(monster.id, 100),
        fx.vulnerability(monster.id, 20, 2),
      ];
    },
  },
];
