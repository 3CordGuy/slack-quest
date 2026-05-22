// Unified ability system. Each class has an abilities[] array of AbilityDef —
// either active (player-invoked, costs mana, shows a UI button) or passive
// (auto-fires on a trigger). Replaces the legacy SIGNATURES / PASSIVES /
// ABILITIES maps in flavor.ts.

import type { DamageType } from "./flavor";
import type { Stats } from "./stats";

export type TargetKind =
  | "self"
  | "single_enemy"
  | "single_ally"
  | "any"           // fighter or monster — execute sees ctx.target as either type
  | "all_allies"
  | "all_enemies";

// When a passive ability checks in. The machine calls passive execute functions
// at these points; once_per_fight passives are skipped after their first fire.
export type PassiveTrigger =
  | "on_action"     // at the start of this fighter's own turn (druid regen, warden shield)
  | "on_ally_hit"   // after any ally takes damage from a monster swing
  | "on_crit"       // after this fighter scores a critical hit
  | "always_on";    // continuous modifier managed inline by the machine (bard aura, sage reading, mana font, rogue first strike)

// Minimal fighter/monster views injected into execute functions. Structurally
// compatible with CombatFighter / CombatMonster so the machine can pass them
// directly without mapping, but defined here with no import from the machine
// to avoid a circular dependency.
export interface FighterSnapshot {
  id: string;
  class: string;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  armor_power: number;
  weapon_power: number;
  attack_mod: number;
  magic_mod: number;
  level: number;
  position: "front" | "back";
  // Primary stats — present on STATS_V2 fighters; absent on legacy combats.
  stats?: Stats;
}

export interface MonsterSnapshot {
  id: string;
  hp: number;
  max_hp: number;
  tier: number;
  shield: number;
}

export interface AbilityContext {
  caster: FighterSnapshot;
  // Alive party members (hp > 0) at the time of execution.
  party: FighterSnapshot[];
  // Alive monsters (hp > 0) at the time of execution.
  monsters: MonsterSnapshot[];
  // For single-target abilities: the chosen target. Undefined for self/AoE.
  target?: FighterSnapshot | MonsterSnapshot;
  roll: (sides: number) => number;
  // For position-changing abilities (migrate): the requested destination row.
  // Injected from the action payload by the engine.
  position?: "front" | "back";
  // Injected for Paladin Lay on Hands: the ID of the ally currently under Protect,
  // if the caster is the active protector. Undefined otherwise.
  protected_ally_id?: string;
}

// Effects returned by execute(). The machine applies each one in sequence.
export type AbilityEffect =
  // Deal damage to a specific monster (bypasses armor, like the old signatures).
  // drink_buff_context triggers drink-buff logic in the machine if set.
  | {
      kind: "deal_damage";
      target_id: string;
      amount: number;
      formula: string;
      is_crit?: boolean;
      drink_buff_context?: "ability";
    }
  // Restore HP to a fighter.
  | { kind: "heal"; target_id: string; amount: number }
  // Add shield to a specific fighter (capped to max).
  | { kind: "grant_shield"; target_id: string; amount: number }
  // Grant shield to every alive party member (regression shield).
  | { kind: "grant_shield_all"; amount: number }
  // Apply a stun to the targeted monster. Break chance accumulates
  // break_pct_per_turn per elapsed monster turn; guaranteed on the turn where
  // the cumulative chance reaches 100%. Boss targets use boss_break_pct_per_turn
  // if provided, falling back to break_pct_per_turn.
  | { kind: "stun_monster"; target_id: string; break_pct_per_turn: number; boss_break_pct_per_turn?: number }
  // Restore mana to a specific fighter (Mana Font passive).
  | { kind: "restore_mana"; target_id: string; amount: number }
  // Lock monster targeting onto actor_id for N swings (taunt).
  | { kind: "set_taunt"; actor_id: string; swings: number }
  // Make actor untargetable for N swings (vanish).
  | { kind: "set_vanish"; actor_id: string; swings: number }
  // Add N charged attacks to the bard's battle hymn counter.
  | { kind: "add_battle_hymn"; charges: number }
  // Move a fighter to a different row.
  | { kind: "move_fighter"; target_id: string; to: "front" | "back" }
  // Grant advantage charges to a fighter: next N to-hit d20 rolls twice, take higher.
  | { kind: "grant_encourage"; target_id: string; charges: number }
  // Apply disadvantage charges to a monster: next N to-hit d20 rolls twice, take lower.
  | { kind: "apply_discourage"; target_id: string; charges: number }
  // QA Paladin — Shield of Faith: all allies gain +5 AC for N rounds.
  | { kind: "apply_shield_of_faith"; rounds: number }
  // QA Paladin — Protect: caster will absorb half of target's incoming HP damage.
  | { kind: "apply_protect"; target_id: string }
  // QA Paladin — Smite debuff: target monster deals 50% damage on its next swing.
  | { kind: "apply_smite_debuff"; target_id: string }
  // Weapon attack with machine-side d20 hit check; emits roll + hit_check events.
  // If advantage is true, the d20 is rolled twice and the higher value is used.
  // freeze_chance: if set and the attack hits, machine rolls d100 — if ≤ freeze_chance, applies frozen.
  | { kind: "attack_roll_damage"; target_id: string; hit_mod: number; amount: number; formula: string; damage_type?: DamageType; advantage?: boolean; is_crit?: boolean; freeze_chance?: number }
  // Rogue Lethal Strikes — apply bleeding to a monster.
  | { kind: "apply_bleed"; target_id: string; stacks: number; duration: number }
  // Rogue Envenom Weapon — apply poison to a monster.
  | { kind: "apply_poison"; target_id: string; stacks: number; duration: number }
  // Rogue Envenom Weapon — mark the caster's weapon as envenomed; next hit applies poison.
  | { kind: "apply_envenom_weapon"; stacks: number }
  // Rogue Debilitate — target monster takes +magnitude% damage for N rounds.
  | { kind: "apply_vulnerability"; target_id: string; magnitude: number; rounds: number }
  // Staff Sage — Blizzard: store AoE storm state; damage fires end-of-caster-turn for 3 turns.
  | { kind: "apply_blizzard"; caster_id: string; mag: number }
  // Staff Sage — Good Fortune: store a delayed double-heal for the caster's next turn.
  | { kind: "apply_good_fortune"; caster_id: string; target_id: string; delayed_amount: number }
  // Staff Sage — Ill Omen: mark a monster for damage tracking; burst fires on monster's 3rd turn.
  | { kind: "apply_ill_omen"; caster_id: string; target_id: string };

export interface ActiveAbilityDef {
  kind: "active";
  id: string;
  name: string;
  blurb: string;
  // rpg-awesome ra-* icon name (no prefix).
  icon: string;
  mana_cost: number;
  // If set, the ability has no mana cost but goes on cooldown for this many
  // of the caster's own turns after use. mana_cost should be 0 when set.
  cooldown_turns?: number;
  target: TargetKind;
  // How the engine routes this ability:
  //   "damage"     — single-target damage (drink buffs, shocked amp, elemental proc, bleed apply)
  //   "aoe_damage" — hits all live monsters at once (no per-target modifiers)
  //   "utility"    — effects are applied generically from execute()'s AbilityEffect[]
  routing: "damage" | "aoe_damage" | "utility";
  // Whether this ability needs a migrate-style position picker in addition to
  // a target picker. Currently only Druid's Migrate needs this.
  needs_position_picker?: boolean;
  execute: (ctx: AbilityContext) => AbilityEffect[];
}

export interface PassiveAbilityDef {
  kind: "passive";
  id: string;
  name: string;
  blurb: string;
  trigger: PassiveTrigger;
  once_per_fight: boolean;
  // Optional guard: passive fires only when this returns true.
  condition?: (ctx: AbilityContext) => boolean;
  // For always_on passives this can be a no-op — the machine handles them
  // inline. For on_action / on_ally_hit / on_crit passives the machine calls
  // this and applies the returned effects.
  execute: (ctx: AbilityContext) => AbilityEffect[];
}

export type AbilityDef = ActiveAbilityDef | PassiveAbilityDef;

export function activeAbilities(abilities: AbilityDef[]): ActiveAbilityDef[] {
  return abilities.filter((a): a is ActiveAbilityDef => a.kind === "active");
}

export function passiveAbilities(abilities: AbilityDef[]): PassiveAbilityDef[] {
  return abilities.filter((a): a is PassiveAbilityDef => a.kind === "passive");
}
