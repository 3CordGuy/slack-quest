// Web-mode turn-based combat state machine.
//
// Slack combat is cooldown-paced and stateless per /sq command — this module
// is NOT used there. The Slack worker continues to use the helpers in
// combat.ts directly.
//
// This machine is for the web app: rolled initiative, strict turn order, one
// action at a time, with each step emitting a stream of events that the UI
// animates (dice landing, damage chip-down, monster strike, victory).
//
// Pure: no D1, no fetch, no time. RNG is injected so tests are deterministic
// and the QuestRoom Durable Object can persist state confidently across
// hibernation.
//
// Reuses the math in combat.ts (resolvePlayerHit, resolveMonsterHit, etc.) so
// damage formulas stay identical to Slack.

import {
  applyDamageWithShield,
  isBossPhaseTransition,
  pickMonsterTarget,
  positionDamageMod,
  resolveHeal,
  resolveMonsterHit,
  resolvePlayerHit,
  type BattlePosition,
} from "./combat";
import {
  ELEMENT_META,
  ELEMENT_PROC_RATE,
  SHIELD_CAP_MULTIPLIER,
  classByName,
  type AbilityId,
  type DamageType,
  type DrinkBuff,
  type EffectType,
  type ElementType,
  type Rarity,
  type WeaponRange,
} from "./flavor";
import { type AbilityContext, type AbilityEffect, type ActiveAbilityDef, type AllyNpcSpec } from "./abilities";
import { deriveArmorBonus, deriveCritBonus, deriveDodgeChance, deriveInitiativeBonus, type Stats } from "./stats";

export type ActorId = string;
export const MONSTER_ID: ActorId = "__monster__";
export const isMonsterActor = (id: ActorId): boolean => id === MONSTER_ID || id.startsWith("__monster_");
// Merc IDs are "__merc_<hiring_user_id>__". Auto-resolved by the server; never
// sent by web clients directly.
export const isMercActor = (id: ActorId): boolean => id.startsWith("__merc_");
// Ally NPC IDs: "__merc_*" (hired mercs) or "__ally_*" (ability-summoned NPCs).
// Use isAllyNpcActor for all combat turn dispatch; use isMercActor only for
// merc-specific logic (hire/dismiss, reward filtering).
export const isAllyNpcActor = (id: ActorId): boolean => id.startsWith("__merc_") || id.startsWith("__ally_");

export interface MachineStatusEffect {
  type: EffectType;
  magnitude: number;
  remaining: number;
  source?: string;
  // Display string rendered verbatim in the status pill suffix (e.g. "30% break").
  // Only set for effects that need custom pill text; others fall back to "${remaining}t".
  pill_suffix?: string;
}

// Snapshot of a party member at combat start. Loaded from D1 once when the
// quest enters web combat mode; the machine mutates this in place across
// turns. Equipment-derived numbers (weapon_power, armor_power, etc.) are
// frozen here so combat doesn't have to re-resolve inventory mid-turn.
export interface CombatFighter {
  id: ActorId;             // user_id
  name: string;
  class: string;
  level: number;
  // Slack display handle ("josh"). Snapshot at combat start; null if the
  // player hasn't issued a slash command since the column was added.
  slack_username?: string | null;
  hp: number;
  max_hp: number;
  mana: number;
  max_mana: number;
  shield: number;
  position: BattlePosition;
  attack_mod: number;
  magic_mod: number;
  // weapon_power contributes to attack/cast/sig damage. For melee/ranged this is
  // the full item power; for focus weapons it is floor(item_power/4) — enough to
  // make attacks functional without competing with melee/ranged damage output.
  weapon_power: number;
  focus_power: number;
  // Equipped weapon range. Used to gate back-row attack (only ranged/focus
  // can melee from the back row in a party fight).
  weapon_range: WeaponRange;
  armor_power: number;
  damage_roll?: string;
  initiative: number;      // rolled at begin
  effects: MachineStatusEffect[];
  scars: string[];         // battle scars from defeats
  // Primary stats (Phase 1 / STATS_V2). Present when the flag is on; absent
  // on legacy combats so older persisted states deserialise without a schema bump.
  stats?: Stats;
  // Elemental weapon affinity. undefined = no element or focus weapon.
  element?: ElementType;
  // Rarity of the equipped main-hand weapon. Used to gate proc rates.
  weapon_rarity?: "uncommon" | "rare" | "epic" | "legendary";
  // Summed gear resistance by damage type. Capped to 0–75 at combat init.
  // Absent keys = 0% resistance. physical is included but not used (armor handles it).
  resistances?: Partial<Record<DamageType, number>>;
}

export interface GauntletWaveSpec {
  name: string;
  max_hp: number;
}

export interface CombatMonster {
  id: ActorId;
  name: string;
  hp: number;
  max_hp: number;
  // Depletable armor pool. Physical player attacks deplete it before hitting HP;
  // cast/signature/magic attacks bypass it entirely. Starts at `tier` by default.
  shield: number;
  tier: number;
  initiative: number;      // rolled at begin
  effects: MachineStatusEffect[];
  is_boss: boolean;
  boss_phase: 1 | 2;
  // Gauntlet wave state. Set only when the quest variant is "gauntlet";
  // undefined for standard / boss combats. `wave` is 1-indexed. On the
  // current monster's death, the engine pops the next entry from
  // `upcoming_waves` and continues combat (same turn order + initiative)
  // instead of emitting victory. Combat ends only when all waves are
  // cleared.
  wave?: number;
  total_waves?: number;
  upcoming_waves?: GauntletWaveSpec[];
  // Tower-only display value (absolute floor 1, 2, … 11, 12, …). Set when
  // the quest variant is "tower" so the combat header can render
  // "Floor N · Cycle M". The engine doesn't use it for any mechanics; it's
  // pure pass-through to the UI.
  tower_floor?: number;
  tower_cycle?: number;
  // Optional flux-1-schnell portrait URL from the scene. Surfaced to the UI
  // so the combat page can render the same image as the active-quest card.
  art_url?: string;
  // Elemental affinities — assigned at combat init by rollMonsterElementAffinity.
  // weakness: proc magnitude/duration boosted; resistance: 50% chance to block proc.
  element_weakness?: ElementType;
  element_resistance?: ElementType;
  // Damage-type routing for this monster's attacks. undefined defaults to "physical".
  // Determines whether armor or gear resistance applies when the monster hits a fighter.
  attack_damage_type?: DamageType;
  damage_roll?: string;
  // Player damage type weaknesses/resistances (separate from elemental proc affinities).
  // weakness: player deals +30% to this monster with matching type.
  // resistance: player deals −30% with matching type.
  damage_weakness?: DamageType;
  damage_resistance?: DamageType;
}

export type CombatStatus = "pending" | "active" | "victory" | "defeat" | "fled";

export interface CombatState {
  fighters: CombatFighter[];
  // Multi-monster array (Phase 3). Dead monsters remain in the array with hp<=0
  // until the combat ends so the turn-order index stays stable.
  monsters: CombatMonster[];
  // Deprecated: single-monster field kept for backward-compat with persisted
  // DO states created before Phase 3. upgradeCombatState() populates `monsters`
  // from this when deserializing old states.
  monster?: CombatMonster;
  // Turn order is the actor IDs sorted by initiative descending. The current
  // turn is turn_order[turn_index % turn_order.length]; round increments when
  // we wrap.
  turn_order: ActorId[];
  turn_index: number;
  round: number;
  status: CombatStatus;
  // Per-fighter total damage dealt to the monster across this combat. Drives
  // contribution-proportional spoils on victory. Updated on every player_hit
  // (only fighters appear here; the monster doesn't accumulate contribution).
  contribution: Record<ActorId, number>;
  // Per-fighter stats accumulator for end-of-combat breakdown display.
  stats: Record<ActorId, {
    damage_taken: number;
    healing_done: number;
    shielding_done: number;
    kills: number;
  }>;
  // Active class abilities write transient buffs/debuffs here. Each field
  // counts down on use; absence means inactive. Persists across rounds until
  // exhausted or combat ends.
  ability_state?: AbilityRuntimeState;
  // Once-per-fight passives that have already fired, keyed by fighter id.
  // Always-on passives (Bard aura, Druid regen, Warlock crit-bleed, Sage info)
  // don't appear here — they don't burn out.
  passives_used?: Record<ActorId, string[]>;
  // Per-fighter action count for the current fight. Used by periodic passives
  // like Mana Font (1 mana every 3 actions). Resets at combat start.
  action_counters?: Record<ActorId, number>;
  // Cooldown tracking: cooldowns[fighterId][abilityId] = turns remaining.
  // Decremented when that fighter's next turn arrives; removed when it hits 0.
  cooldowns?: Record<ActorId, Record<AbilityId, number>>;
  // Pub drink buffs carried into this combat, keyed by fighter id. Seeded
  // by the DO bootstrap step from characters.drink_buff_json so a buff
  // bought in the pub before /sq quest survives into the engine-driven
  // fight. Engine consumes per-fighter on attack/cast/ability; absent
  // means no buff. Cleared (written back to D1) on combat exit. Optional
  // for backward compatibility with quests created before the unified
  // engine landed — older saved states deserialize cleanly without it.
  drink_buffs?: Record<ActorId, DrinkBuff>;
  // Anti-pile-on: tracks how many monsters have targeted each fighter in the
  // current round. Cleared when round advances. Used by pickMonsterTarget to
  // reduce the chance of multiple monsters focusing the same fighter.
  round_monster_targets?: { round: number; counts: Record<ActorId, number> };
  // Channel-broadcast idempotency for PR 4's milestone posts. Each
  // milestone key (e.g. "boss_reveal", "phase_2", "down:U123") is
  // recorded the moment the broadcast is queued so a DO crash between
  // queue and actual post can't double-broadcast on replay. Engine
  // ignores this field — the DO is the only writer/reader.
  milestones_posted?: string[];
}

// Passive tuning knobs. Mirror src/commands.ts constants in main.
const DRUID_PASSIVE_REGEN = 2;
const BARD_AURA_HYMN_BONUS = 2;

// Keys for once-per-fight passives.
const PASSIVE_WARDEN_SHIELD = "warden_shield";
const PASSIVE_ROGUE_FIRST_CRIT = "rogue_first_crit";
const PASSIVE_PALADIN_AUTO_HEAL = "paladin_auto_heal";

export interface AbilityRuntimeState {
  // SRE Warden — monster's next N swings forced to target actor_id.
  taunt?: { actor_id: ActorId; swings_remaining: number };
  // Refactor Rogue — these fighters cannot be targeted; map of actor → swings left.
  vanished?: Record<ActorId, number>;
  // Frontend Bard — Battle Hymn: aura boost active until this round.
  battle_hymn?: { expires_after_round: number };
  // Frontend Bard — Encourage: fighter's next N to-hit d20 rolls twice, take higher.
  encourage?: Record<ActorId, number>;
  // Frontend Bard — Mock: monster's next N to-hit d20 rolls twice, take lower.
  discourage?: Record<ActorId, number>;
  // Mark / focus-fire — partymates other than the marker get +MARK_BONUS
  // damage on attack/cast until `expires_after_round` is exceeded. Cleared
  // when the monster falls or a wave transition fires.
  mark?: { marked_by: ActorId; expires_after_round: number; monster_id?: string };
  // QA Paladin — Holy Rage: accumulated raw HP damage received per fighter id.
  // Bonus on next attack = floor(total * 0.1). Reset to 0 on consume.
  holy_rage?: Record<ActorId, number>;
  // QA Paladin — Shield of Faith: all allies get +5 AC until this round passes.
  shield_of_faith?: { expires_after_round: number };
  // QA Paladin — Protect: the paladin absorbs half of the protected ally's HP damage.
  paladin_protect?: { paladin_id: ActorId; target_id: ActorId };
  // QA Paladin — Smite debuff: monster → swings remaining at 50% reduced damage.
  paladin_smite_debuff?: Record<ActorId, number>;
  // Refactor Rogue — Envenom Weapon: fighter → stacks + remaining charges.
  envenomed_weapon?: Record<ActorId, { stacks: number; charges: number }>;
  // Refactor Rogue — Debilitate: monster → vulnerability until this round passes.
  vulnerable?: Record<ActorId, { expires_after_round: number; magnitude: number }>;
  // Staff Sage — Blizzard: remaining end-of-caster-turn AoE damage charges.
  blizzard?: { caster_id: ActorId; mag: number; charges: number };
  // Staff Sage — Good Fortune: pending delayed double-heal for caster's next turn.
  good_fortune?: { caster_id: ActorId; target_id: ActorId; amount: number };
  // Staff Sage — Ill Omen: per-monster damage tracker + remaining monster turns until burst.
  ill_omen?: Record<ActorId, { caster_id: ActorId; accumulated: number; monster_turns_remaining: number }>;
  // Staff Sage — Foretell: per-monster pre-rolled fighter targets so each prediction is guaranteed correct.
  foretold_targets?: Record<ActorId, ActorId>;
  // SRE Warden — Brace: incoming damage reduced by pct% for N of the fighter's own turns.
  brace?: Record<ActorId, { pct: number; turns_remaining: number }>;
  // Backend Druid — Animal Form: buffed stat deltas for N of the caster's own turns.
  // Stored so they can be cleanly reverted on expiry.
  animal_form?: Record<ActorId, { str_bonus: number; vit_bonus: number; agi_bonus: number; dex_bonus: number; atk_delta: number; hp_delta: number; turns_remaining: number }>;
  // SRE Warden — Taunt Fortify: all incoming damage routes through armor for N of the warden's own turns.
  taunt_fortify?: Record<ActorId, { turns_remaining: number }>;
  // SRE Warden — Resilient stacks: each element is the expires_after_round value for one stack.
  resilient?: Record<ActorId, number[]>;
}

// How many rounds a mark stays active. Roughly mirrors slack's 90s timer
// (which is ~2 cooldown cycles).
const MARK_ROUNDS = 2;

// Action shape submitted to step(). `actor` is required for player actions and
// must match the current turn's actor; the machine rejects out-of-turn moves.
// `monster_act` is a system action — the caller (DO) submits it when the turn
// rolls to the monster.
export type TurnAction =
  | { kind: "begin" }
  | { kind: "attack"; actor: ActorId; target_id?: ActorId }
  | { kind: "flee"; actor: ActorId }
  | { kind: "position"; actor: ActorId; to: BattlePosition }
  | { kind: "wait"; actor: ActorId }
  | { kind: "mark"; actor: ActorId; target_id?: string | null }
  | {
      kind: "ability";
      actor: ActorId;
      ability_id: AbilityId;
      // For single_enemy and soul_drain: the monster to target.
      target_id?: ActorId;
      // Used by migrate (target fighter + new position).
      target?: ActorId;
      position?: BattlePosition;
    }
  | { kind: "monster_act"; actor?: ActorId }
  // ally_npc_act covers both hired mercs (__merc_*) and ability-summoned NPCs
  // (__ally_*). The DO/client dispatches this whenever isAllyNpcActor() is true
  // for the current actor; the engine auto-resolves the turn.
  | { kind: "ally_npc_act" };

export type RollPurpose =
  | "initiative"
  | "hit_check"
  | "damage_attack"
  | "damage_monster"
  | "ability"
  | "flee_check";

// Stream of events emitted by step(). The UI animates each in sequence.
//   roll       — a die hits the table; UI shows it spinning + landing on value
//   hit_check  — d20 + mod vs target AC; UI shows HIT/MISS banner
//   player_hit — damage chipped from monster HP; UI animates the chip-down
//   monster_attack — damage chipped from fighter HP (with shield + armor breakdown)
export type CombatEvent =
  | { type: "begin"; turn_order: ActorId[]; initiatives: Record<ActorId, number> }
  | { type: "turn_start"; actor: ActorId; round: number }
  | { type: "roll"; actor: ActorId; die: string; value: number; purpose: RollPurpose }
  | {
      type: "hit_check";
      actor: ActorId;
      target: ActorId;
      roll: number;        // raw d20
      modifier: number;    // attack_mod / magic_mod / tier
      total: number;       // roll + modifier
      ac: number;          // target's defense
      hit: boolean;
    }
  | {
      type: "player_hit";
      actor: ActorId;
      target: ActorId;       // always MONSTER_ID for now
      damage: number;
      armor_absorbed: number; // monster armor absorbed before HP damage; 0 for magic/cast
      crit: boolean;
      formula: string;
      damage_type?: DamageType;
    }
  | {
      type: "monster_attack";
      actor: ActorId;
      target: ActorId;
      damage_type: DamageType;
      raw_damage: number;
      damage_after_position: number;
      // For physical hits this is damage after armor reduction.
      // For magic/elemental hits this is damage after resistance reduction.
      damage_after_mitigation: number;
      armor_reduction: number;
      resistance_reduction: number;
      shield_absorbed: number;
      hp_damage: number;
    }
  | {
      type: "monster_splash";
      damage_type: DamageType;
      targets: Array<{
        target: ActorId;
        raw_damage: number;
        damage_after_mitigation: number;
        shield_absorbed: number;
        hp_damage: number;
      }>;
    }
  | { type: "monster_dodged"; target: ActorId }
  | { type: "monster_target_blocked"; reason: "vanish" }
  | { type: "boss_phase_transition"; new_phase: 2 }
  | { type: "fighter_down"; target: ActorId }
  | { type: "monster_down"; killed_by: ActorId }
  | {
      type: "wave_transition";
      from_monster: string;     // the monster that just fell
      to_monster: string;       // the next wave's monster
      to_max_hp: number;
      new_wave: number;         // 1-indexed
      total_waves: number;
    }
  | {
      type: "heal_applied";
      actor: ActorId;
      target: ActorId;
      amount: number;        // actual HP restored (clamped to max_hp)
      rolled: number;        // amount before clamp
    }
  | {
      type: "flee_check";
      actor: ActorId;
      roll: number;
      modifier: number;
      total: number;
      dc: number;
      success: boolean;
    }
  | { type: "fled" }
  | {
      type: "position_changed";
      actor: ActorId;
      from: BattlePosition;
      to: BattlePosition;
    }
  | {
      type: "effect_tick";
      actor: ActorId;
      effect: EffectType;
      magnitude: number;
      hp_delta: number;     // signed; positive for regen, negative for DoTs
      source?: string;
    }
  | {
      type: "ability_used";
      actor: ActorId;
      ability_id: string;
      name: string;
      mana_spent: number;
    }
  | { type: "ability_taunt"; actor: ActorId; swings: number }
  | { type: "ability_containerize" }
  | {
      type: "ability_regression_shield";
      actor: ActorId;
      grants: { target: ActorId; amount: number }[];
    }
  | { type: "ability_vanish"; actor: ActorId; swings: number }
  | {
      type: "ability_soul_drain";
      actor: ActorId;
      damage: number;
      healed: number;
      roll: number;
      formula: string;
    }
  | { type: "ability_battle_hymn"; actor: ActorId; expires_after_round: number }
  | { type: "ability_encourage"; actor: ActorId; target: ActorId; charges: number }
  | { type: "ability_mock"; actor: ActorId; target: ActorId; charges: number }
  | { type: "advantage_used"; actor: ActorId; d20_a: number; d20_b: number; took: number }
  | { type: "disadvantage_used"; actor: ActorId; d20_a: number; d20_b: number; took: number }
  | {
      type: "ability_foresee";
      actor: ActorId;
      // Committed telegraph target for the primary (first upcoming) monster.
      predicted_target: ActorId | null;
      // Per-monster committed targets. Keyed by monster ID; populated for every
      // monster that will act before the sage's next turn.
      predicted_targets: Record<ActorId, ActorId>;
      // Raw damage range (pre-armor/position).
      damage_lo: number;
      damage_hi: number;
      // Net damage range after target's armor + position modifier.
      net_lo: number;
      net_hi: number;
      // Survivability verdict for the predicted target.
      verdict: "safe" | "at_risk" | "lethal";
      // Targeting probability (0-100) per alive, non-vanished fighter.
      probabilities: Array<{ id: ActorId; position: BattlePosition; pct: number }>;
      // Party HP snapshot for triage.
      triage: Array<{ id: ActorId; hp: number; max_hp: number; shield: number; position: BattlePosition }>;
      // Active ability effects summary.
      active: { stunned: number; taunt_actor: ActorId | null; taunt_swings: number; vanished: ActorId[] };
      // How many more turns this readout will re-appear (counts down after cast).
      turns_remaining: number;
    }
  | {
      type: "ability_migrate";
      actor: ActorId;
      target: ActorId;
      from: BattlePosition;
      to: BattlePosition;
    }
  | { type: "monster_swing_skipped"; reason: "stunned" }
  | { type: "monster_stun_broken"; turns_active: number }
  | { type: "monster_target_redirected"; from: ActorId; to: ActorId; reason: "taunt" | "vanish" }
  | { type: "battle_hymn_expired"; actor: ActorId }
  | { type: "mark_applied"; actor: ActorId; expires_after_round: number }
  | { type: "shield_applied"; actor: ActorId; target: ActorId; restored: number; new_armor: number; bonus_barrier?: boolean }
  | { type: "passive_warden_shield"; actor: ActorId; amount: number }
  | { type: "passive_warden_thorns"; actor: ActorId; target: ActorId; amount: number }
  | { type: "passive_warden_armor_up"; actor: ActorId; amount: number }
  | { type: "ability_taunt_fortify"; actor: ActorId; turns: number }
  | { type: "passive_warden_resilient"; actor: ActorId; stacks: number }
  | { type: "ability_brace"; actor: ActorId; turns: number }
  | { type: "passive_mage_mana_font"; actor: ActorId; amount: number }
  | { type: "passive_druid_regen"; actor: ActorId; amount: number }
  | { type: "passive_rogue_lethal_strike"; actor: ActorId; magnitude: number; duration: number }
  | { type: "ability_envenom_proc"; actor: ActorId; target: ActorId; stacks: number }
  | { type: "passive_bard_aura"; actor: ActorId; source: ActorId; bonus: number }
| { type: "passive_holy_rage"; paladin: ActorId; bonus: number }
  | { type: "ability_shield_of_faith"; actor: ActorId; expires_after_round: number }
  | { type: "ability_protect"; actor: ActorId; target: ActorId }
  | { type: "ability_smite_debuff"; actor: ActorId; target: ActorId }
  | { type: "protect_triggered"; paladin: ActorId; target: ActorId; target_damage: number; paladin_damage: number }
  | { type: "passive_primal_strikes_heal"; actor: ActorId; amount: number }
  | { type: "ability_regeneration"; actor: ActorId; target: ActorId; magnitude: number; duration: number }
  | { type: "ability_animal_form"; actor: ActorId; str_bonus: number; vit_bonus: number; agi_bonus: number; dex_bonus: number; turns: number }
  | { type: "ability_barkskin"; actor: ActorId; target: ActorId; bonus: number; turns: number }
  | { type: "ability_wildgrowth_entangle"; actor: ActorId; target: ActorId; duration: number }
  | { type: "passive_rogue_first_crit"; actor: ActorId }
  | { type: "passive_sinister_queries"; actor: ActorId; target: ActorId; magnitude: number }
  | { type: "ability_hex"; actor: ActorId; target: ActorId; duration: number }
  | { type: "hex_bleed_proc"; target: ActorId; stacks: number }
  | { type: "ability_forbidden_sql"; actor: ActorId; target: ActorId; stacks_consumed: number; damage: number }
  | { type: "passive_paladin_auto_heal"; paladin: ActorId; target: ActorId; amount: number }
  | {
      type: "drink_buff_consumed";
      actor: ActorId;
      drink_id: string;
      kind: "buff_attack" | "buff_magic" | "buff_next_crit";
      // Damage bonus from the buff. For buff_attack / buff_magic this is the
      // flat magnitude; for buff_next_crit it's `baseDamage` (the doubling
      // delta from forcing a crit on what would have been a non-crit hit).
      bonus: number;
      // True when this consumption forced a crit (buff_next_crit only).
      force_crit: boolean;
      // Charges left on the buff AFTER this consumption. 0 means the buff
      // expired and was cleared from state.drink_buffs.
      remaining: number;
    }
  | { type: "ally_npc_summoned"; actor: ActorId; npc_id: ActorId; name: string }
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string }
  | { type: "turn_skip"; actor: ActorId; reason: "frozen" }
  | { type: "ability_freeze_applied"; actor: ActorId; target: ActorId }
  | { type: "ability_blizzard_tick"; actor: ActorId; charges_remaining: number; hits: Array<{ target: ActorId; damage: number }> }
  | { type: "ability_good_fortune_delayed"; actor: ActorId; target: ActorId; amount: number }
  | { type: "ability_ill_omen_applied"; actor: ActorId; target: ActorId }
  | { type: "ability_ill_omen_burst"; actor: ActorId; target: ActorId; accumulated: number; burst: number }
  | {
      type: "elemental_proc";
      actor: ActorId;
      target: ActorId;
      element: ElementType;
      effect: EffectType;
      magnitude: number;
      duration: number;
      resisted: boolean;
    }
  // Monster-to-fighter status proc on an elemental hit. Mirrors the
  // weapon-side `elemental_proc` (which fires player → monster). Separate
  // event so log renderers and analytics can distinguish "monster gave me
  // a status" from "I gave the monster a status."
  | {
      type: "monster_elemental_proc";
      actor: ActorId;          // monster id
      target: ActorId;         // fighter id
      element: "fire" | "ice" | "lightning";
      effect: "burning" | "frozen" | "shocked";
      magnitude: number;
      duration: number;
    };

// AC formulas — defense thresholds the attacker must equal or exceed on a
// d20 + relevant modifier. Tuned so low-tier monsters are easy to hit and
// boss-tier (tier 5+) take real swings to land. Armor still mitigates
// landed damage in resolveMonsterHit — it doesn't double-up here as AC.
const MONSTER_BASE_AC = 6;
// Fighter AC scales with level so high-tier monsters can't auto-hit, capped at 20
// so monsters never become literally unable to land hits at high levels.
// level 1→10, level 10→15, level 20+→20 (hard cap).
export const fighterAc = (level: number) => 10 + Math.min(Math.floor(level / 2), 10);
// Monster AC scales at half the tier rate; player attack_mod (augmented by
// level in the host app) stays meaningful throughout progression.
export const monsterAc = (tier: number) => MONSTER_BASE_AC + Math.max(0, Math.floor(tier / 2));

export interface StepResult {
  state: CombatState;
  events: CombatEvent[];
}

export type RollFn = (sides: number) => number;

// Inputs for the initial state. Build it once from D1 data, then feed into
// step({ kind: "begin" }) to roll initiative and enter the active phase.
// Wave fields on monster are opt-in: omit them for standard/boss combats.
// Use `monsters` for multi-enemy; `monster` for single-enemy (backward compat).
type MonsterInitSpec = Omit<CombatMonster, "initiative" | "effects" | "boss_phase" | "id" | "shield"> & {
  id?: ActorId;    // auto-generated if omitted
  boss_phase?: 1 | 2;
  shield?: number; // defaults to tier when omitted
};
export interface CombatInit {
  // focus_power and weapon_range default to 0 and "melee" when omitted — keeps
  // older call sites and tests valid without having to know about focus weapons.
  fighters: (Omit<CombatFighter, "initiative" | "effects" | "focus_power" | "weapon_range"> & {
    focus_power?: number;
    weapon_range?: WeaponRange;
  })[];
  // Single monster (legacy). Alias for monsters: [monster].
  monster?: MonsterInitSpec;
  // Multi-monster (Phase 3). When present, `monster` is ignored.
  monsters?: MonsterInitSpec[];
}

export function createCombatState(init: CombatInit): CombatState {
  const contribution: Record<ActorId, number> = {};
  for (const f of init.fighters) contribution[f.id] = 0;
  const stats: CombatState["stats"] = {};
  for (const f of init.fighters) stats[f.id] = { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 };
  const monsterSpecs = init.monsters ?? (init.monster ? [init.monster] : []);
  return {
    fighters: init.fighters.map((f) => ({
      ...f,
      focus_power: f.focus_power ?? 0,
      weapon_range: f.weapon_range ?? "melee",
      initiative: 0,
      effects: [],
    })),
    monsters: monsterSpecs.map((m, i) => ({
      ...m,
      id: m.id ?? (monsterSpecs.length === 1 ? MONSTER_ID : `__monster_${i}__`),
      initiative: 0,
      effects: [],
      boss_phase: m.boss_phase ?? 1,
      shield: m.shield ?? m.tier,   // armor pool defaults to tier
    })),
    turn_order: [],
    turn_index: 0,
    round: 0,
    status: "pending",
    contribution,
    stats,
  };
}

// Upgrades a persisted combat state from pre-Phase-3 format (single `monster`)
// to the current `monsters[]` format. Safe to call on already-upgraded states.
export function upgradeCombatState(raw: CombatState): CombatState {
  if (raw.monsters && raw.monsters.length > 0) return raw;
  const legacy = raw.monster;
  if (!legacy) return raw;
  return { ...raw, monsters: [{ ...legacy, id: legacy.id ?? MONSTER_ID }] };
}

// The engine. Pure function: same (state, action, rng) → same (state', events).
export function step(state: CombatState, action: TurnAction, roll: RollFn): StepResult {
  if (state.status === "victory" || state.status === "defeat" || state.status === "fled") {
    return reject(state, `combat already ended (${state.status})`);
  }

  switch (action.kind) {
    case "begin": {
      const beginResult = handleBegin(state, roll);
      // Fire an initial foresee so the Sage has predictions before the first
      // monster attack — but only when monsters act before the sage in round 1.
      // If the sage goes first they'll get foresee after the monster attacks.
      const sage = beginResult.state.fighters.find(
        (f) => f.hp > 0 && classHasPassive(f.class, "foretell"),
      );
      if (!sage) return beginResult;
      const order = beginResult.state.turn_order;
      const sageIdx = order.indexOf(sage.id);
      if (sageIdx <= 0 || !order.slice(0, sageIdx).some(isMonsterActor)) return beginResult;
      return withForeseeForSage(beginResult, sage.id, 0, roll);
    }
    case "attack":
      return handlePlayerHit(state, action, roll);
    case "flee":
      return handleFlee(state, action, roll);
    case "position":
      return handlePosition(state, action, roll);
    case "wait":
      return handleWait(state, action, roll);
    case "mark":
      return handleMark(state, action);
    case "ability":
      return handleAbility(state, action, roll);
    case "monster_act":
      // After the monster acts, if the next actor is a Staff Sage with Foresee
      // active, inject the intel refresh right before the turn_start divider so
      // the Sage sees fresh info at the top of their incoming turn.
      return withForeseeForNextActor(handleMonsterAct(state, roll), roll);
    case "ally_npc_act":
      return withForeseeForNextActor(handleAllyNpcAct(state, roll), roll);
  }
}

// --- Handlers ---

function handleBegin(state: CombatState, roll: RollFn): StepResult {
  if (state.status !== "pending") {
    return reject(state, "begin is only valid when status is 'pending'");
  }
  const initiatives: Record<ActorId, number> = {};
  const next: CombatState = {
    ...state,
    fighters: state.fighters.map((f) => {
      const base = roll(20);
      const agiBonus = f.stats ? deriveInitiativeBonus(f.stats) : 0;
      const init = base + agiBonus;
      initiatives[f.id] = init;
      return { ...f, initiative: init };
    }),
    monsters: state.monsters.map((m) => {
      const init = roll(20);
      initiatives[m.id] = init;
      return { ...m, initiative: init };
    }),
    status: "active",
    turn_index: 0,
    round: 1,
  };
  next.turn_order = computeTurnOrder(next);

  const firstActor = next.turn_order[0];
  return {
    state: next,
    events: [
      { type: "begin", turn_order: next.turn_order, initiatives },
      ...next.fighters.map(
        (f) =>
          ({
            type: "roll",
            actor: f.id,
            die: "d20",
            value: f.initiative,
            purpose: "initiative",
          }) as CombatEvent,
      ),
      ...next.monsters.map(
        (m) =>
          ({
            type: "roll",
            actor: m.id,
            die: "d20",
            value: m.initiative,
            purpose: "initiative",
          }) as CombatEvent,
      ),
      { type: "turn_start", actor: firstActor, round: 1 },
    ],
  };
}

function handlePlayerHit(
  state: CombatState,
  action: { kind: "attack"; actor: ActorId; target_id?: ActorId },
  roll: RollFn,
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn (current: ${currentActor(state)})`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  // Back-row melee restriction only applies in a party — solo fights have
  // no positioning concept. Only ranged or focus weapons can attack from
  // the back row; melee weapons demand front-row engagement.
  if (
    fighter.position === "back"
    && state.fighters.length > 1
    && fighter.weapon_range !== "ranged"
    && fighter.weapon_range !== "focus"
  ) {
    return reject(state, "back-row melee blocked — equip a ranged or focus weapon or move to front");
  }

  // Target selection: use explicit target_id if provided, else pick first alive monster.
  const targetMonster = action.target_id
    ? state.monsters.find((m) => m.id === action.target_id && m.hp > 0)
    : state.monsters.find((m) => m.hp > 0);
  if (!targetMonster) return reject(state, "no valid target");

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;
  const tickedFighter = s.fighters.find((f) => f.id === action.actor)!;
  // Re-resolve target from updated state (tick may have killed the monster).
  const monster = s.monsters.find((m) => m.id === targetMonster.id && m.hp > 0);
  if (!monster) return reject(s, "target died before action resolved");

  const events: CombatEvent[] = [...tick.events];
  // Primal Strikes (Druid passive): add magic_mod to both to-hit and damage.
  const primalBonus = classHasPassive(tickedFighter.class, "primal_strikes") ? tickedFighter.magic_mod : 0;
  // Focus weapons use magic_mod for to-hit so casters can land attacks without speccing attack,
  // but damage still uses attack_mod (focus damage comes from weapon_power, not magic).
  const hitMod =
    (tickedFighter.weapon_range === "focus" ? tickedFighter.magic_mod : tickedFighter.attack_mod) + primalBonus;
  const damageMod = tickedFighter.attack_mod + primalBonus;

  // ── d20 to-hit ──
  let d20 = roll(20);
  // Bard Encourage — advantage: roll the d20 twice, take higher, consume one charge.
  const encourageCharges = s.ability_state?.encourage?.[action.actor] ?? 0;
  if (encourageCharges > 0) {
    const d20b = roll(20);
    const took = Math.max(d20, d20b);
    events.push({ type: "advantage_used", actor: action.actor, d20_a: d20, d20_b: d20b, took });
    d20 = took;
    s = { ...s, ability_state: consumeEncourageCharge(s.ability_state, action.actor) };
  }
  const ac = monsterAc(monster.tier);
  const hitTotal = d20 + hitMod;
  const landed = hitTotal >= ac;
  events.push({
    type: "roll",
    actor: action.actor,
    die: "d20",
    value: d20,
    purpose: "hit_check",
  });
  events.push({
    type: "hit_check",
    actor: action.actor,
    target: monster.id,
    roll: d20,
    modifier: hitMod,
    total: hitTotal,
    ac,
    hit: landed,
  });

  if (!landed) {
    const next = advanceTurn(s);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // Vanish auto-crit: reveal from stealth on any attack; force crit if attack lands.
  const wasVanished = (s.ability_state?.vanished?.[action.actor] ?? 0) > 0;
  if (wasVanished) {
    s = { ...s, ability_state: removeVanishForFighter(s.ability_state, action.actor) };
  }

  // ── damage roll on hit ──
  const damageRoll = tickedFighter.damage_roll ?? "1d6";
  const hit = resolvePlayerHit(action.kind, damageMod, tickedFighter.weapon_power, roll, damageRoll);
  events.push({
    type: "roll",
    actor: action.actor,
    die: damageRoll,
    value: hit.roll,
    purpose: "damage_attack",
  });

  let damage = hit.damage;
  let isCrit = hit.isCrit;

  // Vanish auto-crit: attacking while obscured guarantees a crit on hit.
  if (wasVanished && !isCrit) {
    isCrit = true;
    damage *= 2;
  }

  // DEX crit bonus — secondary crit chance for DEX > 5 (STATS_V2 only).
  if (!isCrit && tickedFighter.stats) {
    const threshold = Math.round(deriveCritBonus(tickedFighter.stats) * 100);
    if (threshold > 0 && roll(100) <= threshold) {
      isCrit = true;
      damage = damage * 2;
    }
  }

  // Pub drink-buff. Applied between rogue first-crit and bard aura so the
  // crit-doubling has happened (buff_next_crit gates on !isCrit) but the
  // aura/mark bonuses haven't yet (those are partymate-driven additive
  // bonuses, distinct from the actor's own consumable buff).
  const drinkResult = applyDrinkBuff(s, action.actor, action.kind, damage, isCrit);
  damage = drinkResult.damage;
  if (drinkResult.forceCrit) {
    isCrit = true;
  }

  // QA Paladin — Holy Rage: consume accumulated bonus from damage taken.
  const holyRageTotal = s.ability_state?.holy_rage?.[action.actor] ?? 0;
  const holyRageBonus = Math.floor(holyRageTotal * 0.1);
  if (holyRageBonus > 0) {
    damage += holyRageBonus;
    s = { ...s, ability_state: clearHolyRage(s.ability_state, action.actor) };
    events.push({ type: "passive_holy_rage", paladin: action.actor, bonus: holyRageBonus });
  }

  // Battle Elixir — Empowered: +25% damage for N turns.
  const hasEmpowered = tickedFighter.effects.some((e) => e.type === "empowered");
  if (hasEmpowered) damage = Math.round(damage * 1.25);

  // Bard Aura — whole party gains +bonus dmg while a Bard is alive; Battle
  // Hymn boosts the aura by +2 for its round duration.
  const aura = computeBardAuraBonus(s);


  // Shocked amplifier: monster takes +30% (magnitude 1) or +45% (magnitude 2) from all hits.
  const shockedEffect = monster.effects.find((e) => e.type === "shocked");
  const shockMult = shockedEffect ? (shockedEffect.magnitude >= 2 ? 1.45 : 1.30) : 1.0;

  // Damage type weakness/resistance: +30% on weakness, −30% on resistance.
  // Player attack type: "physical" for melee, element or "magic" for cast.
  const playerAttackType: DamageType =
    action.kind === "attack"
      ? "physical"
      : (tickedFighter.element as DamageType | undefined) ?? "magic";
  const weaknessMult = monster.damage_weakness === playerAttackType ? 1.3 : 1.0;
  const resistMult = monster.damage_resistance === playerAttackType ? 0.7 : 1.0;

  const vulnMult = vulnerabilityMult(s, monster.id, s.round);
  const finalDamage = Math.max(1, Math.round((damage + aura.bonus) * shockMult * weaknessMult * resistMult * vulnMult));

  // Physical attacks (attack action) deplete the monster's armor pool first.
  // Cast and signatures bypass armor and go straight to HP.
  const monsterArmorAbsorbed = playerAttackType === "physical"
    ? Math.min(monster.shield, finalDamage)
    : 0;
  const newMonsterShield = monster.shield - monsterArmorAbsorbed;
  const hpDamage = finalDamage - monsterArmorAbsorbed;

  const oldHp = monster.hp;
  const newHp = Math.max(0, oldHp - hpDamage);
  const monsterKilled = newHp <= 0;
  const phaseTransition =
    monster.is_boss &&
    monster.boss_phase === 1 &&
    isBossPhaseTransition(monster.max_hp, oldHp, newHp);

  if (drinkResult.event) {
    events.push(drinkResult.event);
  }
  if (aura.bonus > 0) {
    events.push({
      type: "passive_bard_aura",
      actor: action.actor,
      source: state.fighters.find((f) => f.hp > 0 && classIdOf(f) === "frontend_bard")?.id ?? action.actor,
      bonus: aura.bonus,
    });
  }
  const drinkBonusForFormula =
    drinkResult.event && drinkResult.event.type === "drink_buff_consumed" && !drinkResult.forceCrit
      ? ` +${drinkResult.event.bonus} drink`
      : "";
  events.push({
    type: "player_hit",
    actor: action.actor,
    target: monster.id,
    damage: finalDamage,
    armor_absorbed: monsterArmorAbsorbed,
    crit: isCrit,
    formula: `${hit.roll}+${hit.totalMod}${isCrit ? " ×2" : ""}${drinkBonusForFormula}${hasEmpowered ? " ⚡" : ""}${aura.bonus > 0 ? ` +${aura.bonus} aura` : ""}`,
  });

  let nextState: CombatState = {
    ...s,
    monsters: s.monsters.map((m) =>
      m.id === monster.id
        ? {
            ...m,
            hp: newHp,
            shield: newMonsterShield,
            // Boss phase 2 transition: armor refills (boss hardens).
            ...(phaseTransition ? { boss_phase: 2 as const, shield: m.tier } : {}),
          }
        : m,
    ),
    contribution: {
      ...s.contribution,
      [action.actor]: (s.contribution[action.actor] ?? 0) + finalDamage,
    },
    // Only overwrite drink_buffs when this turn actually consumed one —
    // otherwise leave the existing map untouched so the optional field
    // doesn't get coerced to undefined for unrelated turns.
    ...(drinkResult.event ? { drink_buffs: drinkResult.nextDrinkBuffs } : {}),
  };

  // Sinister Queries passive — applies bleed on any hit.
  if (!monsterKilled) {
    const sq = applySinisterQueries(nextState, tickedFighter, monster.id);
    nextState = sq.state;
    events.push(...sq.events);
    const hexProc = applyHexBleedProc(nextState, monster.id);
    nextState = hexProc.state;
    events.push(...hexProc.events);
  }

  // Rogue — Lethal Strikes: crits apply bleed.
  if (isCrit && !monsterKilled) {
    const ls = applyRogueLethalStrike(nextState, tickedFighter, monster.id);
    nextState = ls.state;
    events.push(...ls.events);
  }

  // Rogue — Envenom Weapon: next hit after ability applies poison.
  if (!monsterKilled) {
    const env = applyEnvenomProc(nextState, tickedFighter, monster.id);
    nextState = env.state;
    events.push(...env.events);
  }

  // Elemental weapon proc — applies status (burning/frozen/shocked) to target.
  if (!monsterKilled) {
    const proc = applyElementalProc(nextState, tickedFighter, monster.id, roll);
    nextState = proc.state;
    events.push(...proc.events);
  }

  // Warden — Resilient: gain a stack on every successful hit.
  if (!monsterKilled) {
    const rr = applyWardenResilient(nextState, tickedFighter);
    nextState = rr.state;
    events.push(...rr.events);
  }

  if (phaseTransition) {
    events.push({ type: "boss_phase_transition", new_phase: 2 });
  }

  // Staff Sage — Ill Omen: track HP damage dealt to omen-marked monster.
  if (hpDamage > 0) {
    nextState = accumulateIllOmenDamage(nextState, monster.id, hpDamage);
  }

  if (monsterKilled) {
    return resolveMonsterKill(nextState, monster.id, action.actor, events);
  }

  // Staff Sage — Blizzard: fire end-of-turn AoE tick after any player attack.
  const blizzTick = applyBlizzardTick(nextState, action.actor, roll);
  nextState = blizzTick.state;
  events.push(...blizzTick.events);
  for (const killedId of blizzTick.killed) {
    const killResult = resolveMonsterKill(nextState, killedId, action.actor, events);
    if (killResult.state.status !== "active") return killResult;
    nextState = killResult.state;
    events.length = 0;
    events.push(...killResult.events);
  }

  // Primal Strikes — heal on landing an attack.
  if (primalBonus > 0) {
    const healAmount = 2 * tickedFighter.magic_mod + tickedFighter.attack_mod;
    const primalFighter = nextState.fighters.find((f) => f.id === action.actor)!;
    const newHp = Math.min(primalFighter.max_hp, primalFighter.hp + healAmount);
    const healed = newHp - primalFighter.hp;
    if (healed > 0) {
      nextState = {
        ...nextState,
        fighters: nextState.fighters.map((f) => f.id === action.actor ? { ...f, hp: newHp } : f),
      };
      events.push({ type: "passive_primal_strikes_heal", actor: action.actor, amount: healed });
    }
  }

  return { state: advanceTurn(nextState), events: [...events, ...turnStartEvent(nextState)] };
}

// Auto-resolved ally NPC turn (hired mercs and ability-summoned NPCs): simple
// d20 to-hit then d6 damage swing at the lowest-HP live monster. No class
// abilities, no crits, no mana. Server fires this in a loop after each
// player/monster action whenever the next actor is an ally NPC, so the web
// client never sees a "pending NPC turn".
function handleAllyNpcAct(state: CombatState, roll: RollFn): StepResult {
  const actorId = currentActor(state);
  if (!actorId || !isAllyNpcActor(actorId)) {
    return reject(state, "not an ally NPC's turn");
  }
  const merc = state.fighters.find((f) => f.id === actorId);
  if (!merc || merc.hp <= 0) {
    const next = advanceTurn(state);
    return { state: next, events: [...turnStartEvent(next)] };
  }

  const tick = tickAtTurnStart(state, actorId);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const mercAfterTick = s.fighters.find((f) => f.id === actorId);
  if (!mercAfterTick || mercAfterTick.hp <= 0) {
    return tick.earlyReturn ?? { state: s, events: tick.events };
  }

  const events: CombatEvent[] = [...tick.events];

  const monster = s.monsters.reduce<CombatMonster | null>((best, m) => {
    if (m.hp <= 0) return best;
    if (!best || m.hp < best.hp) return m;
    return best;
  }, null);

  if (!monster) {
    const next = advanceTurn(s);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  const ac = monsterAc(monster.tier);
  const d20 = roll(20);
  const total = d20 + mercAfterTick.attack_mod;
  const landed = total >= ac;

  events.push({ type: "roll", actor: actorId, die: "d20", value: d20, purpose: "hit_check" });
  events.push({
    type: "hit_check",
    actor: actorId,
    target: monster.id,
    roll: d20,
    modifier: mercAfterTick.attack_mod,
    total,
    ac,
    hit: landed,
  });

  if (!landed) {
    const next = advanceTurn(s);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  const npcDamageRoll = mercAfterTick.damage_roll ?? "1d6";
  const hit = resolvePlayerHit("attack", mercAfterTick.attack_mod, mercAfterTick.weapon_power, roll, npcDamageRoll);
  events.push({ type: "roll", actor: actorId, die: npcDamageRoll, value: hit.roll, purpose: "damage_attack" });

  const aura = computeBardAuraBonus(s);
  const rawDamage = hit.damage + aura.bonus;
  const { newShield: newMonsterShield, newHp, hpDamage: finalDamage } =
    applyDamageWithShield(rawDamage, monster.shield, monster.hp);

  if (aura.bonus > 0) {
    events.push({
      type: "passive_bard_aura",
      actor: actorId,
      source: s.fighters.find((f) => f.hp > 0 && classHasPassive(f.class, "bardic_aura"))?.id ?? actorId,
      bonus: aura.bonus,
    });
  }
  events.push({
    type: "player_hit",
    actor: actorId,
    target: monster.id,
    damage: finalDamage,
    armor_absorbed: monster.shield - newMonsterShield,
    crit: hit.isCrit,
    formula: `${npcDamageRoll}+${mercAfterTick.attack_mod}a+${mercAfterTick.weapon_power}w${aura.bonus > 0 ? ` +${aura.bonus} aura` : ""}`,
  });
  const monsterKilled = newHp <= 0;
  const nextState: CombatState = {
    ...s,
    monsters: s.monsters.map((m) =>
      m.id === monster.id ? { ...m, hp: Math.max(0, newHp), shield: newMonsterShield } : m,
    ),
    contribution: {
      ...s.contribution,
      [actorId]: (s.contribution[actorId] ?? 0) + finalDamage,
    },
  };

  if (monsterKilled) {
    return resolveMonsterKill(nextState, monster.id, actorId, events);
  }

  const hexProc = applyHexBleedProc(nextState, monster.id);
  events.push(...hexProc.events);

  return { state: advanceTurn(hexProc.state), events: [...events, ...turnStartEvent(hexProc.state)] };
}

function handlePosition(
  state: CombatState,
  action: { kind: "position"; actor: ActorId; to: BattlePosition },
  roll: RollFn,
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  if (fighter.position === action.to) {
    return reject(state, `already in ${action.to} row`);
  }

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;

  const events: CombatEvent[] = [
    ...tick.events,
    { type: "position_changed", actor: action.actor, from: fighter.position, to: action.to },
  ];
  s = { ...s, fighters: s.fighters.map((f) => f.id === action.actor ? { ...f, position: action.to } : f) };

  // Staff Sage — Blizzard: fire end-of-turn AoE tick.
  const blizzTick = applyBlizzardTick(s, action.actor, roll);
  s = blizzTick.state;
  events.push(...blizzTick.events);
  for (const killedId of blizzTick.killed) {
    const killResult = resolveMonsterKill(s, killedId, action.actor, events);
    if (killResult.state.status !== "active") return killResult;
    s = killResult.state;
    events.length = 0;
    events.push(...killResult.events);
  }

  const next = advanceTurn(s);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

function handleWait(
  state: CombatState,
  action: { kind: "wait"; actor: ActorId },
  roll: RollFn,
): StepResult {
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;
  const events: CombatEvent[] = [...tick.events];

  // Staff Sage — Blizzard: fire end-of-turn AoE tick.
  const blizzTick = applyBlizzardTick(s, action.actor, roll);
  s = blizzTick.state;
  events.push(...blizzTick.events);
  for (const killedId of blizzTick.killed) {
    const killResult = resolveMonsterKill(s, killedId, action.actor, events);
    if (killResult.state.status !== "active") return killResult;
    s = killResult.state;
    events.length = 0;
    events.push(...killResult.events);
  }

  const next = advanceTurn(s);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

// Mark — free action, does not consume the actor's turn. Any living fighter
// can mark at any time to call out a focus target for their allies. Re-marking
// overrides the previous mark and resets the expiry.
function handleMark(
  state: CombatState,
  action: { kind: "mark"; actor: ActorId; target_id?: string | null },
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  if (state.monsters.every((m) => m.hp <= 0)) return reject(state, `no live foe to mark`);

  // Resolve which monster is being marked. Explicit target_id wins; falls
  // back to the first live monster (single-monster fights, Slack path).
  const monster_id = action.target_id
    ?? state.monsters.find((m) => m.hp > 0)?.id;

  const expires_after_round = state.round + MARK_ROUNDS;
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    mark: { marked_by: action.actor, expires_after_round, monster_id },
  };
  return {
    state: { ...state, ability_state },
    events: [{ type: "mark_applied", actor: action.actor, expires_after_round }],
  };
}

function handleMonsterAct(state: CombatState, roll: RollFn): StepResult {
  const actorId = currentActor(state);
  if (!actorId || !isMonsterActor(actorId)) {
    return reject(state, "not a monster's turn");
  }
  const actingMonster = state.monsters.find((m) => m.id === actorId);
  if (!actingMonster || actingMonster.hp <= 0) {
    // Dead monster's turn slot — skip it silently.
    const next = advanceTurn(state);
    return { state: next, events: [...turnStartEvent(next)] };
  }

  const tick = tickAtTurnStart(state, actorId);
  if (tick.earlyReturn) return tick.earlyReturn;
  let s = tick.state;
  // Re-resolve monster after tick (tick may have applied DoT to it).
  const monster = s.monsters.find((m) => m.id === actorId);
  if (!monster || monster.hp <= 0) {
    // Tick killed this monster — resolveMonsterKill already fired via earlyReturn above.
    return tick.earlyReturn ?? { state: s, events: tick.events };
  }

  const events: CombatEvent[] = [...tick.events];

  // Containerize stun: monster is stunned — skip this swing. At the end of
  // each stunned turn, roll to break: chance = min(100%, turnsElapsed * 30%).
  // `remaining` starts at 5 and is decremented by tickEffects each turn start,
  // so turnsElapsed = 5 - remaining after the tick. Guaranteed break on turn 4
  // (remaining=1 → turnsElapsed=4 → 120% clamped to 100%).
  const stunnedEffect = s.monsters.find((m) => m.id === actorId)?.effects.find((e) => e.type === "stunned");
  if (stunnedEffect) {
    const bpt = stunnedEffect.magnitude;
    const turnsElapsed = 5 - stunnedEffect.remaining;
    const breakChance = Math.min(1.0, turnsElapsed * (bpt / 100));
    const breaks = (roll(100) / 100) < breakChance;
    const breakEvents: CombatEvent[] = breaks
      ? [{ type: "monster_stun_broken", turns_active: turnsElapsed }]
      : [];
    const nextBreakPct = Math.min(100, (6 - stunnedEffect.remaining) * bpt);
    const updatedMonsters = breaks
      ? s.monsters.map((m) =>
          m.id === actorId
            ? { ...m, effects: m.effects.filter((e) => e.type !== "stunned") }
            : m,
        )
      : s.monsters.map((m) =>
          m.id === actorId
            ? { ...m, effects: m.effects.map((e) => e.type === "stunned" ? { ...e, pill_suffix: `${nextBreakPct}% break` } : e) }
            : m,
        );
    const skippedState: CombatState = { ...s, monsters: updatedMonsters };
    const next = advanceTurn(skippedState);
    return {
      state: next,
      events: [
        ...events,
        { type: "monster_swing_skipped", reason: "stunned" },
        ...breakEvents,
        ...turnStartEvent(next),
      ],
    };
  }

  // Staff Sage — Ill Omen: tick monster turn counter; burst fires on 3rd monster turn.
  const illOmen = tickIllOmenAtMonsterAct(s, actorId);
  s = illOmen.state;
  events.push(...illOmen.events);
  if (illOmen.killed && illOmen.caster_id) {
    return resolveMonsterKill(s, actorId, illOmen.caster_id, events);
  }

  const aliveFighters = s.fighters.filter((f) => f.hp > 0);
  if (aliveFighters.length === 0) {
    // Should be unreachable — defeat is checked after each fighter falls.
    return { state: { ...s, status: "defeat" }, events: [...events, { type: "defeat" }] };
  }

  // Anti-pile-on: fetch (or reset) the round-scoped target tally so monsters
  // in the same round are less likely to all converge on the same fighter.
  const prevRmt = s.round_monster_targets;
  const rmtCounts: Record<ActorId, number> =
    prevRmt && prevRmt.round === s.round ? { ...prevRmt.counts } : {};

  // Target selection honors taunt (override) and vanish (filter out).
  // If Foretell pre-rolled this monster's target, use it so the Sage's
  // prediction is guaranteed correct. Falls back to a fresh roll if the
  // pre-rolled fighter died before the monster swings.
  const foretoldId = s.ability_state?.foretold_targets?.[actorId];
  const foretoldFighter = foretoldId ? aliveFighters.find((f) => f.id === foretoldId) : null;
  const initialTarget = foretoldFighter ?? pickMonsterTarget(aliveFighters, () => roll(101) / 100, rmtCounts);
  // Clear this monster's entry; leave other monsters' entries untouched.
  const ftRemaining = { ...(s.ability_state?.foretold_targets ?? {}) };
  delete ftRemaining[actorId];
  s = {
    ...s,
    ability_state: Object.keys(ftRemaining).length > 0
      ? { ...(s.ability_state ?? {}), foretold_targets: ftRemaining }
      : stripField(s.ability_state, "foretold_targets"),
  };
  const vanished = s.ability_state?.vanished ?? {};
  const taunted = s.ability_state?.taunt;
  let target: CombatFighter | null = initialTarget;
  if (taunted && taunted.swings_remaining > 0) {
    const tauntTarget = aliveFighters.find((f) => f.id === taunted.actor_id);
    if (tauntTarget) {
      if (tauntTarget.id !== initialTarget.id) {
        events.push({
          type: "monster_target_redirected",
          from: initialTarget.id,
          to: tauntTarget.id,
          reason: "taunt",
        });
      }
      target = tauntTarget;
    }
  } else if ((vanished[initialTarget.id] ?? 0) > 0) {
    // Vanish blocks this target — re-pick from the non-vanished alive pool.
    const eligible = aliveFighters.filter((f) => (vanished[f.id] ?? 0) <= 0);
    if (eligible.length > 0) {
      const reroll = pickMonsterTarget(eligible, () => roll(101) / 100, rmtCounts);
      events.push({
        type: "monster_target_redirected",
        from: initialTarget.id,
        to: reroll.id,
        reason: "vanish",
      });
      target = reroll;
    } else {
      // If all alive fighters are vanished, the monster can't acquire a target.
      events.push({ type: "monster_target_blocked", reason: "vanish" });
      const next = advanceTurn({
        ...s,
        ability_state: tickAbilityCountersAfterSwing(s.ability_state),
      });
      return { state: next, events: [...events, ...turnStartEvent(next)] };
    }
  }

  // Record this monster's target pick so subsequent monsters this round see
  // the tally and apply reduced weight to already-targeted fighters.
  if (target !== null) {
    rmtCounts[target.id] = (rmtCounts[target.id] ?? 0) + 1;
  }
  const rmt = { round: s.round, counts: rmtCounts };

  // ── Boss splash (AoE) ──
  // Bosses have a chance to forgo single-target targeting and slam the whole
  // party for reduced damage. Taunt does NOT redirect a splash — it hits every
  // alive non-vanished fighter. Only fires when multiple fighters are alive.
  const bossPhase2 = monster.is_boss && monster.boss_phase === 2;
  const splashChance = bossPhase2 ? 2 : 1; // 2-in-5 P2, 1-in-5 P1
  const doSplash = monster.is_boss && aliveFighters.length > 1 && roll(5) <= splashChance;

  if (doSplash) {
    const splashDamageType = monster.attack_damage_type ?? "physical";
    const splashTargets = aliveFighters.filter((f) => (vanished[f.id] ?? 0) <= 0);
    const splashHexMult = monster.effects.some((e) => e.type === "hexed") ? 0.75 : 1.0;
    const splashHits = splashTargets.map((f) => {
      const resistPct = splashDamageType !== "physical" ? (f.resistances?.[splashDamageType] ?? 0) : 0;
      const hit = resolveMonsterHit(monster.tier, aliveFighters.length, 0, bossPhase2, roll, splashDamageType, resistPct, monster.damage_roll ?? "1d4");
      const splashShocked = f.effects.find((e) => e.type === "shocked");
      const splashShockMult = splashShocked ? (splashShocked.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
      const posAdj = positionDamageMod(f.position, Math.round(hit.final * splashShockMult * splashHexMult));
      // Physical depletes armor pool; non-physical bypasses it.
      const splashArmorPool = splashDamageType === "physical" ? f.shield : 0;
      const rawSplash = applyDamageWithShield(posAdj, splashArmorPool, f.hp);
      const dmg = splashDamageType === "physical"
        ? rawSplash
        : { newShield: f.shield, newHp: rawSplash.newHp, shieldAbsorbed: 0, hpDamage: rawSplash.hpDamage };
      return { fighter: f, hit, posAdj, dmg };
    });

    const splashEvent: CombatEvent = {
      type: "monster_splash",
      damage_type: splashDamageType,
      targets: splashHits.map(({ fighter, hit, dmg }) => ({
        target: fighter.id,
        raw_damage: hit.raw,
        damage_after_mitigation: hit.final,
        shield_absorbed: dmg.shieldAbsorbed,
        hp_damage: dmg.hpDamage,
      })),
    };
    events.push(splashEvent);

    // Apply HP changes and emit fighter_down for casualties
    let updatedFighters = s.fighters;
    let updatedStats = s.stats;
    for (const { fighter, dmg } of splashHits) {
      const wasAlive = fighter.hp > 0;
      updatedFighters = updatedFighters.map((f) =>
        f.id === fighter.id ? { ...f, shield: dmg.newShield, hp: Math.max(0, dmg.newHp) } : f,
      );
      updatedStats = {
        ...updatedStats,
        [fighter.id]: {
          ...(updatedStats[fighter.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
          damage_taken: (updatedStats[fighter.id]?.damage_taken ?? 0) + dmg.hpDamage,
        },
      };
      if (wasAlive && dmg.newHp <= 0) {
        events.push({ type: "fighter_down", target: fighter.id });
      }
    }

    const postSplashState: CombatState = {
      ...s,
      fighters: updatedFighters,
      ability_state: tickAbilityCountersAfterSwing(s.ability_state),
      stats: updatedStats,
      round_monster_targets: rmt,
    };

    const allDown = postSplashState.fighters.every((f) => f.hp <= 0);
    if (allDown) {
      events.push({ type: "defeat" });
      return { state: { ...postSplashState, status: "defeat" }, events };
    }
    const next = advanceTurn(postSplashState);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // ── d20 to-hit ──
  // Modifier grows at half-tier + 4 so it never auto-hits even at high tiers.
  // Fighter AC = 10 + floor(level/2) so the miss window stays meaningful.
  // Entangled: monster suffers -4 to all attack rolls.
  const entangledEffect = monster.effects.find((e) => e.type === "entangled");
  const entanglePenalty = entangledEffect ? 4 : 0;
  let d20 = roll(20);
  // Bard Mock — disadvantage: roll the d20 twice, take lower, consume one charge.
  const discourageCharges = s.ability_state?.discourage?.[actorId] ?? 0;
  if (discourageCharges > 0) {
    const d20b = roll(20);
    const took = Math.min(d20, d20b);
    events.push({ type: "disadvantage_used", actor: actorId, d20_a: d20, d20_b: d20b, took });
    d20 = took;
    s = { ...s, ability_state: consumeDiscourageCharge(s.ability_state, actorId) };
  }
  const modifier = Math.floor(monster.tier / 2) + 4 - entanglePenalty;
  const hitTotal = d20 + modifier;
  const sof = s.ability_state?.shield_of_faith;
  const shieldOfFaithBonus = sof && s.round <= sof.expires_after_round ? 5 : 0;
  // Barkskin (Druid): target fighter's AC is buffed for N of their own turns.
  const barkskinEff = target.effects.find((e) => e.type === "barkskin");
  const targetAc = fighterAc(target.level) + shieldOfFaithBonus + (barkskinEff?.magnitude ?? 0);
  const landed = hitTotal >= targetAc;
  events.push({
    type: "roll",
    actor: actorId,
    die: "d20",
    value: d20,
    purpose: "hit_check",
  });
  events.push({
    type: "hit_check",
    actor: actorId,
    target: target.id,
    roll: d20,
    modifier,
    total: hitTotal,
    ac: targetAc,
    hit: landed,
  });

  if (!landed) {
    // Even a miss consumes one tick of taunt / vanish / smite debuff — the swing happened.
    const decremented: CombatState = { ...s, ability_state: consumeSmiteDebuff(tickAbilityCountersAfterSwing(s.ability_state), actorId), round_monster_targets: rmt };
    const next = advanceTurn(decremented);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // AGI dodge — checked after the to-hit succeeds, before damage is rolled.
  // deriveDodgeChance returns a fraction (0..0.15); we compare against a
  // 1-100 roll so max 15 is cap (Rogue at AGI 8 → 3%, end-game AGI 15 → 10%).
  if (target.stats) {
    const threshold = Math.round(deriveDodgeChance(target.stats) * 100);
    if (threshold > 0 && roll(100) <= threshold) {
      events.push({ type: "monster_dodged", target: target.id });
      const decremented: CombatState = {
        ...s,
        ability_state: consumeSmiteDebuff(tickAbilityCountersAfterSwing(s.ability_state), actorId),
        round_monster_targets: rmt,
      };
      const next = advanceTurn(decremented);
      return { state: next, events: [...events, ...turnStartEvent(next)] };
    }
  }

  // ── damage roll on hit ──
  const attackDamageType = monster.attack_damage_type ?? "physical";
  const targetResistPct = attackDamageType !== "physical"
    ? (target.resistances?.[attackDamageType] ?? 0)
    : 0;
  const monsterDamageRoll = monster.damage_roll ?? "1d4";
  const hit = resolveMonsterHit(
    monster.tier,
    aliveFighters.length,
    0,
    bossPhase2,
    roll,
    attackDamageType,
    targetResistPct,
    monsterDamageRoll,
  );
  const targetShocked = target.effects.find((e) => e.type === "shocked");
  const targetShockMult = targetShocked ? (targetShocked.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
  const hexMult = monster.effects.some((e) => e.type === "hexed") ? 0.75 : 1.0;
  const positionAdjusted = positionDamageMod(target.position, Math.round(hit.final * targetShockMult * hexMult));
  // QA Paladin — Smite debuff: 50% reduced damage on this swing.
  const smiteDebuffSwings = s.ability_state?.paladin_smite_debuff?.[actorId] ?? 0;
  const smiteAdjusted = smiteDebuffSwings > 0
    ? Math.max(1, Math.round(positionAdjusted * 0.5))
    : positionAdjusted;
  const brace = s.ability_state?.brace?.[target.id];
  const effectiveDamage = brace && brace.turns_remaining > 0
    ? Math.max(1, Math.round(smiteAdjusted * (1 - brace.pct / 100)))
    : smiteAdjusted;
  // Physical attacks route through the armor pool first (shield = depletable armor).
  // Non-physical bypasses armor entirely — unless Taunt Fortify is active, in which case
  // all damage routes through armor.
  const hasTauntFortify = (s.ability_state?.taunt_fortify?.[target.id]?.turns_remaining ?? 0) > 0;
  const armorForHit = (attackDamageType === "physical" || hasTauntFortify) ? target.shield : 0;
  const rawResult = applyDamageWithShield(effectiveDamage, armorForHit, target.hp);
  const newShield = (attackDamageType === "physical" || hasTauntFortify) ? rawResult.newShield : target.shield;
  const newHp = rawResult.newHp;
  const shieldAbsorbed = rawResult.shieldAbsorbed;
  const hpDamage = rawResult.hpDamage;

  events.push({
    type: "roll",
    actor: actorId,
    die: monsterDamageRoll,
    value: hit.raw - monster.tier - Math.floor((aliveFighters.length - 1) / 2) - (bossPhase2 ? monster.tier : 0),
    purpose: "damage_monster",
  });
  events.push({
    type: "monster_attack",
    actor: actorId,
    target: target.id,
    damage_type: attackDamageType,
    raw_damage: hit.raw,
    damage_after_position: effectiveDamage,
    damage_after_mitigation: hit.final,
    armor_reduction: hit.armorReduction,
    resistance_reduction: hit.resistanceReduction,
    shield_absorbed: shieldAbsorbed,
    hp_damage: hpDamage,
  });

  // QA Paladin — Protect: split HP damage between the protected ally and the paladin.
  const protectState = s.ability_state?.paladin_protect;
  const protectPaladin = protectState?.target_id === target.id
    ? s.fighters.find((f) => f.id === protectState!.paladin_id && f.hp > 0 && f.id !== target.id)
    : null;
  const targetHpDamage = protectPaladin ? Math.floor(hpDamage / 2) : hpDamage;
  const paladinProtectDamage = hpDamage - targetHpDamage;
  const targetNewHp = Math.max(0, target.hp - targetHpDamage);
  const paladinProtectNewHp = protectPaladin ? Math.max(0, protectPaladin.hp - paladinProtectDamage) : null;

  if (protectPaladin) {
    events.push({ type: "protect_triggered", paladin: protectPaladin.id, target: target.id, target_damage: targetHpDamage, paladin_damage: paladinProtectDamage });
  }

  const updatedFighters = s.fighters.map((f) => {
    if (f.id === target.id) return { ...f, shield: newShield, hp: targetNewHp };
    if (protectPaladin && f.id === protectPaladin.id) return { ...f, hp: paladinProtectNewHp! };
    return f;
  });
  const targetDowned = targetNewHp <= 0 && target.hp > 0;
  if (targetDowned) {
    events.push({ type: "fighter_down", target: target.id });
  }
  if (protectPaladin && paladinProtectNewHp! <= 0 && protectPaladin.hp > 0) {
    events.push({ type: "fighter_down", target: protectPaladin.id });
  }

  // Consume smite debuff for this monster's swing (hit or miss handled elsewhere for miss).
  const abilityStateAfterSmite = consumeSmiteDebuff(
    tickAbilityCountersAfterSwing(s.ability_state), actorId,
  );

  let next: CombatState = {
    ...s,
    fighters: updatedFighters,
    ability_state: abilityStateAfterSmite,
    stats: {
      ...s.stats,
      [target.id]: {
        ...(s.stats[target.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
        damage_taken: (s.stats[target.id]?.damage_taken ?? 0) + targetHpDamage,
      },
      ...(protectPaladin ? {
        [protectPaladin.id]: {
          ...(s.stats[protectPaladin.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
          damage_taken: (s.stats[protectPaladin.id]?.damage_taken ?? 0) + paladinProtectDamage,
        },
      } : {}),
    },
    round_monster_targets: rmt,
  };

  // QA Paladin — Holy Rage: accumulate bonus damage for all alive Paladins.
  if (hpDamage > 0) {
    next = accumulateHolyRage(next, hpDamage);
  }

  // Elemental proc — fire/ice/lightning monster attacks can apply
  // burning / frozen / shocked to the target. 25% base, scaled down by
  // the target's resist_<type> stat. Skipped if the swing dropped them.
  if (targetNewHp > 0 && (attackDamageType === "fire" || attackDamageType === "ice" || attackDamageType === "lightning")) {
    const proc = applyMonsterElementalProc(
      next, monster, target.id, attackDamageType, targetResistPct, roll,
    );
    next = proc.state;
    events.push(...proc.events);

    // Lightning chain — arc to same-row allies. Each ally rolls an
    // independent proc with their own resist. Damage doesn't spread,
    // only the shocked status. Skips downed allies and the primary
    // target (already rolled above).
    if (attackDamageType === "lightning") {
      const targetRow = target.position;
      const chainTargets = next.fighters.filter((f) =>
        f.id !== target.id && f.hp > 0 && f.position === targetRow,
      );
      for (const ally of chainTargets) {
        const allyResist = ally.resistances?.lightning ?? 0;
        const chain = applyMonsterElementalProc(
          next, monster, ally.id, "lightning", allyResist, roll,
        );
        next = chain.state;
        events.push(...chain.events);
      }
    }
  }

  // QA Paladin — Lay on Hands. Trigger if the target survived but dropped
  // below the threshold. Skips if target died on the swing.
  if (newHp > 0) {
    const heal = applyPaladinAutoHeal(next, target.id, roll);
    next = heal.state;
    events.push(...heal.events);
  }

  // SRE Warden — Thorns. Deal 25% armor_power back to the attacker if target survived.
  if (newHp > 0) {
    const thorns = applyWardenThorns(next, target.id, actorId);
    next = thorns.state;
    events.push(...thorns.events);
    if (thorns.events.length > 0) {
      const thornedMonster = next.monsters.find((m) => m.id === actorId);
      if (thornedMonster && thornedMonster.hp <= 0) {
        return resolveMonsterKill(next, actorId, target.id, events);
      }
    }
  }


  const allDown = next.fighters.every((f) => f.hp <= 0);
  if (allDown) {
    events.push({ type: "defeat" });
    return { state: { ...next, status: "defeat" }, events };
  }
  next = advanceTurn(next);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}


// Executes a damage-dealing active ability: calls ability.execute(ctx) for the
// damage formula, then applies drink buffs, shocked amplifier, boss phase,
// elemental proc, and kill resolution.
function handleDamageAbility(
  state: CombatState,
  actorId: ActorId,
  tickedActor: CombatFighter,
  ability: ActiveAbilityDef,
  ctx: AbilityContext,
  monster: CombatMonster,
  preEvents: CombatEvent[],
  roll: RollFn,
): StepResult {
  const effects = ability.execute(ctx);
  const dmgEffect = effects.find(
    (e): e is Extract<AbilityEffect, { kind: "deal_damage" }> => e.kind === "deal_damage",
  );
  if (!dmgEffect) return reject(state, `${ability.id} produced no damage effect`);

  let amount = dmgEffect.amount;
  let isCrit = dmgEffect.is_crit ?? false;
  const formula = dmgEffect.formula;

  // QA Paladin — Holy Rage: consume accumulated bonus.
  const holyRageTotal = state.ability_state?.holy_rage?.[actorId] ?? 0;
  const holyRageBonusAbility = Math.floor(holyRageTotal * 0.1);
  const abilityStateAfterAnger = holyRageTotal > 0
    ? clearHolyRage(state.ability_state, actorId)
    : state.ability_state;
  amount += holyRageBonusAbility;

  // Drink buff — only buff_next_crit applies to ability damage.
  const drinkResult = dmgEffect.drink_buff_context === "ability"
    ? applyDrinkBuff(state, actorId, "ability", amount, isCrit)
    : { damage: amount, forceCrit: false, event: null as CombatEvent | null, nextDrinkBuffs: state.drink_buffs };
  amount = drinkResult.damage;
  if (drinkResult.forceCrit) isCrit = true;

  // Shocked amplifier.
  const sigShockedEffect = monster.effects.find((e) => e.type === "shocked");
  const sigShockMult = sigShockedEffect ? (sigShockedEffect.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
  const sigVulnMult = vulnerabilityMult(state, monster.id, state.round);
  const finalDamage = Math.round(amount * sigShockMult * sigVulnMult);

  const oldHp = monster.hp;
  const newHp = Math.max(0, oldHp - finalDamage);
  const monsterKilled = newHp <= 0;
  const phaseTransition =
    monster.is_boss &&
    monster.boss_phase === 1 &&
    isBossPhaseTransition(monster.max_hp, oldHp, newHp);

  const events: CombatEvent[] = [
    ...preEvents,
    {
      type: "player_hit",
      actor: actorId,
      target: monster.id,
      damage: finalDamage,
      armor_absorbed: 0, // ability damage bypasses monster armor
      crit: isCrit,
      formula: drinkResult.event ? `${formula} ×2 (lucky sip)` : formula,
    },
  ];
  if (drinkResult.event) events.push(drinkResult.event);
  if (holyRageBonusAbility > 0) events.push({ type: "passive_holy_rage", paladin: actorId, bonus: holyRageBonusAbility });

  let nextState: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === monster.id
        ? {
            ...m,
            hp: newHp,
            ...(phaseTransition ? { boss_phase: 2 as const, shield: m.tier } : {}),
          }
        : m,
    ),
    contribution: {
      ...state.contribution,
      [actorId]: (state.contribution[actorId] ?? 0) + finalDamage,
    },
    ...(drinkResult.event ? { drink_buffs: drinkResult.nextDrinkBuffs } : {}),
    ...(abilityStateAfterAnger !== state.ability_state ? { ability_state: abilityStateAfterAnger } : {}),
  };

  if (phaseTransition) events.push({ type: "boss_phase_transition", new_phase: 2 });

  // Apply any non-damage effects returned by execute() (e.g. Smite debuff).
  if (!monsterKilled) {
    for (const effect of effects) {
      if (effect.kind === "apply_smite_debuff") {
        const prev = nextState.ability_state?.paladin_smite_debuff ?? {};
        const ability_state: AbilityRuntimeState = {
          ...(nextState.ability_state ?? {}),
          paladin_smite_debuff: { ...prev, [effect.target_id]: 1 },
        };
        nextState = { ...nextState, ability_state };
        events.push({ type: "ability_smite_debuff", actor: actorId, target: effect.target_id });
      }
    }
  }

  // Sinister Queries passive — applies bleed on any ability damage hit.
  if (!monsterKilled) {
    const sq = applySinisterQueries(nextState, tickedActor, monster.id);
    nextState = sq.state;
    events.push(...sq.events);
    const hexProc = applyHexBleedProc(nextState, monster.id);
    nextState = hexProc.state;
    events.push(...hexProc.events);
  }

  // Rogue — Lethal Strikes: crits apply bleed.
  if (isCrit && !monsterKilled) {
    const ls = applyRogueLethalStrike(nextState, tickedActor, monster.id);
    nextState = ls.state;
    events.push(...ls.events);
  }

  // Rogue — Envenom Weapon: next hit after ability applies poison.
  if (!monsterKilled) {
    const env = applyEnvenomProc(nextState, tickedActor, monster.id);
    nextState = env.state;
    events.push(...env.events);
  }

  // Elemental weapon proc.
  if (!monsterKilled) {
    const proc = applyElementalProc(nextState, tickedActor, monster.id, roll);
    nextState = proc.state;
    events.push(...proc.events);
  }

  if (monsterKilled) return resolveMonsterKill(nextState, monster.id, actorId, events);
  nextState = advanceTurn(nextState);
  return { state: nextState, events: [...events, ...turnStartEvent(nextState)] };
}

// AoE variant: execute() is called once and returns one deal_damage per live
// monster. Applies all hits, then resolves kills (victory if all dead, otherwise
// advance turn). No drink-buff or shocked-amp logic — AoE trades per-target
// modifiers for reach.
function handleAoeDamageAbility(
  state: CombatState,
  actorId: ActorId,
  tickedActor: CombatFighter,
  ability: ActiveAbilityDef,
  preEvents: CombatEvent[],
  roll: RollFn,
): StepResult {
  const liveMonsters = state.monsters.filter((m) => m.hp > 0);
  const ctx: AbilityContext = {
    caster: tickedActor,
    party: state.fighters.filter((f) => f.hp > 0),
    monsters: liveMonsters,
    roll,
  };

  const effects = ability.execute(ctx);
  const dmgEffects = effects.filter(
    (e): e is Extract<AbilityEffect, { kind: "deal_damage" }> => e.kind === "deal_damage",
  );
  if (dmgEffects.length === 0) return reject(state, `${ability.id} produced no AoE damage effects`);

  const events: CombatEvent[] = [...preEvents];
  let nextState: CombatState = state;

  for (const dmgEffect of dmgEffects) {
    const monster = nextState.monsters.find((m) => m.id === dmgEffect.target_id && m.hp > 0);
    if (!monster) continue; // already killed earlier in this loop

    const finalDamage = dmgEffect.amount;
    const newHp = Math.max(0, monster.hp - finalDamage);

    events.push({
      type: "player_hit",
      actor: actorId,
      target: monster.id,
      damage: finalDamage,
      armor_absorbed: 0,
      crit: dmgEffect.is_crit ?? false,
      formula: dmgEffect.formula,
    });

    nextState = {
      ...nextState,
      monsters: nextState.monsters.map((m) => m.id === monster.id ? { ...m, hp: newHp } : m),
      contribution: {
        ...nextState.contribution,
        [actorId]: (nextState.contribution[actorId] ?? 0) + finalDamage,
      },
    };
  }

  // Check kills after all damage is applied.
  const killedIds = nextState.monsters.filter((m) => m.hp <= 0).map((m) => m.id);

  if (killedIds.length === 0) {
    nextState = advanceTurn(nextState);
    return { state: nextState, events: [...events, ...turnStartEvent(nextState)] };
  }

  // At least one monster killed — run resolveMonsterKill once for the last
  // one (it checks all monsters to decide victory vs. continue).
  for (let i = 0; i < killedIds.length - 1; i++) {
    events.push({ type: "monster_down", killed_by: actorId });
    nextState = {
      ...nextState,
      stats: {
        ...nextState.stats,
        [actorId]: {
          ...(nextState.stats[actorId] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
          kills: (nextState.stats[actorId]?.kills ?? 0) + 1,
        },
      },
    };
  }
  return resolveMonsterKill(nextState, killedIds[killedIds.length - 1], actorId, events);
}

function handleFlee(
  state: CombatState,
  action: { kind: "flee"; actor: ActorId },
  roll: RollFn,
): StepResult {
  const actor = state.fighters.find((f) => f.id === action.actor);
  if (!actor) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (actor.hp <= 0) return reject(state, `${action.actor} is downed`);

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const tickedActor = s.fighters.find((f) => f.id === action.actor)!;

  // d20 + max(atk, mag) vs DC = 10 + monster.tier. Flexible — fighter-y
  // classes get atk, caster-y classes get mag; nobody is locked out.
  const fleeMonster = s.monsters.find((m) => m.hp > 0) ?? s.monsters[0];
  const d20 = roll(20);
  const modifier = Math.max(tickedActor.attack_mod, tickedActor.magic_mod);
  const dc = 10 + (fleeMonster?.tier ?? 1);
  const total = d20 + modifier;
  // Natural 20 always escapes — a perfect roll should never punish the player.
  const success = d20 === 20 || total >= dc;

  const events: CombatEvent[] = [
    ...tick.events,
    { type: "roll", actor: action.actor, die: "d20", value: d20, purpose: "flee_check" },
    { type: "flee_check", actor: action.actor, roll: d20, modifier, total, dc, success },
  ];

  if (success) {
    events.push({ type: "fled" });
    return { state: { ...s, status: "fled" }, events };
  }

  // Failed flee: free hit from the monster. No d20 to hit (you're exposed),
  // no armor mitigation (back turned) — treat as physical with 0 armor.
  const alive = s.fighters.filter((f) => f.hp > 0);
  const bossPhase2 = (fleeMonster?.is_boss && fleeMonster?.boss_phase === 2) ?? false;
  const hit = resolveMonsterHit(fleeMonster?.tier ?? 1, alive.length, 0, bossPhase2, roll, "physical", 0, fleeMonster?.damage_roll ?? "1d4");
  const positionAdjusted = positionDamageMod(tickedActor.position, hit.final);
  const { newShield, newHp, shieldAbsorbed, hpDamage } = applyDamageWithShield(
    positionAdjusted,
    tickedActor.shield,
    tickedActor.hp,
  );

  events.push({
    type: "monster_attack",
    actor: fleeMonster?.id ?? MONSTER_ID,
    target: action.actor,
    damage_type: "physical",
    raw_damage: hit.raw,
    damage_after_position: positionAdjusted,
    damage_after_mitigation: hit.final,
    armor_reduction: hit.armorReduction,
    resistance_reduction: 0,
    shield_absorbed: shieldAbsorbed,
    hp_damage: hpDamage,
  });

  const updatedFighters = s.fighters.map((f) =>
    f.id === action.actor ? { ...f, hp: Math.max(0, newHp), shield: newShield } : f,
  );
  if (newHp <= 0 && tickedActor.hp > 0) {
    events.push({ type: "fighter_down", target: action.actor });
  }
  const allDown = updatedFighters.every((f) => f.hp <= 0);
  let next: CombatState = {
    ...s,
    fighters: updatedFighters,
    stats: {
      ...s.stats,
      [action.actor]: {
        ...(s.stats[action.actor] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
        damage_taken: (s.stats[action.actor]?.damage_taken ?? 0) + hpDamage,
      },
    },
  };
  if (allDown) {
    events.push({ type: "defeat" });
    return { state: { ...next, status: "defeat" }, events };
  }
  next = advanceTurn(next);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

// ── Class abilities ───────────────────────────────────────────────────────
//
// Single entry point. Looks up the ActiveAbilityDef from the actor's class,
// validates mana, then routes based on ability.routing:
//   "aoe_damage"  — AoE path (no per-target modifiers)
//   "damage"      — single-target damage (drink buffs, shocked amp, bleed, etc.)
//   "utility"     — generic effect applicator driven by execute() output

function handleAbility(
  state: CombatState,
  action: {
    kind: "ability";
    actor: ActorId;
    ability_id: AbilityId;
    target_id?: ActorId;
    target?: ActorId;
    position?: BattlePosition;
  },
  roll: RollFn,
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);

  const cls = classByName(fighter.class);
  const ability = cls.abilities.find(
    (a): a is ActiveAbilityDef => a.kind === "active" && a.id === action.ability_id,
  );
  if (!ability) {
    return reject(state, `${fighter.class} has no active ability with id ${action.ability_id}`);
  }

  if (fighter.mana < ability.mana_cost) {
    return reject(state, `not enough mana (need ${ability.mana_cost})`);
  }
  const remainingCooldown = state.cooldowns?.[action.actor]?.[ability.id] ?? 0;
  if (remainingCooldown > 0) {
    return reject(state, `${ability.name} is on cooldown (${remainingCooldown} turn${remainingCooldown !== 1 ? "s" : ""} remaining)`);
  }

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const tickedActor = s.fighters.find((f) => f.id === action.actor)!;

  const sPostMana: CombatState = {
    ...s,
    fighters: s.fighters.map((f) =>
      f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - ability.mana_cost) } : f,
    ),
    ...(ability.cooldown_turns ? {
      cooldowns: {
        ...(s.cooldowns ?? {}),
        [action.actor]: {
          ...(s.cooldowns?.[action.actor] ?? {}),
          [ability.id]: ability.cooldown_turns + 1,
        },
      },
    } : {}),
  };

  const usedEvent: CombatEvent = {
    type: "ability_used",
    actor: action.actor,
    ability_id: ability.id,
    name: ability.name,
    mana_spent: ability.mana_cost,
  };
  const preEvents: CombatEvent[] = [...tick.events, usedEvent];

  // ── AoE damage ──
  if (ability.routing === "aoe_damage") {
    if (sPostMana.monsters.filter((m) => m.hp > 0).length === 0) return reject(sPostMana, "no valid targets");
    return handleAoeDamageAbility(sPostMana, action.actor, tickedActor, ability, preEvents, roll);
  }

  // ── Single-target damage ──
  if (ability.routing === "damage") {
    const targetMonster = action.target_id
      ? sPostMana.monsters.find((m) => m.id === action.target_id && m.hp > 0)
      : sPostMana.monsters.find((m) => m.hp > 0);
    if (!targetMonster) return reject(sPostMana, "no valid target");
    const ctx: AbilityContext = {
      caster: tickedActor,
      party: sPostMana.fighters.filter((f) => f.hp > 0),
      monsters: sPostMana.monsters.filter((m) => m.hp > 0),
      target: targetMonster,
      roll,
    };
    return handleDamageAbility(sPostMana, action.actor, tickedActor, ability, ctx, targetMonster, preEvents, roll);
  }

  // ── Utility ──
  // Resolve the target for execute() based on ability.target kind.
  let ctxTarget: CombatFighter | CombatMonster | undefined;
  if (ability.target === "single_enemy") {
    ctxTarget = action.target_id
      ? sPostMana.monsters.find((m) => m.id === action.target_id && m.hp > 0)
      : sPostMana.monsters.find((m) => m.hp > 0);
  } else if (ability.target === "single_ally") {
    ctxTarget = sPostMana.fighters.find((f) => f.id === (action.target ?? action.actor) && f.hp > 0);
  } else if (ability.target === "any") {
    // target_id = monster pick; target = fighter pick
    ctxTarget = action.target_id
      ? sPostMana.monsters.find((m) => m.id === action.target_id && m.hp > 0)
      : sPostMana.fighters.find((f) => f.id === action.target && f.hp > 0);
  } else if (ability.target === "self") {
    ctxTarget = tickedActor;
  }
  const protectForCtx = sPostMana.ability_state?.paladin_protect;
  const ctx: AbilityContext = {
    caster: tickedActor,
    party: sPostMana.fighters.filter((f) => f.hp > 0),
    monsters: sPostMana.monsters.filter((m) => m.hp > 0),
    target: ctxTarget,
    roll,
    position: action.position,
    protected_ally_id: protectForCtx?.paladin_id === action.actor ? protectForCtx?.target_id : undefined,
  };
  return applyUtilityAbilityEffects(sPostMana, ability.execute(ctx), action.actor, preEvents, roll);
}

// Generic applicator for utility ability effects. Iterates AbilityEffect[] from
// execute() and applies each one to state, collecting events. A deal_damage that
// kills a monster immediately fires resolveMonsterKill; remaining effects are skipped.
function applyUtilityAbilityEffects(
  state: CombatState,
  effects: AbilityEffect[],
  actor: ActorId,
  preEvents: CombatEvent[],
  roll: RollFn,
): StepResult {
  let s = state;
  const events: CombatEvent[] = [...preEvents];

  for (const effect of effects) {
    switch (effect.kind) {
      case "deal_damage": {
        const monster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!monster) continue;
        const ddWeakness = effect.damage_type && monster.damage_weakness === effect.damage_type ? 1.3 : 1.0;
        const ddResist = effect.damage_type && monster.damage_resistance === effect.damage_type ? 0.7 : 1.0;
        const ddAmount = Math.max(1, Math.round(effect.amount * ddWeakness * ddResist));
        const newHp = Math.max(0, monster.hp - ddAmount);
        events.push({
          type: "player_hit",
          actor,
          target: monster.id,
          damage: ddAmount,
          armor_absorbed: 0,
          crit: effect.is_crit ?? false,
          formula: effect.formula,
          damage_type: effect.damage_type,
        });
        s = {
          ...s,
          monsters: s.monsters.map((m) => m.id === monster.id ? { ...m, hp: newHp } : m),
          contribution: { ...s.contribution, [actor]: (s.contribution[actor] ?? 0) + ddAmount },
        };
        s = accumulateIllOmenDamage(s, monster.id, monster.hp - newHp);
        if (newHp <= 0) return resolveMonsterKill(s, monster.id, actor, events);
        // Sinister Queries passive and hex bleed proc fire on any damage hit.
        const casterFighter = s.fighters.find((f) => f.id === actor);
        if (casterFighter) {
          const sq = applySinisterQueries(s, casterFighter, monster.id);
          s = sq.state;
          events.push(...sq.events);
        }
        const hexProc = applyHexBleedProc(s, monster.id);
        s = hexProc.state;
        events.push(...hexProc.events);
        break;
      }
      case "heal": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const newHp = Math.min(target.max_hp, target.hp + effect.amount);
        const applied = newHp - target.hp;
        if (applied > 0) {
          events.push({ type: "heal_applied", actor, target: effect.target_id, amount: applied, rolled: effect.amount });
          s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, hp: newHp } : f) };
        }
        break;
      }
      case "grant_shield": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const shieldCap = target.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(target, s.ability_state, s.round);
        const newShield = Math.min(shieldCap, target.shield + effect.amount);
        const restored = newShield - target.shield;
        if (restored > 0) {
          events.push({ type: "shield_applied", actor, target: effect.target_id, restored, new_armor: newShield, bonus_barrier: false });
          s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, shield: newShield } : f) };
        }
        break;
      }
      case "grant_shield_all": {
        const grants: { target: ActorId; amount: number }[] = [];
        s = {
          ...s,
          fighters: s.fighters.map((f) => {
            if (f.hp <= 0) return f;
            const cap = f.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(f, s.ability_state, s.round);
            const newShield = Math.min(cap, f.shield + effect.amount);
            const added = newShield - f.shield;
            if (added > 0) grants.push({ target: f.id, amount: added });
            return added > 0 ? { ...f, shield: newShield } : f;
          }),
        };
        events.push({ type: "ability_regression_shield", actor, grants });
        break;
      }
      case "grant_shield_from_armor": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const effectiveArmor = target.armor_power + resilientBonus(target, s.ability_state, s.round);
        const shieldCap = target.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(target, s.ability_state, s.round);
        const newShield = Math.min(shieldCap, target.shield + Math.floor(effectiveArmor * effect.fraction));
        const restored = newShield - target.shield;
        if (restored > 0) {
          events.push({ type: "shield_applied", actor, target: effect.target_id, restored, new_armor: newShield, bonus_barrier: false });
          s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, shield: newShield } : f) };
        }
        break;
      }
      case "stun_monster": {
        const targetMonster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!targetMonster) continue;
        const isBoss = targetMonster.is_boss;
        const bpt = (isBoss && effect.boss_break_pct_per_turn != null)
          ? effect.boss_break_pct_per_turn
          : effect.break_pct_per_turn;
        const stunnedEffect: MachineStatusEffect = {
          type: "stunned",
          magnitude: bpt,
          remaining: 5,
          source: actor,
          pill_suffix: `${Math.min(100, bpt)}% break`,
        };
        s = {
          ...s,
          monsters: s.monsters.map((m) =>
            m.id === targetMonster.id
              ? { ...m, effects: [...m.effects.filter((e) => e.type !== "stunned"), stunnedEffect] }
              : m,
          ),
        };
        events.push({ type: "ability_containerize" });
        break;
      }
      case "restore_mana": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target) continue;
        const newMana = Math.min(target.max_mana, target.mana + effect.amount);
        if (newMana > target.mana) {
          s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, mana: newMana } : f) };
        }
        break;
      }
      case "set_taunt": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          taunt: { actor_id: effect.actor_id, swings_remaining: effect.swings },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_taunt", actor: effect.actor_id, swings: effect.swings });
        break;
      }
      case "set_vanish": {
        const prev = s.ability_state?.vanished ?? {};
        let ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          vanished: { ...prev, [effect.actor_id]: effect.swings },
        };
        if (ability_state.taunt?.actor_id === effect.actor_id) {
          ability_state = stripField(ability_state, "taunt") ?? {};
        }
        s = { ...s, ability_state };
        events.push({ type: "ability_vanish", actor: effect.actor_id, swings: effect.swings });
        break;
      }
      case "add_battle_hymn": {
        const expiresAfterRound = s.round + effect.rounds - 1;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          battle_hymn: { expires_after_round: expiresAfterRound },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_battle_hymn", actor, expires_after_round: expiresAfterRound });
        break;
      }
      case "move_fighter": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const from = target.position;
        s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, position: effect.to } : f) };
        events.push({ type: "ability_migrate", actor, target: effect.target_id, from, to: effect.to });
        break;
      }
      case "hex_monster": {
        const target = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!target) break;
        const hexEffect: MachineStatusEffect = {
          type: "hexed",
          magnitude: 1,
          remaining: effect.duration,
          source: actor,
        };
        s = {
          ...s,
          monsters: s.monsters.map((m) =>
            m.id === target.id ? { ...m, effects: mergeEffect(m.effects, hexEffect) } : m,
          ),
        };
        events.push({ type: "ability_hex", actor, target: target.id, duration: effect.duration });
        break;
      }
      case "consume_monster_bleed": {
        const target = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!target) break;
        s = {
          ...s,
          monsters: s.monsters.map((m) =>
            m.id === target.id ? { ...m, effects: m.effects.filter((e) => e.type !== "bleeding") } : m,
          ),
        };
        break;
      }
      case "grant_encourage": {
        const prev = s.ability_state?.encourage ?? {};
        const prevCharges = prev[effect.target_id] ?? 0;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          encourage: { ...prev, [effect.target_id]: prevCharges + effect.charges },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_encourage", actor, target: effect.target_id, charges: effect.charges });
        break;
      }
      case "apply_discourage": {
        const prev = s.ability_state?.discourage ?? {};
        const prevCharges = prev[effect.target_id] ?? 0;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          discourage: { ...prev, [effect.target_id]: prevCharges + effect.charges },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_mock", actor, target: effect.target_id, charges: effect.charges });
        break;
      }
      case "apply_shield_of_faith": {
        const expiresAfterRound = s.round + effect.rounds - 1;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          shield_of_faith: { expires_after_round: expiresAfterRound },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_shield_of_faith", actor, expires_after_round: expiresAfterRound });
        break;
      }
      case "apply_protect": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          paladin_protect: { paladin_id: actor, target_id: effect.target_id },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_protect", actor, target: effect.target_id });
        break;
      }
      case "apply_smite_debuff": {
        const prev = s.ability_state?.paladin_smite_debuff ?? {};
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          paladin_smite_debuff: { ...prev, [effect.target_id]: 1 },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_smite_debuff", actor, target: effect.target_id });
        break;
      }
      case "attack_roll_damage": {
        // Machine-side d20 hit check with optional advantage. Calls the same
        // encourage/advantage logic as handleAttack; on a miss the loop continues
        // to the next effect (turn will advance after all effects are processed).
        const targetMonster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!targetMonster) continue;
        const fighter = s.fighters.find((f) => f.id === actor);
        if (!fighter) continue;

        let d20 = roll(20);
        const encourageCharges = s.ability_state?.encourage?.[actor] ?? 0;
        if (encourageCharges > 0 || effect.advantage) {
          const d20b = roll(20);
          const took = Math.max(d20, d20b);
          events.push({ type: "advantage_used", actor, d20_a: d20, d20_b: d20b, took });
          d20 = took;
          if (encourageCharges > 0) {
            s = { ...s, ability_state: consumeEncourageCharge(s.ability_state, actor) };
          }
        }
        const atkAc = monsterAc(targetMonster.tier);
        const hitTotal = d20 + effect.hit_mod;
        const landed = hitTotal >= atkAc;
        events.push({ type: "roll", actor, die: "d20", value: d20, purpose: "hit_check" });
        events.push({ type: "hit_check", actor, target: targetMonster.id, roll: d20, modifier: effect.hit_mod, total: hitTotal, ac: atkAc, hit: landed });

        if (!landed) break;

        const isCrit = effect.is_crit ?? false;
        const atkVulnMult = vulnerabilityMult(s, targetMonster.id, s.round);
        const atkDamage = Math.max(1, Math.round(effect.amount * atkVulnMult));
        events.push({ type: "player_hit", actor, target: targetMonster.id, damage: atkDamage, armor_absorbed: 0, crit: isCrit, formula: effect.formula });
        const newHp = Math.max(0, targetMonster.hp - atkDamage);
        s = {
          ...s,
          monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, hp: newHp } : m),
          contribution: { ...s.contribution, [actor]: (s.contribution[actor] ?? 0) + atkDamage },
        };
        s = accumulateIllOmenDamage(s, targetMonster.id, atkDamage);
        if (newHp <= 0) return resolveMonsterKill(s, targetMonster.id, actor, events);

        // Staff Sage — Ray of Frost: 25% chance to freeze on hit.
        if (effect.freeze_chance && roll(100) <= effect.freeze_chance) {
          const frozenEff: MachineStatusEffect = { type: "frozen", magnitude: 1, remaining: 1, source: actor };
          s = { ...s, monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, effects: mergeEffect(m.effects, frozenEff) } : m) };
          events.push({ type: "ability_freeze_applied", actor, target: targetMonster.id });
        }

        if (isCrit) {
          const lsAfterAtk = applyRogueLethalStrike(s, fighter, targetMonster.id);
          s = lsAfterAtk.state; events.push(...lsAfterAtk.events);
        }
        const envAfterAtk = applyEnvenomProc(s, fighter, targetMonster.id);
        s = envAfterAtk.state; events.push(...envAfterAtk.events);
        const sqAfterAtk = applySinisterQueries(s, fighter, targetMonster.id);
        s = sqAfterAtk.state; events.push(...sqAfterAtk.events);
        const rr = applyWardenResilient(s, fighter);
        s = rr.state;events.push(...rr.events);
        const hexAfterAtk = applyHexBleedProc(s, targetMonster.id);
        s = hexAfterAtk.state; events.push(...hexAfterAtk.events);
        break;
      }
      case "apply_bleed": {
        const targetMonster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!targetMonster) continue;
        const bleedEffect: MachineStatusEffect = { type: "bleeding", magnitude: effect.stacks, remaining: effect.duration, source: actor };
        s = { ...s, monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, effects: mergeEffect(m.effects, bleedEffect) } : m) };
        events.push({ type: "passive_rogue_lethal_strike", actor, magnitude: effect.stacks, duration: effect.duration });
        break;
      }
      case "apply_poison": {
        const targetMonster = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!targetMonster) continue;
        const poisonEffect: MachineStatusEffect = { type: "poisoned", magnitude: effect.stacks, remaining: effect.duration, source: actor };
        s = { ...s, monsters: s.monsters.map((m) => m.id === targetMonster.id ? { ...m, effects: mergeEffect(m.effects, poisonEffect) } : m) };
        events.push({ type: "ability_envenom_proc", actor, target: targetMonster.id, stacks: effect.stacks });
        break;
      }
      case "apply_envenom_weapon": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          envenomed_weapon: { ...(s.ability_state?.envenomed_weapon ?? {}), [actor]: { stacks: effect.stacks, charges: 2 } },
        };
        s = { ...s, ability_state };
        break;
      }
      case "apply_vulnerability": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          vulnerable: {
            ...(s.ability_state?.vulnerable ?? {}),
            [effect.target_id]: { expires_after_round: s.round + effect.rounds - 1, magnitude: effect.magnitude },
          },
        };
        s = { ...s, ability_state };
        break;
      }
      case "set_damage_reduction": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          brace: {
            ...(s.ability_state?.brace ?? {}),
            [effect.target_id]: { pct: effect.pct, turns_remaining: effect.turns },
          },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_brace", actor, turns: effect.turns });
        break;
      }
      case "apply_fighter_regen": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const regenEffect = { type: "regen" as const, magnitude: effect.magnitude, remaining: effect.duration, source: actor };
        s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, effects: mergeEffect(f.effects, regenEffect) } : f) };
        events.push({ type: "ability_regeneration", actor, target: effect.target_id, magnitude: effect.magnitude, duration: effect.duration });
        break;
      }
      case "apply_animal_form": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target) continue;
        const atkDelta = target.stats
          ? Math.floor((target.stats.str + effect.str_bonus - 5) / 2) - Math.floor((target.stats.str - 5) / 2)
          : Math.floor(effect.str_bonus / 2);
        const hpDelta = 2 * effect.vit_bonus;
        const newMaxHp = target.max_hp + hpDelta;
        const newHp = Math.min(newMaxHp, target.hp + hpDelta);
        const buffedFighter = {
          ...target,
          attack_mod: target.attack_mod + atkDelta,
          max_hp: newMaxHp,
          hp: newHp,
          ...(target.stats ? {
            stats: {
              ...target.stats,
              str: target.stats.str + effect.str_bonus,
              vit: target.stats.vit + effect.vit_bonus,
              agi: target.stats.agi + effect.agi_bonus,
              dex: target.stats.dex + effect.dex_bonus,
            },
          } : {}),
        };
        const animalFormEff = { type: "animal_form" as const, magnitude: 1, remaining: effect.turns, source: actor };
        s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...buffedFighter, effects: mergeEffect(buffedFighter.effects, animalFormEff) } : f) };
        s = {
          ...s,
          ability_state: {
            ...(s.ability_state ?? {}),
            animal_form: {
              ...(s.ability_state?.animal_form ?? {}),
              [effect.target_id]: {
                str_bonus: effect.str_bonus, vit_bonus: effect.vit_bonus,
                agi_bonus: effect.agi_bonus, dex_bonus: effect.dex_bonus,
                atk_delta: atkDelta, hp_delta: hpDelta,
                turns_remaining: effect.turns,
              },
            },
          },
        };
        events.push({ type: "ability_animal_form", actor, str_bonus: effect.str_bonus, vit_bonus: effect.vit_bonus, agi_bonus: effect.agi_bonus, dex_bonus: effect.dex_bonus, turns: effect.turns });
        break;
      }
      case "apply_barkskin": {
        const target = s.fighters.find((f) => f.id === effect.target_id);
        if (!target || target.hp <= 0) continue;
        const barkskinEff = { type: "barkskin" as const, magnitude: effect.bonus, remaining: effect.turns, source: actor };
        s = { ...s, fighters: s.fighters.map((f) => f.id === effect.target_id ? { ...f, effects: mergeEffect(f.effects, barkskinEff) } : f) };
        events.push({ type: "ability_barkskin", actor, target: effect.target_id, bonus: effect.bonus, turns: effect.turns });
        break;
      }
      case "entangle_monster": {
        const target = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!target) continue;
        const entangleEff = { type: "entangled" as const, magnitude: 1, remaining: effect.duration, source: actor };
        s = { ...s, monsters: s.monsters.map((m) => m.id === effect.target_id ? { ...m, effects: mergeEffect(m.effects, entangleEff) } : m) };
        events.push({ type: "ability_wildgrowth_entangle", actor, target: effect.target_id, duration: effect.duration });
        break;
      }
      case "apply_taunt_fortify": {
        s = {
          ...s,
          ability_state: {
            ...(s.ability_state ?? {}),
            taunt_fortify: {
              ...(s.ability_state?.taunt_fortify ?? {}),
              [effect.target_id]: { turns_remaining: effect.turns },
            },
          },
        };
        events.push({ type: "ability_taunt_fortify", actor, turns: effect.turns });
        break;
      }
      case "summon_ally_npc": {
        const { spec, id_suffix } = effect;
        const idPrefix = `__ally_${id_suffix}_${actor}_`;
        const count = s.fighters.filter((f) => f.id.startsWith(idPrefix)).length;
        const npcId: ActorId = `${idPrefix}${count}__`;
        const npc: CombatFighter = {
          id: npcId,
          name: spec.name,
          class: spec.class_label,
          level: spec.level,
          hp: spec.hp,
          max_hp: spec.hp,
          mana: 0,
          max_mana: 0,
          shield: 0,
          position: spec.position,
          attack_mod: spec.attack_mod,
          magic_mod: 0,
          weapon_power: spec.weapon_power,
          focus_power: 0,
          weapon_range: spec.weapon_range,
          damage_roll: spec.damage_roll,
          slack_username: null,
          armor_power: 0,
          initiative: 0,
          effects: [],
          scars: [],
        };
        // Insert the NPC at the current actor's array position and adjust
        // turn_index so it still resolves to the same actor. This places the
        // NPC "behind" the current position in the circular order, meaning it
        // won't act until the next cycle — summoning costs the caster's turn.
        const oldLen = s.turn_order.length;
        const pos = s.turn_index % oldLen;
        const newTurnOrder = [...s.turn_order.slice(0, pos), npcId, ...s.turn_order.slice(pos)];
        const newTurnIndex = (pos + 1) + Math.floor(s.turn_index / oldLen) * (oldLen + 1);
        s = {
          ...s,
          fighters: [...s.fighters, npc],
          turn_order: newTurnOrder,
          turn_index: newTurnIndex,
        };
        events.push({ type: "ally_npc_summoned", actor, npc_id: npcId, name: spec.name });
        break;
      }
      case "apply_blizzard": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          blizzard: { caster_id: effect.caster_id, mag: effect.mag, charges: 3 },
        };
        s = { ...s, ability_state };
        break;
      }
      case "apply_good_fortune": {
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          good_fortune: { caster_id: effect.caster_id, target_id: effect.target_id, amount: effect.delayed_amount },
        };
        s = { ...s, ability_state };
        break;
      }
      case "apply_ill_omen": {
        const omenTarget = s.monsters.find((m) => m.id === effect.target_id && m.hp > 0);
        if (!omenTarget) continue;
        const ability_state: AbilityRuntimeState = {
          ...(s.ability_state ?? {}),
          ill_omen: {
            ...(s.ability_state?.ill_omen ?? {}),
            [effect.target_id]: { caster_id: effect.caster_id, accumulated: 0, monster_turns_remaining: 3 },
          },
        };
        s = { ...s, ability_state };
        events.push({ type: "ability_ill_omen_applied", actor, target: effect.target_id });
        break;
      }
    }
  }

  // Staff Sage — Blizzard: fire end-of-turn AoE tick.
  const blizzTick = applyBlizzardTick(s, actor, roll);
  s = blizzTick.state;
  events.push(...blizzTick.events);
  for (const killedId of blizzTick.killed) {
    const killResult = resolveMonsterKill(s, killedId, actor, events);
    if (killResult.state.status !== "active") return killResult;
    s = killResult.state;
    events.length = 0;
    events.push(...killResult.events);
  }

  const next = advanceTurn(s);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

// Builds the full Foresee intel payload from current state. Shared between
// the initial cast and subsequent turn refreshes.
function buildForeseeEvent(
  state: CombatState,
  actor: ActorId,
  roll: RollFn,
  turnsRemaining: number,
  precomputedTarget?: ActorId | null,
): Extract<CombatEvent, { type: "ability_foresee" }> {
  const aliveFighters = state.fighters.filter((f) => f.hp > 0);
  const abilityState = state.ability_state ?? {};
  const vanishedMap = abilityState.vanished ?? {};
  const partyBonus = Math.floor((Math.max(1, aliveFighters.length) - 1) / 2);
  // Foresee targets the first alive monster (primary threat).
  const foreseeMon = state.monsters.find((m) => m.hp > 0) ?? state.monsters[0];
  const isBossP2 = foreseeMon?.is_boss && foreseeMon?.boss_phase === 2;
  const bossBonus = isBossP2 ? (foreseeMon?.tier ?? 0) : 0;
  const tier = foreseeMon?.tier ?? 1;
  const rawLo = 1 + tier + partyBonus + bossBonus;
  const rawHi = 4 + tier + partyBonus + bossBonus;

  const taunted = abilityState.taunt;

  // Determine confirmed/predicted target.
  // When a precomputedTarget is explicitly provided (even null), use it directly
  // — it was pre-rolled by withForeseeForSage and is guaranteed to match the
  // actual attack. Only do the fallback probabilistic roll when the parameter
  // was not provided at all (undefined).
  let predicted: ActorId | null;
  if (precomputedTarget !== undefined) {
    predicted = precomputedTarget;
  } else {
    predicted = null;
    if (taunted && taunted.swings_remaining > 0) {
      const tauntTarget = aliveFighters.find((f) => f.id === taunted.actor_id);
      if (tauntTarget) predicted = tauntTarget.id;
    }
    if (!predicted && aliveFighters.length > 0) {
      const eligible = aliveFighters.filter((f) => (vanishedMap[f.id] ?? 0) <= 0);
      const pool = eligible.length > 0 ? eligible : aliveFighters;
      predicted = pickMonsterTarget(pool, () => roll(101) / 100).id;
    }
  }

  // Net damage range for the predicted target.
  const targetFighter = predicted ? aliveFighters.find((f) => f.id === predicted) : null;
  let netLo = rawLo;
  let netHi = rawHi;
  let verdict: "safe" | "at_risk" | "lethal" = "safe";
  if (targetFighter) {
    const armorReduction = Math.floor(targetFighter.armor_power / 2);
    const isBack = targetFighter.position === "back";
    netLo = isBack
      ? Math.max(1, Math.round((rawLo - armorReduction) * 0.6))
      : Math.max(1, rawLo - armorReduction);
    netHi = isBack
      ? Math.max(1, Math.round((rawHi - armorReduction) * 0.6))
      : Math.max(1, rawHi - armorReduction);
    verdict = targetFighter.hp > netHi ? "safe"
      : targetFighter.hp <= netLo ? "lethal"
      : "at_risk";
  }

  // Targeting probabilities for each non-vanished alive fighter.
  const targetable = aliveFighters.filter((f) => (vanishedMap[f.id] ?? 0) <= 0);
  const weights = targetable.map((f) => (f.position === "back" ? 1 : 3));
  const total = weights.reduce((a, b) => a + b, 0);
  const probabilities = targetable.map((f, i) => ({
    id: f.id,
    position: f.position,
    pct: Math.round((weights[i] / total) * 100),
  }));

  // Party triage snapshot.
  const triage = aliveFighters.map((f) => ({
    id: f.id, hp: f.hp, max_hp: f.max_hp, shield: f.shield, position: f.position,
  }));

  // Active effects summary.
  const vanishedIds = Object.entries(vanishedMap)
    .filter(([, v]) => v > 0)
    .map(([id]) => id);
  const liveMonster = state.monsters.find((m) => m.hp > 0);
  const active = {
    stunned: liveMonster?.effects.some((e) => e.type === "stunned") ? 1 : 0,
    taunt_actor: taunted && taunted.swings_remaining > 0 ? taunted.actor_id : null,
    taunt_swings: taunted?.swings_remaining ?? 0,
    vanished: vanishedIds,
  };

  return {
    type: "ability_foresee",
    actor,
    predicted_target: predicted,
    predicted_targets: { ...(state.ability_state?.foretold_targets ?? {}) },
    damage_lo: rawLo,
    damage_hi: rawHi,
    net_lo: netLo,
    net_hi: netHi,
    verdict,
    probabilities,
    triage,
    active,
    turns_remaining: turnsRemaining,
  };
}

// Pre-rolls fighter targets for every alive monster that will act between
// `fromIndex` (inclusive, in turn_order) and the sage's next turn (exclusive).
// Stores each result in ability_state.foretold_targets keyed by monster ID so
// handleMonsterAct can use the exact same value — making every prediction correct.
// Returns the updated state and the target for the first upcoming monster (used
// as the displayed prediction in the foresee event).
function prerollMonsterTargets(
  state: CombatState,
  fromIndex: number,
  roll: RollFn,
): { state: CombatState; primaryTarget: ActorId | null } {
  const order = state.turn_order;
  const n = order.length;
  if (n === 0) return { state, primaryTarget: null };

  // Find how many steps forward until the sage (stops at sage's position).
  let sageSteps = -1;
  for (let i = 0; i < n; i++) {
    const id = order[(fromIndex + i) % n];
    const f = state.fighters.find((f) => f.id === id && f.hp > 0 && classHasPassive(f.class, "foretell"));
    if (f) { sageSteps = i; break; }
  }
  if (sageSteps <= 0) return { state, primaryTarget: null };

  const abilityState = state.ability_state ?? {};
  const vanishedMap = abilityState.vanished ?? {};
  const taunted = abilityState.taunt;
  const aliveFighters = state.fighters.filter((f) => f.hp > 0);
  const foretoldTargets: Record<ActorId, ActorId> = { ...(abilityState.foretold_targets ?? {}) };
  let primaryTarget: ActorId | null = null;

  for (let i = 0; i < sageSteps; i++) {
    const monsterId = order[(fromIndex + i) % n];
    if (!isMonsterActor(monsterId)) continue;
    if (!state.monsters.find((m) => m.id === monsterId && m.hp > 0)) continue;

    let target: ActorId | null = null;
    if (taunted && taunted.swings_remaining > 0) {
      const tauntFighter = aliveFighters.find((f) => f.id === taunted.actor_id);
      if (tauntFighter) target = tauntFighter.id;
    }
    if (!target) {
      const eligible = aliveFighters.filter((f) => (vanishedMap[f.id] ?? 0) <= 0);
      const pool = eligible.length > 0 ? eligible : aliveFighters;
      if (pool.length > 0) target = pickMonsterTarget(pool, () => roll(101) / 100).id;
    }
    if (target) {
      foretoldTargets[monsterId] = target;
      if (primaryTarget === null) primaryTarget = target;
    }
  }

  const newAbilityState = Object.keys(foretoldTargets).length > 0
    ? { ...abilityState, foretold_targets: foretoldTargets }
    : abilityState;
  return { state: { ...state, ability_state: newAbilityState }, primaryTarget };
}

// Core: builds and injects the foresee event into result, using sageId as the
// event actor. Pre-rolls targets for all monsters between fromIndex and the sage.
function withForeseeForSage(
  result: StepResult,
  sageId: ActorId,
  fromIndex: number,
  roll: RollFn,
): StepResult {
  const { state: stateWithTargets, primaryTarget } = prerollMonsterTargets(result.state, fromIndex, roll);
  const refreshEvent = buildForeseeEvent(stateWithTargets, sageId, roll, 99, primaryTarget);

  // Insert before the last turn_start so the readout appears at the top of the
  // next relevant turn block rather than at the tail of the preceding action.
  const events = [...result.events];
  let insertAt = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "turn_start") { insertAt = i; break; }
  }
  events.splice(insertAt, 0, refreshEvent);
  return { state: stateWithTargets, events };
}

// After the monster (or ally NPC) acts, checks if the next actor is a Staff
// Sage with the Foretell passive and, if so, fires foresee so the Sage sees
// fresh intel at the top of their upcoming turn.
function withForeseeForNextActor(result: StepResult, roll: RollFn): StepResult {
  const actorId = currentActor(result.state);
  if (!actorId || isMonsterActor(actorId)) return result;
  if (!result.state.fighters.find((f) => f.id === actorId && classHasPassive(f.class, "foretell"))) return result;
  // Monsters after sage's current position (fromIndex = turn_index + 1) will act
  // before the sage's next turn — pre-roll a target for each of them.
  return withForeseeForSage(result, actorId, result.state.turn_index + 1, roll);
}

// ── Monster-kill resolution ───────────────────────────────────────────────
//
// Called every time a monster's hp drops to 0.
// For gauntlet quests with remaining waves, transitions to the next wave
// (preserving turn order + initiative + killer's credit). Otherwise, victory
// fires when ALL monsters are dead. monster_down always fires for the "kill" beat.
export function resolveMonsterKill(
  state: CombatState,
  monsterId: ActorId,
  killedBy: ActorId,
  precedingEvents: CombatEvent[],
): StepResult {
  const events: CombatEvent[] = [...precedingEvents];
  events.push({ type: "monster_down", killed_by: killedBy });

  // Track kill credit for the killing blow actor.
  const stateWithKill: CombatState = killedBy !== MONSTER_ID && !isMonsterActor(killedBy)
    ? {
        ...state,
        stats: {
          ...state.stats,
          [killedBy]: {
            ...(state.stats[killedBy] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
            kills: (state.stats[killedBy]?.kills ?? 0) + 1,
          },
        },
      }
    : state;

  const deadMonster = stateWithKill.monsters.find((m) => m.id === monsterId);
  const upcoming = deadMonster?.upcoming_waves ?? [];

  if (upcoming.length > 0) {
    // Gauntlet wave transition — replace the dead monster in-place.
    const [next, ...rest] = upcoming;
    const newMonster: CombatMonster = {
      id: monsterId,           // keep the same slot ID so turn_order stays valid
      name: next.name,
      hp: next.max_hp,
      max_hp: next.max_hp,
      shield: deadMonster!.tier,
      tier: deadMonster!.tier,
      initiative: deadMonster!.initiative,
      effects: [],
      is_boss: false,          // gauntlet waves are never boss-tier
      boss_phase: 1,
      wave: (deadMonster!.wave ?? 1) + 1,
      total_waves: deadMonster!.total_waves,
      upcoming_waves: rest,
      art_url: deadMonster!.art_url,
    };
    events.push({
      type: "wave_transition",
      from_monster: deadMonster!.name,
      to_monster: next.name,
      to_max_hp: next.max_hp,
      new_wave: newMonster.wave!,
      total_waves: newMonster.total_waves ?? newMonster.wave!,
    });
    // Wave transition clears mark — the previous focus target is gone.
    const ability_state = stripField(stateWithKill.ability_state, "mark");
    const updatedMonsters = stateWithKill.monsters.map((m) => m.id === monsterId ? newMonster : m);
    const advanced = advanceTurn({ ...stateWithKill, monsters: updatedMonsters, ability_state });
    return { state: advanced, events: [...events, ...turnStartEvent(advanced)] };
  }

  // Check if ALL monsters are now dead.
  const allMonstersDown = stateWithKill.monsters.every((m) => m.id === monsterId || m.hp <= 0);
  if (allMonstersDown) {
    events.push({ type: "victory" });
    return { state: { ...stateWithKill, status: "victory" }, events };
  }

  // Some monsters still alive — combat continues. Clear mark (target is dead).
  const ability_state = stripField(stateWithKill.ability_state, "mark");
  const advanced = advanceTurn({ ...stateWithKill, ability_state });
  return { state: advanced, events: [...events, ...turnStartEvent(advanced)] };
}

// ── Status effect tick handling ───────────────────────────────────────────
//
// Ticks once at the start of every actor's turn. regen heals; bleeding /
// burning / poisoned damage. Effects decrement `remaining` each tick and
// drop off when remaining hits 0. If a tick lowers the actor below 1 hp,
// the wrapping handler treats it as the actor being downed before they
// can act.

interface TickResult {
  newHp: number;
  newEffects: MachineStatusEffect[];
  events: CombatEvent[];
}

function tickEffects(
  hp: number,
  maxHp: number,
  effects: MachineStatusEffect[],
  actorId: ActorId,
): TickResult {
  let newHp = hp;
  const newEffects: MachineStatusEffect[] = [];
  const events: CombatEvent[] = [];
  for (const eff of effects) {
    if (eff.type === "empowered" || eff.type === "frozen" || eff.type === "shocked" || eff.type === "stunned" || eff.type === "hexed" || eff.type === "entangled" || eff.type === "barkskin" || eff.type === "animal_form") {
      // Passive — no HP delta. Silently count down; the effect is applied
      // inline in the attack/turn handlers via the actor's effects array.
      // "stunned" uses remaining as a max-duration safety net (break logic
      // lives in handleMonsterAct via the probabilistic roll).
      if (eff.remaining > 1) newEffects.push({ ...eff, remaining: eff.remaining - 1 });
      events.push({ type: "effect_tick", actor: actorId, effect: eff.type, magnitude: 0, hp_delta: 0 });
      continue;
    }
    const delta = eff.type === "regen" ? eff.magnitude : -eff.magnitude;
    newHp = Math.max(0, Math.min(maxHp, newHp + delta));
    events.push({
      type: "effect_tick",
      actor: actorId,
      effect: eff.type,
      magnitude: eff.magnitude,
      hp_delta: delta,
      source: eff.source,
    });
    if (eff.remaining > 1) {
      newEffects.push({ ...eff, remaining: eff.remaining - 1 });
    }
  }
  return { newHp, newEffects, events };
}

// Apply pre-turn ticks to whichever actor is about to act. Returns the
// updated state, the events to emit, and — if the tick killed the actor —
// an `earlyReturn` StepResult so the caller can skip the action handler
// entirely. Centralizes the down/victory/defeat bookkeeping so each action
// handler just has to prepend `tick.events` and bail on `earlyReturn`.
interface TickGate {
  state: CombatState;
  events: CombatEvent[];
  earlyReturn: StepResult | null;
}

function tickAtTurnStart(state: CombatState, actorId: ActorId): TickGate {
  if (isMonsterActor(actorId)) {
    const monster = state.monsters.find((m) => m.id === actorId);
    if (!monster) return { state, events: [], earlyReturn: null };
    const tick = tickEffects(monster.hp, monster.max_hp, monster.effects, actorId);
    let newState: CombatState = {
      ...state,
      monsters: state.monsters.map((m) =>
        m.id === actorId ? { ...m, hp: tick.newHp, effects: tick.newEffects } : m,
      ),
    };
    // Staff Sage — Ill Omen: accumulate DoT damage dealt to an omen-marked monster.
    const monsterDotDamage = Math.max(0, monster.hp - tick.newHp);
    if (monsterDotDamage > 0) newState = accumulateIllOmenDamage(newState, actorId, monsterDotDamage);
    // Frozen: the monster's turn is skipped when the frozen effect expires this tick.
    const wasMonsterFrozen = monster.effects.some((e) => e.type === "frozen");
    const stillMonsterFrozen = tick.newEffects.some((e) => e.type === "frozen");
    if (wasMonsterFrozen && !stillMonsterFrozen && tick.newHp > 0) {
      const skipEvent: CombatEvent = { type: "turn_skip", actor: actorId, reason: "frozen" };
      const advanced = advanceTurn(newState);
      return {
        state: newState,
        events: [...tick.events, skipEvent],
        earlyReturn: { state: advanced, events: [...tick.events, skipEvent, ...turnStartEvent(advanced)] },
      };
    }
    if (tick.newHp <= 0 && monster.hp > 0) {
      // Credit the kill to whoever applied the longest-running tick source,
      // falling back to the first alive fighter. Pure best-effort — used
      // for the UI's "killed by" banner and contribution count.
      const killerId =
        monster.effects.find((e) => e.source)?.source ??
        state.fighters.find((f) => f.hp > 0)?.id ??
        actorId;
      // Credit the killing tick's damage to the source so the contribution
      // split on victory matches what actually happened.
      const tickDmg = monster.hp - tick.newHp;
      const contribution =
        !isMonsterActor(killerId)
          ? {
              ...state.contribution,
              [killerId]: (state.contribution[killerId] ?? 0) + tickDmg,
            }
          : state.contribution;
      // Defer victory vs wave transition to the shared resolver so
      // gauntlet quests keep going past a poison-kill.
      const withContribution: CombatState = { ...newState, contribution };
      const result = resolveMonsterKill(withContribution, actorId, killerId, tick.events);
      return { state: result.state, events: result.events, earlyReturn: result };
    }
    return { state: newState, events: tick.events, earlyReturn: null };
  }

  const fighter = state.fighters.find((f) => f.id === actorId);
  if (!fighter) {
    // Shouldn't happen — turn_order is built from current fighters — but
    // defensively pass through.
    return { state, events: [], earlyReturn: null };
  }
  const tick = tickEffects(fighter.hp, fighter.max_hp, fighter.effects, actorId);
  const updatedFighters = state.fighters.map((f) =>
    f.id === actorId ? { ...f, hp: tick.newHp, effects: tick.newEffects } : f,
  );
  let newState: CombatState = { ...state, fighters: updatedFighters };
  let passiveEvents: CombatEvent[] = [];
  // Apply pre-action passives only if the tick didn't drop the actor below 1.
  if (tick.newHp > 0) {
    const tickedFighter = newState.fighters.find((f) => f.id === actorId)!;
    const pre = applyPreActionPassives(newState, actorId);
    newState = pre.state;
    passiveEvents = pre.events;
    void tickedFighter;

    // Staff Sage — Good Fortune: fire delayed double-heal at start of caster's next turn.
    const gf = applyGoodFortuneDelayed(newState, actorId);
    newState = gf.state;
    passiveEvents = [...passiveEvents, ...gf.events];
  }

  // Frozen: the fighter's turn is skipped when the frozen effect expires this tick.
  const wasFighterFrozen = fighter.effects.some((e) => e.type === "frozen");
  const stillFighterFrozen = tick.newEffects.some((e) => e.type === "frozen");
  if (wasFighterFrozen && !stillFighterFrozen && tick.newHp > 0) {
    const skipEvent: CombatEvent = { type: "turn_skip", actor: actorId, reason: "frozen" };
    const advanced = advanceTurn(newState);
    return {
      state: newState,
      events: [...tick.events, skipEvent],
      earlyReturn: { state: advanced, events: [...tick.events, skipEvent, ...turnStartEvent(advanced)] },
    };
  }

  if (tick.newHp <= 0 && fighter.hp > 0) {
    // Tick downed the fighter — skip their action, advance turn (or end
    // combat on full party wipe).
    const events: CombatEvent[] = [
      ...tick.events,
      { type: "fighter_down", target: actorId },
    ];
    const allDown = updatedFighters.every((f) => f.hp <= 0);
    if (allDown) {
      events.push({ type: "defeat" });
      return {
        state: newState,
        events,
        earlyReturn: { state: { ...newState, status: "defeat" }, events },
      };
    }
    const advanced = advanceTurn(newState);
    return {
      state: newState,
      events,
      earlyReturn: { state: advanced, events: [...events, ...turnStartEvent(advanced)] },
    };
  }

  return { state: newState, events: [...tick.events, ...passiveEvents], earlyReturn: null };
}

// ── Class passives ───────────────────────────────────────────────────────
//
// Always-on or once-per-fight triggers wired into the action handlers. Each
// helper is pure: it returns a {state, events} delta that callers fold in
// before persisting. Once-per-fight passives consult passives_used.

function classIdOf(fighter: CombatFighter): string {
  return classByName(fighter.class).id;
}

// Returns true if the named class has a passive ability with the given id.
// Used to gate passive mechanics without hardcoding class ID strings.
function classHasPassive(className: string, passiveId: string): boolean {
  return classByName(className).abilities.some(
    (a) => a.kind === "passive" && a.id === passiveId,
  );
}

function isPassiveUsed(state: CombatState, actorId: ActorId, key: string): boolean {
  return state.passives_used?.[actorId]?.includes(key) ?? false;
}

function markPassiveUsed(state: CombatState, actorId: ActorId, key: string): CombatState {
  const current = state.passives_used ?? {};
  const userKeys = current[actorId] ?? [];
  if (userKeys.includes(key)) return state;
  return {
    ...state,
    passives_used: {
      ...current,
      [actorId]: [...userKeys, key],
    },
  };
}

// SRE Warden — Armor Up. Regenerate 2 + floor(level/4) shield at the start of each turn.
function applyWardenArmorUp(
  state: CombatState,
  actor: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "armor_up")) return { state, events: [] };
  const amount = 2 + Math.floor(actor.level / 4);
  const cap = actor.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(actor, state.ability_state, state.round);
  const newShield = Math.min(cap, actor.shield + amount);
  const added = newShield - actor.shield;
  if (added <= 0) return { state, events: [] };
  const updated = state.fighters.map((f) =>
    f.id === actor.id ? { ...f, shield: newShield } : f,
  );
  return {
    state: { ...state, fighters: updated },
    events: [{ type: "passive_warden_armor_up", actor: actor.id, amount: added }],
  };
}

// QA Paladin — Lay on Hands auto-trigger. Fires after a monster swing when the
// target survived but has fallen to ≤ 30% of max_hp. The first alive Paladin in
// the party who hasn't already triggered this once-per-fight heals the fighter
// for 1d6 + floor(mag/2) + floor(vit/2).
function applyPaladinAutoHeal(
  state: CombatState,
  targetId: ActorId,
  roll: RollFn,
): { state: CombatState; events: CombatEvent[] } {
  const target = state.fighters.find((f) => f.id === targetId);
  if (!target || target.hp <= 0) return { state, events: [] };
  if (target.hp > Math.floor(target.max_hp * 0.3)) return { state, events: [] };

  const paladin = state.fighters.find(
    (f) => f.hp > 0 && classHasPassive(f.class, "holy_rage") && !isPassiveUsed(state, f.id, PASSIVE_PALADIN_AUTO_HEAL),
  );
  if (!paladin) return { state, events: [] };

  const vit = paladin.stats?.vit ?? 5;
  const rolled = roll(6) + Math.floor(paladin.magic_mod / 2) + Math.floor(vit / 2);
  const newHp = Math.min(target.max_hp, target.hp + rolled);
  const actualAmount = newHp - target.hp;
  if (actualAmount <= 0) return { state, events: [] };

  let next: CombatState = {
    ...state,
    fighters: state.fighters.map((f) =>
      f.id === targetId ? { ...f, hp: newHp } : f,
    ),
  };
  next = markPassiveUsed(next, paladin.id, PASSIVE_PALADIN_AUTO_HEAL);

  return {
    state: next,
    events: [{ type: "passive_paladin_auto_heal", paladin: paladin.id, target: targetId, amount: actualAmount }],
  };
}

// SRE Warden — Resilient. Returns the flat bonus from active stacks:
// stacks * (2 + floor(vit/4)). Used for shield cap and Thorns/Brace scaling.
function resilientBonus(
  fighter: CombatFighter,
  abilityState: AbilityRuntimeState | undefined,
  currentRound: number,
): number {
  const stacks = (abilityState?.resilient?.[fighter.id] ?? []).filter(
    (exp) => exp >= currentRound,
  );
  if (stacks.length === 0) return 0;
  const vit = fighter.stats?.vit ?? 0;
  return stacks.length * (2 + Math.floor(vit / 4));
}

// SRE Warden — Resilient. Called after any successful hit by the warden to
// add a stack (expires_after_round = round + 4). No shield is directly granted;
// the raised cap takes effect when shield is next applied.
function applyWardenResilient(
  state: CombatState,
  fighter: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(fighter.class, "resilient")) return { state, events: [] };
  const existing = state.ability_state?.resilient?.[fighter.id] ?? [];
  const newStacks = [...existing, state.round + 4];
  return {
    state: {
      ...state,
      ability_state: {
        ...(state.ability_state ?? {}),
        resilient: {
          ...(state.ability_state?.resilient ?? {}),
          [fighter.id]: newStacks,
        },
      },
    },
    events: [{ type: "passive_warden_resilient", actor: fighter.id, stacks: newStacks.length }],
  };
}

// SRE Warden — Thorns. When hit, deal 25% of armor_power back to the attacker.
function applyWardenThorns(
  state: CombatState,
  targetFighterId: ActorId,
  monsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const fighter = state.fighters.find((f) => f.id === targetFighterId);
  if (!fighter || !classHasPassive(fighter.class, "thorns")) return { state, events: [] };
  const effectiveArmor = fighter.armor_power + resilientBonus(fighter, state.ability_state, state.round);
  const amount = Math.max(1, Math.floor(effectiveArmor * 0.25));
  const monster = state.monsters.find((m) => m.id === monsterId && m.hp > 0);
  if (!monster) return { state, events: [] };
  const newHp = Math.max(0, monster.hp - amount);
  return {
    state: { ...state, monsters: state.monsters.map((m) => m.id === monsterId ? { ...m, hp: newHp } : m) },
    events: [{ type: "passive_warden_thorns", actor: targetFighterId, target: monsterId, amount }],
  };
}

// DevOps Mage — Mana Font. Restores 1 mana every 3 actions (always-on). Uses
// CombatState.action_counters to track per-fighter action count across the fight.
const MANA_FONT_INTERVAL = 3;
const MANA_FONT_AMOUNT = 1;

function applyManaFont(
  state: CombatState,
  actor: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "mana_font")) return { state, events: [] };
  if (actor.mana >= actor.max_mana) return { state, events: [] };
  const counters = state.action_counters ?? {};
  const prev = counters[actor.id] ?? 0;
  const next = prev + 1;
  const updatedCounters = { ...counters, [actor.id]: next };
  const fires = next % MANA_FONT_INTERVAL === 0;
  if (!fires) {
    return { state: { ...state, action_counters: updatedCounters }, events: [] };
  }
  const newMana = Math.min(actor.max_mana, actor.mana + MANA_FONT_AMOUNT);
  const added = newMana - actor.mana;
  const updated = state.fighters.map((f) =>
    f.id === actor.id ? { ...f, mana: newMana } : f,
  );
  return {
    state: { ...state, fighters: updated, action_counters: updatedCounters },
    events: [{ type: "passive_mage_mana_font", actor: actor.id, amount: added }],
  };
}

// Backend Druid — Database-Tree Communion. +1 HP at the start of every Druid
// action (always-on). Clamped to max_hp; emits nothing if already at full HP.
function applyDruidRegen(
  state: CombatState,
  actor: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "db_tree_communion")) return { state, events: [] };
  if (actor.hp <= 0) return { state, events: [] };
  const regenAmount = DRUID_PASSIVE_REGEN + Math.floor(actor.level / 6);
  const newHp = Math.min(actor.max_hp, actor.hp + regenAmount);
  const added = newHp - actor.hp;
  if (added <= 0) return { state, events: [] };
  const updated = state.fighters.map((f) =>
    f.id === actor.id ? { ...f, hp: newHp } : f,
  );
  return {
    state: { ...state, fighters: updated },
    events: [{ type: "passive_druid_regen", actor: actor.id, amount: added }],
  };
}

// Pre-action passive hook for player handlers. Applies Warden harden-up and
// Druid regen. Returns the new fighter snapshot too so the calling handler
// can use up-to-date HP/shield values.
function applyPreActionPassives(
  state: CombatState,
  actorId: ActorId,
): { state: CombatState; fighter: CombatFighter; events: CombatEvent[] } {
  const fighter = state.fighters.find((f) => f.id === actorId);
  if (!fighter) return { state, fighter: fighter as unknown as CombatFighter, events: [] };
  // Tick down Brace turns for this actor before other passives fire.
  const braceEntry = state.ability_state?.brace?.[actorId];
  let s = state;
  if (braceEntry) {
    const remaining = braceEntry.turns_remaining - 1;
    if (remaining <= 0) {
      s = { ...s, ability_state: stripField(s.ability_state, "brace") ?? {} };
    } else {
      s = {
        ...s,
        ability_state: {
          ...(s.ability_state ?? {}),
          brace: { ...s.ability_state!.brace, [actorId]: { ...braceEntry, turns_remaining: remaining } },
        },
      };
    }
  }
  // Tick down Taunt Fortify turns for this actor.
  const fortifyEntry = s.ability_state?.taunt_fortify?.[actorId];
  if (fortifyEntry) {
    const remaining = fortifyEntry.turns_remaining - 1;
    if (remaining <= 0) {
      const { [actorId]: _dropped, ...restFortify } = s.ability_state?.taunt_fortify ?? {};
      s = {
        ...s,
        ability_state: Object.keys(restFortify).length > 0
          ? { ...(s.ability_state ?? {}), taunt_fortify: restFortify }
          : (stripField(s.ability_state, "taunt_fortify") ?? {}),
      };
    } else {
      s = {
        ...s,
        ability_state: {
          ...(s.ability_state ?? {}),
          taunt_fortify: { ...s.ability_state!.taunt_fortify, [actorId]: { turns_remaining: remaining } },
        },
      };
    }
  }
  // Clean up expired Resilient stacks for this actor.
  const resilientStacks = s.ability_state?.resilient?.[actorId];
  if (resilientStacks) {
    const activeStacks = resilientStacks.filter((exp) => exp >= s.round);
    if (activeStacks.length < resilientStacks.length) {
      if (activeStacks.length === 0) {
        const { [actorId]: _dropped, ...restResilient } = s.ability_state?.resilient ?? {};
        s = {
          ...s,
          ability_state: Object.keys(restResilient).length > 0
            ? { ...(s.ability_state ?? {}), resilient: restResilient }
            : (stripField(s.ability_state, "resilient") ?? {}),
        };
        // Clamp shield to new (lower) cap if it now exceeds it.
        const currentFighterForClamp = s.fighters.find((f) => f.id === actorId);
        if (currentFighterForClamp) {
          const newCap = currentFighterForClamp.max_hp * SHIELD_CAP_MULTIPLIER;
          if (currentFighterForClamp.shield > newCap) {
            s = { ...s, fighters: s.fighters.map((f) => f.id === actorId ? { ...f, shield: newCap } : f) };
          }
        }
      } else {
        s = {
          ...s,
          ability_state: {
            ...(s.ability_state ?? {}),
            resilient: { ...s.ability_state!.resilient, [actorId]: activeStacks },
          },
        };
        // Clamp shield to the new (reduced) cap.
        const currentFighterForClamp = s.fighters.find((f) => f.id === actorId);
        if (currentFighterForClamp) {
          const newCap = currentFighterForClamp.max_hp * SHIELD_CAP_MULTIPLIER + resilientBonus(currentFighterForClamp, s.ability_state, s.round);
          if (currentFighterForClamp.shield > newCap) {
            s = { ...s, fighters: s.fighters.map((f) => f.id === actorId ? { ...f, shield: newCap } : f) };
          }
        }
      }
    }
  }
  // Tick down Animal Form and revert stat bonuses on expiry.
  const animalFormEntry = s.ability_state?.animal_form?.[actorId];
  if (animalFormEntry) {
    const remaining = animalFormEntry.turns_remaining - 1;
    if (remaining <= 0) {
      const af = s.fighters.find((f) => f.id === actorId)!;
      const newMaxHp = af.max_hp - animalFormEntry.hp_delta;
      const revertedFighter: typeof af = {
        ...af,
        attack_mod: af.attack_mod - animalFormEntry.atk_delta,
        max_hp: newMaxHp,
        hp: Math.min(af.hp, newMaxHp),
        ...(af.stats ? {
          stats: {
            ...af.stats,
            str: af.stats.str - animalFormEntry.str_bonus,
            vit: af.stats.vit - animalFormEntry.vit_bonus,
            agi: af.stats.agi - animalFormEntry.agi_bonus,
            dex: af.stats.dex - animalFormEntry.dex_bonus,
          },
        } : {}),
      };
      s = { ...s, fighters: s.fighters.map((f) => f.id === actorId ? revertedFighter : f) };
      const afMap = { ...(s.ability_state?.animal_form ?? {}) };
      delete afMap[actorId];
      s = { ...s, ability_state: Object.keys(afMap).length > 0 ? { ...s.ability_state, animal_form: afMap } : (stripField(s.ability_state, "animal_form") ?? {}) };
    } else {
      s = { ...s, ability_state: { ...s.ability_state, animal_form: { ...s.ability_state!.animal_form, [actorId]: { ...animalFormEntry, turns_remaining: remaining } } } };
    }
  }

  const currentFighter = s.fighters.find((f) => f.id === actorId) ?? fighter;
  const armorUp = applyWardenArmorUp(s, currentFighter);
  const armorUpFighter = armorUp.state.fighters.find((f) => f.id === actorId) ?? currentFighter;
  const druid = applyDruidRegen(armorUp.state, armorUpFighter);
  const druidFighter = druid.state.fighters.find((f) => f.id === actorId) ?? armorUpFighter;
  const mana = applyManaFont(druid.state, druidFighter);
  const finalFighter = mana.state.fighters.find((f) => f.id === actorId) ?? druidFighter;
  return {
    state: mana.state,
    fighter: finalFighter,
    events: [...armorUp.events, ...druid.events, ...mana.events],
  };
}

// Frontend Bard — Bardic Aura. While any Bard is alive, every non-Bard
// partymate attack deals +(1 + floor(bard.level/5)) damage. Battle Hymn
// temporarily adds BARD_AURA_HYMN_BONUS on top for Battle Hymn's duration.
function computeBardAuraBonus(
  state: CombatState,
): { bonus: number } {
  const bard = state.fighters.find(
    (f) => f.hp > 0 && classHasPassive(f.class, "bardic_aura"),
  );
  if (!bard) return { bonus: 0 };
  const base = 1 + Math.floor(bard.level / 5);
  const hymnActive =
    state.ability_state?.battle_hymn != null &&
    state.round <= state.ability_state.battle_hymn.expires_after_round;
  return { bonus: hymnActive ? base + BARD_AURA_HYMN_BONUS + bard.magic_mod : base };
}

// Data Warlock — Sinister Queries passive: fires on any hit (attack, cast, or ability damage).
// Applies 1 + floor(level/5) bleed stacks to the target monster.
function applySinisterQueries(
  state: CombatState,
  actor: CombatFighter,
  targetMonsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "sinister_queries")) return { state, events: [] };
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };
  const magnitude = 1 + Math.floor(actor.level / 5);
  const newEffect: MachineStatusEffect = { type: "bleeding", magnitude, remaining: 3, source: actor.id };
  return {
    state: {
      ...state,
      monsters: state.monsters.map((m) =>
        m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, newEffect) } : m,
      ),
    },
    events: [{ type: "passive_sinister_queries", actor: actor.id, target: targetMonsterId, magnitude }],
  };
}

// Hex bleed proc: whenever a hexed monster takes damage, apply 3 bleed stacks.
function applyHexBleedProc(
  state: CombatState,
  targetMonsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster || !targetMonster.effects.some((e) => e.type === "hexed")) return { state, events: [] };
  const stacks = 3;
  const newEffect: MachineStatusEffect = { type: "bleeding", magnitude: stacks, remaining: 3, source: "hex" };
  return {
    state: {
      ...state,
      monsters: state.monsters.map((m) =>
        m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, newEffect) } : m,
      ),
    },
    events: [{ type: "hex_bleed_proc", target: targetMonsterId, stacks }],
  };
}

// Elemental weapon proc. On a hit, the attacker's equipped weapon element
// (if any) has a rarity-gated chance to apply a status to the target monster.
// Resistance: 50% chance to block the proc entirely. Weakness: boosted magnitude/duration.
function applyElementalProc(
  state: CombatState,
  fighter: CombatFighter,
  targetMonsterId: ActorId,
  roll: RollFn,
): { state: CombatState; events: CombatEvent[] } {
  if (!fighter.element || !fighter.weapon_rarity) return { state, events: [] };
  const procRate = ELEMENT_PROC_RATE[fighter.weapon_rarity];
  if (roll(100) > Math.round(procRate * 100)) return { state, events: [] };

  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };

  const effect = ELEMENT_META[fighter.element].effect;
  const hasWeakness = targetMonster.element_weakness === fighter.element;
  const hasResistance = targetMonster.element_resistance === fighter.element;

  // Resistance: 50% chance to block entirely.
  if (hasResistance && roll(2) === 1) {
    return {
      state,
      events: [{
        type: "elemental_proc", actor: fighter.id, target: targetMonsterId,
        element: fighter.element, effect, magnitude: 0, duration: 0, resisted: true,
      }],
    };
  }

  let magnitude: number;
  let duration: number;
  if (fighter.element === "fire") {
    magnitude = 1 + Math.floor(fighter.weapon_power / 5);
    if (hasWeakness) magnitude = Math.round(magnitude * 1.5);
    duration = 3;
  } else if (fighter.element === "ice") {
    magnitude = 1;
    duration = hasWeakness ? 2 : 1;
  } else {
    // lightning → shocked: magnitude encodes amplification (1 = 30%, 2 = 45%)
    magnitude = hasWeakness ? 2 : 1;
    duration = 2;
  }

  const newEffect: MachineStatusEffect = { type: effect, magnitude, remaining: duration, source: fighter.id };
  const updatedMonsters = state.monsters.map((m) =>
    m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, newEffect) } : m,
  );
  return {
    state: { ...state, monsters: updatedMonsters },
    events: [{
      type: "elemental_proc", actor: fighter.id, target: targetMonsterId,
      element: fighter.element, effect, magnitude, duration, resisted: false,
    }],
  };
}

// Monster → fighter elemental status proc. Mirrors `applyElementalProc`
// for the inverse direction. Fires only on non-physical, non-magic hits
// (fire/ice/lightning); magic damage is "pure" by design — bypasses
// armor but doesn't proc.
//
// Resistance lowers proc chance proportionally — a fighter with 100% resist
// is immune; 50% resist halves the chance. Tier scales the burn magnitude
// modestly so high-tier monsters chip harder, but ice/lightning stay flat
// (their effect is the lock-out / damage amp, not the magnitude).
const MONSTER_ELEMENT_PROC_RATE = 0.25;

function applyMonsterElementalProc(
  state: CombatState,
  monster: CombatMonster,
  targetFighterId: ActorId,
  damageType: DamageType,
  targetResistPct: number,
  roll: RollFn,
): { state: CombatState; events: CombatEvent[] } {
  if (damageType !== "fire" && damageType !== "ice" && damageType !== "lightning") {
    return { state, events: [] };
  }
  const fighter = state.fighters.find((f) => f.id === targetFighterId && f.hp > 0);
  if (!fighter) return { state, events: [] };

  const adjustedRate = MONSTER_ELEMENT_PROC_RATE * Math.max(0, 1 - targetResistPct / 100);
  if (adjustedRate <= 0) return { state, events: [] };
  if (roll(100) > Math.round(adjustedRate * 100)) return { state, events: [] };

  let effect: "burning" | "frozen" | "shocked";
  let magnitude: number;
  let duration: number;
  if (damageType === "fire") {
    effect = "burning";
    magnitude = 1 + Math.floor(monster.tier / 4);
    duration = 3;
  } else if (damageType === "ice") {
    effect = "frozen";
    magnitude = 1;
    duration = 1;
  } else {
    // lightning → shocked: magnitude encodes amplification (1 = 30%, 2 = 45%);
    // monsters only inflict tier-1 unless they're elite (tier >= 6).
    effect = "shocked";
    magnitude = monster.tier >= 6 ? 2 : 1;
    duration = 2;
  }

  const newEffect: MachineStatusEffect = {
    type: effect, magnitude, remaining: duration, source: monster.id,
  };
  const updatedFighters = state.fighters.map((f) =>
    f.id === targetFighterId ? { ...f, effects: mergeEffect(f.effects, newEffect) } : f,
  );
  return {
    state: { ...state, fighters: updatedFighters },
    events: [{
      type: "monster_elemental_proc",
      actor: monster.id,
      target: targetFighterId,
      element: damageType,
      effect,
      magnitude,
      duration,
    }],
  };
}

// Status-effect stacking policy. Without this, applying the same effect
// twice produced two parallel timers that each ticked independently —
// correct under "independent dots" semantics but visually noisy in the UI
// (one pill per stack) and not what most players intuit. We pick one of
// two merge modes per type:
//   - "stack":   damage-over-time effects merge into one entry. Magnitude
//                sums up to `maxMagnitude`. Remaining ticks = max(existing,
//                incoming) so you can't shorten an effect by overstacking.
//   - "refresh": buffs/regen take the BETTER magnitude (max) and the
//                LONGER duration. A new stronger application overrides; a
//                weaker one just refreshes the timer.
const EFFECT_STACK_POLICY: Record<EffectType, { mode: "stack" | "refresh"; maxMagnitude: number }> = {
  regen:     { mode: "refresh", maxMagnitude: 12 },
  bleeding:  { mode: "stack",   maxMagnitude: 6 },
  burning:   { mode: "stack",   maxMagnitude: 6 },
  poisoned:  { mode: "stack",   maxMagnitude: 6 },
  empowered: { mode: "refresh", maxMagnitude: 50 },
  frozen:    { mode: "refresh", maxMagnitude: 2 },
  shocked:   { mode: "refresh", maxMagnitude: 2 },
  stunned:   { mode: "refresh", maxMagnitude: 1 },
  hexed:     { mode: "refresh", maxMagnitude: 1 },
  entangled: { mode: "refresh", maxMagnitude: 1 },
  barkskin:    { mode: "refresh", maxMagnitude: 1 },
  animal_form: { mode: "refresh", maxMagnitude: 1 },
};

// Merge `incoming` into the existing effect list. If an effect of the
// same type is already present, applies the per-type policy; otherwise
// appends. Returns a fresh array (never mutates input). All effect-apply
// sites (warlock bleed, consumables, future class actives) should go
// through this so the engine + UI behave consistently.
export function mergeEffect(
  effects: MachineStatusEffect[],
  incoming: MachineStatusEffect,
): MachineStatusEffect[] {
  const policy = EFFECT_STACK_POLICY[incoming.type];
  const existingIdx = effects.findIndex((e) => e.type === incoming.type);
  if (existingIdx < 0) {
    // First instance of this type — clamp magnitude to cap and push.
    return [...effects, { ...incoming, magnitude: Math.min(incoming.magnitude, policy.maxMagnitude) }];
  }
  const existing = effects[existingIdx];
  const mergedMagnitude = policy.mode === "stack"
    ? Math.min(existing.magnitude + incoming.magnitude, policy.maxMagnitude)
    : Math.min(Math.max(existing.magnitude, incoming.magnitude), policy.maxMagnitude);
  const mergedRemaining = Math.max(existing.remaining, incoming.remaining);
  // Source attribution: keep whichever provided the bigger contribution.
  // For "stack" mode we credit the latest applier; for "refresh" the one
  // whose magnitude won. Mostly cosmetic — used in tick-event flavor.
  const source = policy.mode === "stack"
    ? (incoming.source ?? existing.source)
    : (incoming.magnitude >= existing.magnitude ? (incoming.source ?? existing.source) : (existing.source ?? incoming.source));
  const next = [...effects];
  next[existingIdx] = {
    ...existing,
    magnitude: mergedMagnitude,
    remaining: mergedRemaining,
    source,
  };
  return next;
}

// QA Paladin — Holy Rage helpers.

// Accumulate raw hpDamage into holy_rage for every alive paladin in party.
// Fires when any party member (including the paladin themselves) takes damage.
// The 10% bonus is applied at consume time (floor(total * 0.1)), so small hits
// stack without being discarded by per-hit rounding.
function accumulateHolyRage(state: CombatState, hpDamage: number): CombatState {
  const paladins = state.fighters.filter((f) => f.hp > 0 && classHasPassive(f.class, "holy_rage"));
  if (paladins.length === 0) return state;
  const prev = state.ability_state?.holy_rage ?? {};
  const updated: Record<ActorId, number> = { ...prev };
  for (const p of paladins) {
    updated[p.id] = (updated[p.id] ?? 0) + hpDamage;
  }
  return { ...state, ability_state: { ...(state.ability_state ?? {}), holy_rage: updated } };
}

// Clear the holy_rage entry for a specific fighter (consume on attack).
function clearHolyRage(
  abilityState: AbilityRuntimeState | undefined,
  actorId: ActorId,
): AbilityRuntimeState | undefined {
  const prev = abilityState?.holy_rage;
  if (!prev || !prev[actorId]) return abilityState;
  const updated = { ...prev };
  delete updated[actorId];
  return Object.keys(updated).length > 0
    ? { ...(abilityState ?? {}), holy_rage: updated }
    : stripField(abilityState, "holy_rage");
}

// QA Paladin — Smite debuff: decrement (or clear) the debuff for a monster after its swing.
function consumeSmiteDebuff(
  state: AbilityRuntimeState | undefined,
  monsterId: ActorId,
): AbilityRuntimeState | undefined {
  const prev = state?.paladin_smite_debuff;
  if (!prev || !(monsterId in prev)) return state;
  const newCount = (prev[monsterId] ?? 1) - 1;
  const updated = { ...prev };
  if (newCount <= 0) delete updated[monsterId];
  else updated[monsterId] = newCount;
  return Object.keys(updated).length > 0
    ? { ...(state ?? {}), paladin_smite_debuff: updated }
    : stripField(state, "paladin_smite_debuff");
}

// ── Staff Sage helpers ────────────────────────────────────────────────────

// Blizzard: fire AoE damage + freeze proc at the end of the caster's turn.
// Rolls fresh 1d6 + mag damage against each alive monster, decrements charges.
// Returns killed monster IDs for the caller to resolve via resolveMonsterKill.
function applyBlizzardTick(
  state: CombatState,
  casterActor: ActorId,
  roll: RollFn,
): { state: CombatState; events: CombatEvent[]; killed: ActorId[] } {
  const blizzard = state.ability_state?.blizzard;
  if (!blizzard || blizzard.caster_id !== casterActor || blizzard.charges <= 0) {
    return { state, events: [], killed: [] };
  }
  const liveMonsters = state.monsters.filter((m) => m.hp > 0);
  if (liveMonsters.length === 0) return { state, events: [], killed: [] };

  const hits: Array<{ target: ActorId; damage: number }> = [];
  const killed: ActorId[] = [];
  let s = state;

  for (const m of liveMonsters) {
    const dmg = roll(6) + blizzard.mag;
    const newHp = Math.max(0, m.hp - dmg);
    hits.push({ target: m.id, damage: dmg });
    s = {
      ...s,
      monsters: s.monsters.map((mon) => mon.id === m.id ? { ...mon, hp: newHp } : mon),
      contribution: { ...s.contribution, [casterActor]: (s.contribution[casterActor] ?? 0) + dmg },
    };
    if (newHp <= 0) {
      killed.push(m.id);
    } else {
      // 10% freeze chance per surviving target.
      if (roll(100) <= 10) {
        const frozenEff: MachineStatusEffect = { type: "frozen", magnitude: 1, remaining: 1, source: casterActor };
        s = { ...s, monsters: s.monsters.map((mon) => mon.id === m.id ? { ...mon, effects: mergeEffect(mon.effects, frozenEff) } : mon) };
      }
    }
  }

  const newCharges = blizzard.charges - 1;
  const ability_state: AbilityRuntimeState | undefined = newCharges > 0
    ? { ...(s.ability_state ?? {}), blizzard: { ...blizzard, charges: newCharges } }
    : stripField(s.ability_state, "blizzard");
  s = { ...s, ability_state };

  const tickEvent: CombatEvent = { type: "ability_blizzard_tick", actor: casterActor, charges_remaining: newCharges, hits };
  return { state: s, events: [tickEvent], killed };
}

// Good Fortune: fire the stored delayed heal at the start of the caster's next turn.
function applyGoodFortuneDelayed(
  state: CombatState,
  casterActor: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const gf = state.ability_state?.good_fortune;
  if (!gf || gf.caster_id !== casterActor) return { state, events: [] };

  const ability_state = stripField(state.ability_state, "good_fortune");
  let s: CombatState = { ...state, ability_state };

  const target = s.fighters.find((f) => f.id === gf.target_id && f.hp > 0);
  if (!target) return { state: s, events: [] };

  const newHp = Math.min(target.max_hp, target.hp + gf.amount);
  const applied = newHp - target.hp;
  if (applied <= 0) return { state: s, events: [] };

  s = { ...s, fighters: s.fighters.map((f) => f.id === gf.target_id ? { ...f, hp: newHp } : f) };
  return { state: s, events: [{ type: "ability_good_fortune_delayed", actor: casterActor, target: gf.target_id, amount: applied }] };
}

// Ill Omen: accumulate HP damage dealt to an omen-marked monster.
// No-op if there is no active Ill Omen on the monster or damage is 0.
function accumulateIllOmenDamage(state: CombatState, monsterId: ActorId, hpDamage: number): CombatState {
  const entry = state.ability_state?.ill_omen?.[monsterId];
  if (!entry || hpDamage <= 0) return state;
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    ill_omen: {
      ...(state.ability_state?.ill_omen ?? {}),
      [monsterId]: { ...entry, accumulated: entry.accumulated + hpDamage },
    },
  };
  return { ...state, ability_state };
}

// Ill Omen: decrement the turn counter for a monster. On the 3rd monster act,
// burst 50% of accumulated damage and clear the omen. Returns `killed: true`
// if the burst reduces the monster to 0 HP (caller resolves the kill).
function tickIllOmenAtMonsterAct(
  state: CombatState,
  monsterId: ActorId,
): { state: CombatState; events: CombatEvent[]; killed: boolean; caster_id: ActorId | null } {
  const entry = state.ability_state?.ill_omen?.[monsterId];
  if (!entry) return { state, events: [], killed: false, caster_id: null };

  const newTurns = entry.monster_turns_remaining - 1;

  if (newTurns > 0) {
    const ability_state: AbilityRuntimeState = {
      ...(state.ability_state ?? {}),
      ill_omen: { ...(state.ability_state?.ill_omen ?? {}), [monsterId]: { ...entry, monster_turns_remaining: newTurns } },
    };
    return { state: { ...state, ability_state }, events: [], killed: false, caster_id: null };
  }

  // 3rd monster turn — burst fires; clear the entry.
  const burst = Math.floor(entry.accumulated * 0.5);
  const omUpdated = { ...(state.ability_state?.ill_omen ?? {}) };
  delete omUpdated[monsterId];
  const ability_state: AbilityRuntimeState | undefined = Object.keys(omUpdated).length > 0
    ? { ...(state.ability_state ?? {}), ill_omen: omUpdated }
    : stripField(state.ability_state, "ill_omen");
  let s: CombatState = { ...state, ability_state };

  const burstEvent: CombatEvent = { type: "ability_ill_omen_burst", actor: entry.caster_id, target: monsterId, accumulated: entry.accumulated, burst };

  if (burst <= 0) return { state: s, events: [burstEvent], killed: false, caster_id: entry.caster_id };

  const monster = s.monsters.find((m) => m.id === monsterId && m.hp > 0);
  if (!monster) return { state: s, events: [burstEvent], killed: false, caster_id: entry.caster_id };

  const newHp = Math.max(0, monster.hp - burst);
  s = {
    ...s,
    monsters: s.monsters.map((m) => m.id === monsterId ? { ...m, hp: newHp } : m),
    contribution: { ...s.contribution, [entry.caster_id]: (s.contribution[entry.caster_id] ?? 0) + burst },
  };
  return { state: s, events: [burstEvent], killed: newHp <= 0, caster_id: entry.caster_id };
}

// Remove a key from ability_state without mutating. Returns undefined if the
// resulting object is empty (so we don't carry dead state forever).
function stripField<K extends keyof AbilityRuntimeState>(
  state: AbilityRuntimeState | undefined,
  key: K,
): AbilityRuntimeState | undefined {
  if (!state) return undefined;
  const next: AbilityRuntimeState = { ...state };
  delete next[key];
  return Object.keys(next).length > 0 ? next : undefined;
}

function consumeEncourageCharge(
  state: AbilityRuntimeState | undefined,
  actorId: ActorId,
): AbilityRuntimeState | undefined {
  const charges = state?.encourage?.[actorId] ?? 0;
  if (!state || charges <= 0) return state;
  const newCharges = charges - 1;
  if (newCharges <= 0) {
    const enc = { ...state.encourage };
    delete enc[actorId];
    return Object.keys(enc).length > 0 ? { ...state, encourage: enc } : stripField(state, "encourage");
  }
  return { ...state, encourage: { ...state.encourage, [actorId]: newCharges } };
}

function consumeDiscourageCharge(
  state: AbilityRuntimeState | undefined,
  monsterId: ActorId,
): AbilityRuntimeState | undefined {
  const charges = state?.discourage?.[monsterId] ?? 0;
  if (!state || charges <= 0) return state;
  const newCharges = charges - 1;
  if (newCharges <= 0) {
    const disc = { ...state.discourage };
    delete disc[monsterId];
    return Object.keys(disc).length > 0 ? { ...state, discourage: disc } : stripField(state, "discourage");
  }
  return { ...state, discourage: { ...state.discourage, [monsterId]: newCharges } };
}

// Tick down per-swing counters (taunt swings, vanish counts) after a monster
// swing resolves — whether it landed or missed. Drops fields once exhausted.
function tickAbilityCountersAfterSwing(
  state: AbilityRuntimeState | undefined,
): AbilityRuntimeState | undefined {
  if (!state) return undefined;
  let next: AbilityRuntimeState | undefined = { ...state };
  if (next.taunt) {
    const remaining = next.taunt.swings_remaining - 1;
    if (remaining <= 0) next = stripField(next, "taunt");
    else next = { ...next, taunt: { ...next.taunt, swings_remaining: remaining } };
  }
  if (next?.vanished) {
    const updated: Record<ActorId, number> = {};
    for (const [id, count] of Object.entries(next.vanished)) {
      const dec = count - 1;
      if (dec > 0) updated[id] = dec;
    }
    next = Object.keys(updated).length > 0
      ? { ...next, vanished: updated }
      : stripField(next, "vanished");
  }
  return next && Object.keys(next).length > 0 ? next : undefined;
}

// --- Helpers ---

// Pub drink-buff consumption. Called from handlePlayerHit (attack | cast)
// and handleSignature when there's a damage event in flight. Returns the
// adjusted damage, whether a crit was forced (buff_next_crit), the event
// to append, and the new drink_buffs map for nextState. When the buff
// doesn't apply (wrong kind for the action, already-crit + buff_next_crit,
// or no buff present), returns the inputs unchanged with `event: null` so
// the caller can early-out cheaply.
//
// Application rules mirror the legacy slack handler:
//   buff_attack — only on attack actions; adds +magnitude flat damage
//   buff_magic  — only on cast actions; adds +magnitude flat damage
//   buff_next_crit — any of attack/cast/ability; force-crits when the
//     hit wasn't already a crit, doubling the (post-mod) damage. Skipped
//     when the hit was already a crit so we don't waste the single charge
//     on a redundant doubling.
// Consumption: decrement `remaining`; clear from the map when it hits 0.
function applyDrinkBuff(
  state: CombatState,
  actor: ActorId,
  context: "attack" | "ability",
  baseDamage: number,
  isCrit: boolean,
): {
  damage: number;
  forceCrit: boolean;
  event: CombatEvent | null;
  nextDrinkBuffs: Record<ActorId, DrinkBuff> | undefined;
} {
  const buffs = state.drink_buffs;
  if (!buffs) {
    return { damage: baseDamage, forceCrit: false, event: null, nextDrinkBuffs: buffs };
  }
  const buff = buffs[actor];
  if (!buff) {
    return { damage: baseDamage, forceCrit: false, event: null, nextDrinkBuffs: buffs };
  }

  let applies = false;
  let damage = baseDamage;
  let forceCrit = false;
  if (buff.kind === "buff_attack" && context === "attack") {
    damage = baseDamage + buff.magnitude;
    applies = true;
  } else if (buff.kind === "buff_next_crit" && !isCrit) {
    damage = baseDamage * 2;
    forceCrit = true;
    applies = true;
  }

  if (!applies) {
    return { damage: baseDamage, forceCrit: false, event: null, nextDrinkBuffs: buffs };
  }

  // fight_duration buffs apply every action for the whole fight — no countdown.
  // writebackDrinkBuffs clears them after the fight instead of persisting them.
  const nextDrinkBuffs: Record<ActorId, DrinkBuff> = { ...buffs };
  let newRemaining: number;
  if (buff.fight_duration) {
    newRemaining = buff.remaining; // unchanged
    nextDrinkBuffs[actor] = buff;
  } else {
    newRemaining = Math.max(0, buff.remaining - 1);
    if (newRemaining === 0) {
      delete nextDrinkBuffs[actor];
    } else {
      nextDrinkBuffs[actor] = { ...buff, remaining: newRemaining };
    }
  }

  const event: CombatEvent = {
    type: "drink_buff_consumed",
    actor,
    drink_id: buff.drink_id,
    kind: buff.kind,
    bonus: damage - baseDamage,
    force_crit: forceCrit,
    remaining: newRemaining,
  };

  return {
    damage,
    forceCrit,
    event,
    nextDrinkBuffs: Object.keys(nextDrinkBuffs).length > 0 ? nextDrinkBuffs : undefined,
  };
}

function reject(state: CombatState, reason: string): StepResult {
  return { state, events: [{ type: "rejected", reason }] };
}

function removeVanishForFighter(
  state: AbilityRuntimeState | undefined,
  actorId: ActorId,
): AbilityRuntimeState | undefined {
  if (!state?.vanished) return state;
  const updated = { ...state.vanished };
  delete updated[actorId];
  return Object.keys(updated).length > 0
    ? { ...state, vanished: updated }
    : stripField(state, "vanished");
}

function vulnerabilityMult(state: CombatState, monsterId: ActorId, round: number): number {
  const entry = state.ability_state?.vulnerable?.[monsterId];
  if (!entry || round > entry.expires_after_round) return 1.0;
  return 1 + entry.magnitude / 100;
}

function applyRogueLethalStrike(
  state: CombatState,
  actor: CombatFighter,
  targetMonsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "lethal_strikes")) return { state, events: [] };
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };
  const stacks = 2 + Math.floor(actor.level / 2);
  const duration = 2;
  const bleedEffect: MachineStatusEffect = { type: "bleeding", magnitude: stacks, remaining: duration, source: actor.id };
  const updated: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, bleedEffect) } : m,
    ),
  };
  return {
    state: updated,
    events: [{ type: "passive_rogue_lethal_strike", actor: actor.id, magnitude: stacks, duration }],
  };
}

function applyEnvenomProc(
  state: CombatState,
  actor: CombatFighter,
  targetMonsterId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const entry = state.ability_state?.envenomed_weapon?.[actor.id];
  if (!entry || entry.charges <= 0) return { state, events: [] };
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };
  const { stacks, charges } = entry;
  const poisonEffect: MachineStatusEffect = { type: "poisoned", magnitude: stacks, remaining: 2, source: actor.id };
  const updatedWeapon = { ...(state.ability_state?.envenomed_weapon ?? {}) };
  if (charges - 1 <= 0) {
    delete updatedWeapon[actor.id];
  } else {
    updatedWeapon[actor.id] = { stacks, charges: charges - 1 };
  }
  const ability_state: AbilityRuntimeState | undefined = Object.keys(updatedWeapon).length > 0
    ? { ...(state.ability_state ?? {}), envenomed_weapon: updatedWeapon }
    : stripField(state.ability_state ?? {}, "envenomed_weapon");
  const updated: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, poisonEffect) } : m,
    ),
    ability_state,
  };
  return {
    state: updated,
    events: [{ type: "ability_envenom_proc", actor: actor.id, target: targetMonsterId, stacks }],
  };
}

function currentActor(state: CombatState): ActorId | undefined {
  if (state.turn_order.length === 0) return undefined;
  return state.turn_order[state.turn_index % state.turn_order.length];
}

function computeTurnOrder(state: CombatState): ActorId[] {
  const entries: { id: ActorId; init: number }[] = [
    ...state.fighters.map((f) => ({ id: f.id, init: f.initiative })),
    ...state.monsters.map((m) => ({ id: m.id, init: m.initiative })),
  ];
  // Highest initiative first; ties broken by id for determinism.
  entries.sort((a, b) => (b.init - a.init) || a.id.localeCompare(b.id));
  return entries.map((e) => e.id);
}

// Advances turn_index past any downed fighters or dead monsters so the next
// live actor takes the turn. Increments round when wrapping.
function tickActorCooldowns(state: CombatState, actorId: ActorId): CombatState {
  const actorCooldowns = state.cooldowns?.[actorId];
  if (!actorCooldowns || Object.keys(actorCooldowns).length === 0) return state;
  const updated: Record<string, number> = {};
  for (const [abilityId, remaining] of Object.entries(actorCooldowns)) {
    if (remaining > 1) updated[abilityId] = remaining - 1;
    // remaining === 1: cooldown expires this turn — omit from updated
  }
  const allCooldowns = { ...(state.cooldowns ?? {}), [actorId]: updated };
  if (Object.keys(updated).length === 0) {
    const { [actorId]: _removed, ...rest } = allCooldowns;
    return { ...state, cooldowns: Object.keys(rest).length > 0 ? rest : undefined };
  }
  return { ...state, cooldowns: allCooldowns };
}

function advanceTurn(state: CombatState): CombatState {
  if (state.turn_order.length === 0) return state;
  const total = state.turn_order.length;
  for (let i = 1; i <= total; i++) {
    const candidate = state.turn_index + i;
    const id = state.turn_order[candidate % total];
    const roundBump = Math.floor(state.turn_index / total) < Math.floor(candidate / total) ? 1 : 0;
    if (isMonsterActor(id)) {
      const m = state.monsters.find((x) => x.id === id);
      if (m && m.hp > 0) {
        return { ...state, turn_index: candidate, round: state.round + roundBump };
      }
      // Dead monster slot — keep scanning.
      continue;
    }
    const f = state.fighters.find((x) => x.id === id);
    if (f && f.hp > 0) {
      const next = { ...state, turn_index: candidate, round: state.round + roundBump };
      return tickActorCooldowns(next, id);
    }
  }
  // Shouldn't reach here unless the whole party is down — defeat is detected
  // by the caller in handleMonsterAct before we get here.
  return state;
}

function turnStartEvent(state: CombatState): CombatEvent[] {
  const actor = currentActor(state);
  if (!actor) return [];
  return [{ type: "turn_start", actor, round: state.round }];
}
