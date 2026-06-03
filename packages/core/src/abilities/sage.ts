import type { AbilityDef } from "../abilities";
import type { MonsterSnapshot, FighterSnapshot } from "../abilities";
import { fx, rollSum } from "./effects";

export const sageAbilities: AbilityDef[] = [
  {
    kind: "passive",
    id: "foretell",
    name: "Foretell",
    blurb: "Read the threat model — see monster damage rolls and intended targets before they strike.",
    trigger: "always_on",
    once_per_fight: false,
    execute: () => [],
  },
  {
    kind: "active",
    id: "ray_of_frost",
    name: "Cold Start",
    blurb: "Force the target into a cold start — slow initialization hits for {mag}d4 frost damage with a 25% chance to freeze. Spell attack (+mag to hit).",
    icon: "ice-bolt",
    mana_cost: 1,
    routing: "utility",
    target: "single_enemy",
    range_tiles: 4, // ranged frost spell
    aoe_radius_tiles: 0, // pinpoint icicle
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const monster = ctx.target as MonsterSnapshot;
      const mag = ctx.caster.magic_mod;
      const baseRoll = rollSum(ctx.roll, mag, 4);
      // R1 ×1, R2 ×1.25 dmg, R3 ×1.5 dmg + freeze chance +5% (25→30).
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const amount = Math.round(baseRoll * mult);
      const freezeChance = rank >= 3 ? 30 : 25;
      const formula = rank > 1 ? `${mag}d4×${mult}` : `${mag}d4`;
      return [fx.attackRollDamage(monster.id, mag, amount, formula, "ice", undefined, undefined, freezeChance)];
    },
  },
  {
    kind: "active",
    id: "blizzard",
    name: "Blizzard",
    blurb: "Spin up a sustained traffic spike — deals 1d6 + mag frost damage to all enemies at the end of each of your turns (10% freeze chance) for 3 turns.",
    icon: "icicles-fence",
    mana_cost: 2,
    cooldown_turns: 3,
    routing: "utility",
    target: "all_enemies",
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      // Scale per-tick magnitude. R1 ×1, R2 ×1.25, R3 ×1.5. Duration bump
      // (+1 turn at R3) deferred — apply_blizzard handler hardcodes charges:3
      // in combat_machine; would need a duration param plumbed through fx.blizzard.
      const baseMag = Math.max(1, ctx.caster.magic_mod);
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const scaledMag = Math.round(baseMag * mult);
      return [fx.blizzard(ctx.caster.id, scaledMag)];
    },
  },
  {
    kind: "active",
    id: "good_fortune",
    name: "Good Fortune",
    blurb: "Queue a green build — heal an ally for 1d4 + mag now; a second heal for double fires on your next turn.",
    icon: "crystal-ball",
    mana_cost: 1,
    cooldown_turns: 1,
    routing: "utility",
    target: "single_ally",
    execute(ctx) {
      const rank = ctx.rank ?? 1;
      const target = ctx.target as FighterSnapshot;
      const mag = ctx.caster.magic_mod;
      const baseAmount = rollSum(ctx.roll, 1, 4) + mag;
      // R1 ×1, R2 ×1.25, R3 ×1.5. Delayed heal already trails at amount × 2,
      // so both the immediate and delayed amounts scale together with rank.
      const mult = rank >= 3 ? 1.5 : rank >= 2 ? 1.25 : 1;
      const amount = Math.round(baseAmount * mult);
      return [
        fx.heal(target.id, amount),
        fx.goodFortune(ctx.caster.id, target.id, amount * 2),
      ];
    },
  },
  {
    kind: "active",
    id: "ill_omen",
    name: "Stack Overflow",
    blurb: "Let the call stack grow unchecked — curse an enemy; damage accumulates over 3 of its turns, then crashes back for 50% of the total.",
    icon: "stack",
    mana_cost: 1,
    cooldown_turns: 1,
    routing: "utility",
    target: "single_enemy",
    range_tiles: 4, // curse from across the room
    aoe_radius_tiles: 0, // single-target curse
    execute(ctx) {
      const monster = ctx.target as MonsterSnapshot;
      return [fx.illOmen(ctx.caster.id, monster.id)];
    },
  },
];
