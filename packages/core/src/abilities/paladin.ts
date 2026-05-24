import type { AbilityDef } from "../abilities";
import { fx, rollSum } from "./effects";

export const paladinAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "holy_rage",
    name: "Regression Rage",
    blurb: "Every failed regression fuels the fury — whenever you or an ally takes damage, your next attack deals +10% of that damage (stacks).",
    trigger: "on_ally_hit",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "active",
    id: "shield_of_faith",
    name: "Test Coverage",
    blurb: "No edge case goes untested — all allies gain +5 AC for 3 rounds.",
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
    blurb: "Deploy an emergency patch directly to an ally — heals 1d6 + mag/2 + vit/2. If they're your protected target, the fix propagates back to you too.",
    icon: "first-aid-kit",
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
    blurb: "Halt execution mid-swing — strike for normal + 2d8 damage; the target's next attack runs at 50% output.",
    icon: "convergence-target",
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
    blurb: "Route an ally's incoming damage through your own defenses — they take half, you absorb the rest. Or fortify yourself with 2d6 + mag/2 + vit/2 shield instead. 2-turn cooldown.",
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
