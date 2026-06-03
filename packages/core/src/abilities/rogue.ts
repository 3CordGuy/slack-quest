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
      const rank = ctx.rank ?? 1;
      // R1 = 2 swings, R2 = 3 swings, R3 = 4 swings.
      const swings = rank >= 3 ? 4 : rank >= 2 ? 3 : 2;
      return [fx.vanish(ctx.caster.id, swings)];
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
      const rank = ctx.rank ?? 1;
      // R1 = 2 + lev stacks, R2 = +1 stacks, R3 = +2 stacks.
      // (Charges per cast is fixed at 2 by the envenom_weapon effect kind;
      // bumping the charges would need a new fx signature — deferred.)
      const bump = rank >= 3 ? 2 : rank >= 2 ? 1 : 0;
      const stacks = 2 + ctx.caster.level + bump;
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
    range_tiles: 1, // up-close knife work
    aoe_radius_tiles: 0, // surgical single-target strike
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as MonsterSnapshot;
      const totalMod = ctx.caster.attack_mod + Math.max(0, ctx.caster.weapon_power);
      const raw1 = ctx.roll(6);
      const raw2 = ctx.roll(6);
      const bestRaw = Math.max(raw1, raw2);
      const isCrit = bestRaw === 6;
      // R1 ×1, R2 ×1.25, R3 ×1.5.
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const baseAmount = (bestRaw + totalMod) * (isCrit ? 2 : 1);
      const amount = Math.round(baseAmount * mult);
      const formula = `max(${raw1},${raw2})+${totalMod}${isCrit ? " ×2" : ""}${rank > 1 ? `×${mult}` : ""}`;
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
    range_tiles: 2, // close-range disruption
    aoe_radius_tiles: 0, // single-target disrupt
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as MonsterSnapshot;
      // R1 = 20% / 2 rounds, R2 = 30% / 2 rounds, R3 = 40% / 3 rounds.
      const magnitude = rank >= 3 ? 40 : rank >= 2 ? 30 : 20;
      const rounds = rank >= 3 ? 3 : 2;
      return [
        fx.stunMonster(monster.id, 100),
        fx.vulnerability(monster.id, magnitude, rounds),
      ];
    },
  },
];
