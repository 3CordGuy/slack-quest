// Reusable AbilityEffect constructors. Import `fx` in any class ability file
// to build effects without repeating the discriminant strings.
//
// Usage: return [fx.damage(monster.id, amount, formula), fx.heal(caster.id, 5)]

import type { AbilityEffect } from "../abilities";

export const fx = {
  // Deal damage to a monster (bypasses armor). Pass drink_buff_context:
  // "ability" to allow Lucky Sip crit buffs to apply.
  damage(
    targetId: string,
    amount: number,
    formula: string,
    opts?: { isCrit?: boolean; drinkBuff?: "ability" },
  ): AbilityEffect {
    return {
      kind: "deal_damage",
      target_id: targetId,
      amount,
      formula,
      is_crit: opts?.isCrit,
      drink_buff_context: opts?.drinkBuff,
    };
  },

  heal(targetId: string, amount: number): AbilityEffect {
    return { kind: "heal", target_id: targetId, amount };
  },

  shield(targetId: string, amount: number): AbilityEffect {
    return { kind: "grant_shield", target_id: targetId, amount };
  },

  shieldAll(amount: number): AbilityEffect {
    return { kind: "grant_shield_all", amount };
  },

  stunMonster(targetId: string, breakPctPerTurn: number, bossBreakPctPerTurn?: number): AbilityEffect {
    return { kind: "stun_monster", target_id: targetId, break_pct_per_turn: breakPctPerTurn, boss_break_pct_per_turn: bossBreakPctPerTurn };
  },

  restoreMana(targetId: string, amount: number): AbilityEffect {
    return { kind: "restore_mana", target_id: targetId, amount };
  },

  taunt(actorId: string, swings: number): AbilityEffect {
    return { kind: "set_taunt", actor_id: actorId, swings };
  },

  vanish(actorId: string, swings: number): AbilityEffect {
    return { kind: "set_vanish", actor_id: actorId, swings };
  },

  battleHymn(charges: number): AbilityEffect {
    return { kind: "add_battle_hymn", charges };
  },

  foreseeTurns(turns: number): AbilityEffect {
    return { kind: "set_foresee_turns", turns };
  },

  moveFighter(targetId: string, to: "front" | "back"): AbilityEffect {
    return { kind: "move_fighter", target_id: targetId, to };
  },
};

// Roll count dice of `sides` and return the sum.
export function rollSum(
  roll: (sides: number) => number,
  count: number,
  sides: number,
): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += roll(sides);
  return total;
}
