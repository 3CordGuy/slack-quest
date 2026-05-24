import type { AbilityDef } from "../abilities";
import type { MonsterSnapshot } from "../abilities";
import { fx } from "./effects";

export const rogueAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "lethal_strikes",
    name: "Lethal Strikes",
    blurb: "Every crit leaves behind dead code — critical hits apply 2 + floor(lev/2) bleed stacks to the target.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "active",
    id: "vanish",
    name: "Vanish",
    blurb: "Kill the metrics, go dark — become untargetable for 2 rounds; attacking from the shadows auto-crits on hit.",
    icon: "cloak-dagger",
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
    name: "Malicious Payload",
    blurb: "Inject a malicious payload into their pipeline — your next 2 hits each deliver 2 + lev stacks of poison.",
    icon: "virus",
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
    blurb: "Fork the execution path and exploit the diff — attack with advantage; on hit, roll damage twice and keep the higher result.",
    icon: "daggers",
    mana_cost: 0,
    cooldown_turns: 2,
    routing: "utility",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as MonsterSnapshot;
      const totalMod = ctx.caster.attack_mod + Math.max(0, ctx.caster.weapon_power);
      const raw1 = ctx.roll(6);
      const raw2 = ctx.roll(6);
      const bestRaw = Math.max(raw1, raw2);
      const isCrit = bestRaw === 6;
      const amount = (bestRaw + totalMod) * (isCrit ? 2 : 1);
      const formula = `max(${raw1},${raw2})+${totalMod}${isCrit ? " ×2" : ""}`;
      return [fx.attackRollDamage(monster.id, ctx.caster.attack_mod, amount, formula, undefined, true, isCrit)];
    },
  },
  {
    kind: "active",
    id: "debilitate",
    name: "Debilitate",
    blurb: "SIGSTOP the process — stun the target for 1 round and expose a vulnerability (+20% damage taken for 2 rounds).",
    icon: "knocked-out-stars",
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
