// Reusable AbilityEffect constructors. Import `fx` in any class ability file
// to build effects without repeating the discriminant strings.
//
// Usage: return [fx.damage(monster.id, amount, formula), fx.heal(caster.id, 5)]

import type { AbilityEffect, AllyNpcSpec } from "../abilities";
import type { DamageType } from "../flavor";

export const fx = {
  // Deal damage to a monster (bypasses armor). Pass drink_buff_context:
  // "ability" to allow Lucky Sip crit buffs to apply.
  damage(
    targetId: string,
    amount: number,
    formula: string,
    opts?: { isCrit?: boolean; drinkBuff?: "ability"; damageType?: DamageType },
  ): AbilityEffect {
    return {
      kind: "deal_damage",
      target_id: targetId,
      amount,
      formula,
      is_crit: opts?.isCrit,
      drink_buff_context: opts?.drinkBuff,
      damage_type: opts?.damageType,
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

  encourage(targetId: string, charges: number): AbilityEffect {
    return { kind: "grant_encourage", target_id: targetId, charges };
  },

  discourage(targetId: string, charges: number): AbilityEffect {
    return { kind: "apply_discourage", target_id: targetId, charges };
  },

  shieldOfFaith(rounds: number): AbilityEffect {
    return { kind: "apply_shield_of_faith", rounds };
  },

  protect(targetId: string): AbilityEffect {
    return { kind: "apply_protect", target_id: targetId };
  },

  smiteDebuff(targetId: string): AbilityEffect {
    return { kind: "apply_smite_debuff", target_id: targetId };
  },

  attackRollDamage(targetId: string, hitMod: number, amount: number, formula: string, damageType?: DamageType, advantage?: boolean, isCrit?: boolean): AbilityEffect {
    return { kind: "attack_roll_damage", target_id: targetId, hit_mod: hitMod, amount, formula, damage_type: damageType, advantage, is_crit: isCrit };
  },

  bleed(targetId: string, stacks: number, duration = 2): AbilityEffect {
    return { kind: "apply_bleed", target_id: targetId, stacks, duration };
  },

  poison(targetId: string, stacks: number, duration = 2): AbilityEffect {
    return { kind: "apply_poison", target_id: targetId, stacks, duration };
  },

  envenomWeapon(stacks: number): AbilityEffect {
    return { kind: "apply_envenom_weapon", stacks };
  },

  vulnerability(targetId: string, magnitude: number, rounds: number): AbilityEffect {
    return { kind: "apply_vulnerability", target_id: targetId, magnitude, rounds };
  },

  summonAllyNpc(spec: AllyNpcSpec, idSuffix: string): AbilityEffect {
    return { kind: "summon_ally_npc", spec, id_suffix: idSuffix };
  },

  hexMonster(targetId: string, duration: number): AbilityEffect {
    return { kind: "hex_monster", target_id: targetId, duration };
  },

  consumeMonsterBleed(targetId: string): AbilityEffect {
    return { kind: "consume_monster_bleed", target_id: targetId };
  },

  damageReduction(targetId: string, pct: number, turns: number): AbilityEffect {
    return { kind: "set_damage_reduction", target_id: targetId, pct, turns };
  },

  fighterRegen(targetId: string, magnitude: number, duration: number): AbilityEffect {
    return { kind: "apply_fighter_regen", target_id: targetId, magnitude, duration };
  },

  animalForm(targetId: string, strBonus: number, vitBonus: number, agiBonus: number, dexBonus: number, turns: number): AbilityEffect {
    return { kind: "apply_animal_form", target_id: targetId, str_bonus: strBonus, vit_bonus: vitBonus, agi_bonus: agiBonus, dex_bonus: dexBonus, turns };
  },

  barkskin(targetId: string, bonus: number, turns: number): AbilityEffect {
    return { kind: "apply_barkskin", target_id: targetId, bonus, turns };
  },

  entangleMonster(targetId: string, duration: number): AbilityEffect {
    return { kind: "entangle_monster", target_id: targetId, duration };
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
