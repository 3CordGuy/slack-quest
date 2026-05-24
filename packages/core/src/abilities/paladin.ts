import type { AbilityDef } from "../abilities";
import { fx, rollSum } from "./effects";

export const paladinAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "holy_rage",
    name: "Regression Rage",
    blurb: "Whenever you or an ally takes damage, your next attack deals +10% of that damage (stacks).",
    trigger: "on_ally_hit",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "active",
    id: "shield_of_faith",
    name: "Test Coverage",
    blurb: "Increase the AC of all allies by 5 for 3 rounds.",
    icon: "round-shield",
    mana_cost: 2,
    routing: "utility",
    target: "all_allies",
    execute() {
      return [fx.shieldOfFaith(3)];
    },
  },
  {
    kind: "active",
    id: "lay_on_hands",
    name: "Hotfix",
    blurb: "Heal an ally for 1d6 + mag/2 + vit/2. If the target is your protected ally, also heal yourself for the same amount.",
    icon: "hand",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as { id: string };
      const vit = ctx.caster.stats?.vit ?? 5;
      const healAmt = ctx.roll(6) + Math.floor(ctx.caster.magic_mod / 2) + Math.floor(vit / 2);
      const effects = [fx.heal(target.id, healAmt)];
      if (ctx.protected_ally_id === target.id) {
        effects.push(fx.heal(ctx.caster.id, healAmt));
      }
      return effects;
    },
  },
  {
    kind: "active",
    id: "smite",
    name: "Breakpoint",
    blurb: "Strike for normal + 2d8 extra damage. Enemy deals 50% less damage on their next swing.",
    icon: "axe-swing",
    mana_cost: 1,
    cooldown_turns: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const baseDmg = ctx.roll(6) + ctx.caster.attack_mod + wpn;
      const extraDmg = rollSum(ctx.roll, 2, 8);
      const formula = `1d6 + ${ctx.caster.attack_mod}a + ${wpn}w + 2d8`;
      return [
        fx.damage(monster.id, baseDmg + extraDmg, formula, { drinkBuff: "ability" }),
        fx.smiteDebuff(monster.id),
      ];
    },
  },
  {
    kind: "active",
    id: "protect",
    name: "Protect",
    blurb: "Target an ally: they take half damage, you absorb the other half. Target yourself instead to gain 2d6 + mag/2 + vit/2 shield. 2-turn cooldown.",
    icon: "crowned-heart",
    mana_cost: 0,
    cooldown_turns: 2,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const target = ctx.target as { id: string };
      if (target.id === ctx.caster.id) {
        const vit = ctx.caster.stats?.vit ?? 5;
        const shieldAmt = rollSum(ctx.roll, 2, 6) + Math.floor(ctx.caster.magic_mod / 2) + Math.floor(vit / 2);
        return [fx.shield(ctx.caster.id, shieldAmt)];
      }
      return [fx.protect(target.id)];
    },
  },
];
