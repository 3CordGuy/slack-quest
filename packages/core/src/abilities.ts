// Unified ability system. Each class has an abilities[] array of AbilityDef —
// either active (player-invoked, costs mana, shows a UI button) or passive
// (auto-fires on a trigger). Replaces the legacy SIGNATURES / PASSIVES /
// ABILITIES maps in flavor.ts.

export type TargetKind =
  | "self"
  | "single_enemy"
  | "single_ally"
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
  // Apply a stun to the targeted monster. Break chance accumulates 30% per
  // elapsed monster turn; guaranteed on the 4th turn.
  | { kind: "stun_monster"; target_id: string }
  // Restore mana to a specific fighter (Mana Font passive).
  | { kind: "restore_mana"; target_id: string; amount: number }
  // Lock monster targeting onto actor_id for N swings (taunt).
  | { kind: "set_taunt"; actor_id: string; swings: number }
  // Make actor untargetable for N swings (vanish).
  | { kind: "set_vanish"; actor_id: string; swings: number }
  // Add N charged attacks to the bard's battle hymn counter.
  | { kind: "add_battle_hymn"; charges: number }
  // Show full battle intel for N of the sage's own turns (foresee).
  | { kind: "set_foresee_turns"; turns: number }
  // Move a fighter to a different row.
  | { kind: "move_fighter"; target_id: string; to: "front" | "back" };

export interface ActiveAbilityDef {
  kind: "active";
  id: string;
  name: string;
  blurb: string;
  // rpg-awesome ra-* icon name (no prefix).
  icon: string;
  mana_cost: number;
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
