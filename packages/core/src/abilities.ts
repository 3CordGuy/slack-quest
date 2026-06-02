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
  | "on_kill"       // after any monster dies — passive's nearby_radius_tiles (if set) filters by hex distance from caster to dying monster
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
  // Full item power of an equipped focus weapon (wand/staff/codex); 0 otherwise.
  // Added to heal and single-target shield amounts by the combat machine.
  focus_power: number;
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
  // Active status effects. Structurally compatible with MachineStatusEffect[]
  // so the machine can pass CombatMonster.effects directly without mapping.
  effects?: ReadonlyArray<{ type: string; magnitude: number; remaining: number }>;
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
  // Talent rank of this ability for this caster (1, 2, or 3). Defaults to 1
  // when the caster has not unlocked higher ranks. execute() reads this to
  // scale potency / duration / add capstone effects.
  rank?: number;
}

// Minimal spec for an ally NPC summoned into combat via summon_ally_npc.
// The machine creates a full CombatFighter from this; no class abilities,
// no mana. Stats are caller-supplied (typically derived from the caster's level).
export interface AllyNpcSpec {
  name: string;
  class_label: string;
  level: number;
  hp: number;
  attack_mod: number;
  weapon_power: number;
  position: "front" | "back";
  weapon_range: "melee" | "ranged";
  damage_roll?: string;
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
      damage_type?: DamageType;
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
  // Activate the bard's battle hymn for N rounds.
  | { kind: "add_battle_hymn"; rounds: number }
  // Move a fighter to a different row.
  | { kind: "move_fighter"; target_id: string; to: "front" | "back" }
  // Summon an ally NPC into the fight. The machine generates a unique ID from
  // id_suffix + caster id, adds the NPC to fighters and turn_order, and emits
  // an ally_npc_summoned event. The NPC acts as an auto-resolved fighter each
  // turn (same as a merc): d20 to-hit, d6 damage, targets lowest-HP monster.
  | { kind: "summon_ally_npc"; spec: AllyNpcSpec; id_suffix: string }
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
  | { kind: "apply_ill_omen"; caster_id: string; target_id: string }
  | { kind: "apply_vulnerability"; target_id: string; magnitude: number; rounds: number }
  // Apply the hexed debuff to a monster for `duration` of the monster's own
  // turns. While hexed: -25% damage output; takes 3 bleed stacks whenever it
  // takes damage from any source.
  | { kind: "hex_monster"; target_id: string; duration: number }
  // Remove all bleed stacks from the target monster (e.g. Forbidden SQL).
  // Return a separate deal_damage effect to deal damage based on consumed stacks.
  | { kind: "consume_monster_bleed"; target_id: string }
  // Reduce incoming damage for the target fighter by pct% for the next N of
  // their own turns. pct is an integer (e.g. 20 = 20%).
  | { kind: "set_damage_reduction"; target_id: string; pct: number; turns: number }
  // Apply a regen (HoT) status effect to a fighter for `duration` of their own turns.
  | { kind: "apply_fighter_regen"; target_id: string; magnitude: number; duration: number }
  // Apply Animal Form stat bonuses to a fighter for `turns` of their own turns.
  // Also stores derived attack_mod delta and max_hp delta for reversion on expiry.
  | { kind: "apply_animal_form"; target_id: string; str_bonus: number; vit_bonus: number; agi_bonus: number; dex_bonus: number; turns: number }
  // Buff the target fighter's AC by `bonus` for `turns` of their own turns.
  | { kind: "apply_barkskin"; target_id: string; bonus: number; turns: number }
  // Apply the "entangled" debuff to a monster (-4 to-hit) for `duration` monster turns.
  | { kind: "entangle_monster"; target_id: string; duration: number }
  // SRE Warden — Taunt Fortify: all incoming damage routes through armor for N of the warden's turns.
  | { kind: "apply_taunt_fortify"; target_id: string; turns: number }
  // SRE Warden — grant shield equal to floor((armor_power + resilient_bonus) * fraction).
  // Machine resolves the live effective armor at application time.
  | { kind: "grant_shield_from_armor"; target_id: string; fraction: number }
  // Frontend Bard — Encore: clear every active ability cooldown the target ally
  // is currently sitting on. Target acquires the freedom to immediately re-cast
  // anything that was gated. No-op if the target has no cooldowns.
  | { kind: "reset_cooldowns"; target_id: string }
  // Frontend Bard — Unsubscribe from All: strip every buff-typed status
  // effect (regen, barkskin, animal_form, empowered) from every enemy. Debuffs
  // are left intact (use cleanse_ally_debuffs for the inverse).
  | { kind: "dispel_enemy_buffs" }
  // Frontend Bard — Unsubscribe from All R2 (reserved): wipe every debuff-typed
  // effect (bleeding, poisoned, burning, stunned, frozen, shocked, hexed,
  // entangled) from every ally. Buffs are left intact.
  | { kind: "cleanse_ally_debuffs" }
  // Data Warlock — Drop Table: pay HP instead of mana. Reduces the caster's
  // current HP by amount, bypassing shield + armor (it's a self-sacrifice
  // cost, not damage). Floors at 1 HP so the cast can't be lethal.
  | { kind: "deduct_caster_hp"; caster_id: string; amount: number }
  // QA Paladin — Code Review: strip every negative status effect from one
  // specific ally. Targeted version of cleanse_ally_debuffs. The cleanse
  // semantics (which effect types count as "negative") match the field-wide
  // cleanse handler for consistency.
  | { kind: "cleanse_single_ally"; target_id: string };

export interface ActiveAbilityDef {
  kind: "active";
  id: string;
  name: string;
  blurb: string;
  // rpg-awesome ra-* icon name (no prefix).
  icon: string;
  mana_cost: number;
  // If set, the ability goes on cooldown for this many of the caster's own
  // turns after use, preventing reuse until the cooldown expires.
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
  // Optional hex-range override. When unset, the ability inherits the
  // caster's weapon range (see `deriveRangeTiles` in hex.ts). Set this for
  // abilities whose effective reach differs from the weapon — e.g. a melee
  // fighter's special area shout, or a focused incantation with shorter
  // reach than a normal cast. AoE abilities ignore this (they fire on all
  // valid targets regardless of position).
  range_tiles?: number;
  // Optional blast radius in hex tiles.
  //
  // For single-target abilities (target: "single_enemy"/"single_ally"), the
  // blast is centered on the picked target and damages every other live
  // enemy within this many hexes of it. The primary takes full damage from
  // execute(); secondaries take an additional damage instance equal to the
  // primary's damage (the engine applies per-target as it iterates):
  //
  //   aoe_radius_tiles: 1 → primary + adjacent enemies
  //   aoe_radius_tiles: 2 → primary + everyone within 2 hexes
  //   aoe_radius_tiles: 0 (or unset) → primary only
  //
  // For "all_enemies" / "all_allies" routing the blast is centered on the
  // CASTER instead — only targets within this many hexes of the caster are
  // hit (e.g. Prod Fire only burns enemies within 3 hexes of the mage).
  // When unset on an all_* ability, every live target on the field is hit.
  //
  // The hex grid UI paints the blast radius around the aim point during
  // aim mode so the player sees who'll be hit.
  aoe_radius_tiles?: number;
  execute: (ctx: AbilityContext) => AbilityEffect[];
}

export interface PassiveAbilityDef {
  kind: "passive";
  id: string;
  name: string;
  blurb: string;
  // Optional rpg-awesome / SVG icon name. Display-only — surfaced in the
  // talent tree and character-sheet ability lists. UI sites fall back to a
  // generic placeholder when omitted (matches the existing Druid Primal
  // Strikes / Bard Bardic Aura / Warden passives which had no icon).
  icon?: string;
  trigger: PassiveTrigger;
  once_per_fight: boolean;
  // For on_kill passives: optional hex-distance filter from caster to dying
  // monster. When set, the passive only fires if the kill happens within
  // this many hexes (Manhattan distance). Omit to fire on any kill on the
  // field (Garbage Collection-style); set to 2 for "nearby kill" semantics
  // (Stale Cache-style). No effect for other trigger kinds.
  nearby_radius_tiles?: number;
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
