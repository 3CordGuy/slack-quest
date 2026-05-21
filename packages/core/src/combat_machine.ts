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
import { type AbilityContext, type AbilityEffect, type ActiveAbilityDef } from "./abilities";
import { deriveArmorBonus, deriveCritBonus, deriveDodgeChance, deriveInitiativeBonus, type Stats } from "./stats";

export type ActorId = string;
export const MONSTER_ID: ActorId = "__monster__";
export const isMonsterActor = (id: ActorId): boolean => id === MONSTER_ID || id.startsWith("__monster_");
// Merc IDs are "__merc_<hiring_user_id>__". Auto-resolved by the server; never
// sent by web clients directly.
export const isMercActor = (id: ActorId): boolean => id.startsWith("__merc_");

export interface MachineStatusEffect {
  type: EffectType;
  magnitude: number;
  remaining: number;
  source?: string;
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
  // weapon_power contributes to attack/cast/sig damage for melee/ranged.
  // For focus weapons we set this to 0 at the boundary and instead populate
  // focus_power, which boosts heal/shield. Keeps the engine math branch-free.
  weapon_power: number;
  focus_power: number;
  // Equipped weapon range. Used to gate back-row attack (only ranged/focus
  // can melee from the back row in a party fight).
  weapon_range: WeaponRange;
  armor_power: number;
  initiative: number;      // rolled at begin
  effects: MachineStatusEffect[];
  scars: string[];         // battle scars from defeats
  // Primary stats (Phase 1 / STATS_V2). Present when the flag is on; absent
  // on legacy combats so older persisted states deserialise without a schema bump.
  stats?: Stats;
  // Elemental weapon affinity. undefined = no element or focus weapon.
  element?: ElementType;
  // Rarity of the equipped main-hand weapon. Used to gate proc rates.
  weapon_rarity?: "rare" | "epic" | "legendary";
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
const WARDEN_STARTING_SHIELD = 5;
const DRUID_PASSIVE_REGEN = 2;
const BARD_AURA_DAMAGE = 1;
const BARD_AURA_HYMN_DAMAGE = 3;
const WARLOCK_BLEED_MAGNITUDE = 3;
const WARLOCK_BLEED_DURATION = 3;
const PALADIN_AUTO_HEAL_AMOUNT = 8;
const PALADIN_AUTO_HEAL_THRESHOLD = 0.3;

// Keys for once-per-fight passives.
const PASSIVE_WARDEN_SHIELD = "warden_shield";
const PASSIVE_ROGUE_FIRST_CRIT = "rogue_first_crit";
const PASSIVE_PALADIN_AUTO_HEAL = "paladin_auto_heal";

export interface AbilityRuntimeState {
  // SRE Warden — monster's next N swings forced to target actor_id.
  taunt?: { actor_id: ActorId; swings_remaining: number };
  // Refactor Rogue — these fighters cannot be targeted; map of actor → swings left.
  vanished?: Record<ActorId, number>;
  // Frontend Bard — next N partymate attacks deal +2 damage.
  battle_hymn?: number;
  // Mark / focus-fire — partymates other than the marker get +MARK_BONUS
  // damage on attack/cast until `expires_after_round` is exceeded. Cleared
  // when the monster falls or a wave transition fires.
  mark?: { marked_by: ActorId; expires_after_round: number; monster_id?: string };
  // Staff Sage Foresee — re-appends full intel readout for this many more
  // of the Sage's own combat turns after the initial cast.
  foresee_turns?: number;
}

// +damage to non-marker partymate attacks while a mark is active. Tuned to
// match slack's FOCUS_FIRE_BONUS exactly.
const MARK_BONUS = 2;
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
  | { kind: "cast"; actor: ActorId; target_id?: ActorId }
  | { kind: "heal"; actor: ActorId; target: ActorId }
  | { kind: "flee"; actor: ActorId }
  | { kind: "position"; actor: ActorId; to: BattlePosition }
  | { kind: "shield"; actor: ActorId; target?: ActorId }
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
  | { kind: "monster_act" }
  | { kind: "merc_act" };

export type RollPurpose =
  | "initiative"
  | "hit_check"
  | "damage_attack"
  | "damage_cast"
  | "damage_monster"
  | "heal"
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
  | { type: "ability_battle_hymn"; actor: ActorId; charges_added: number }
  | {
      type: "ability_foresee";
      actor: ActorId;
      // Committed telegraph target (null = no target yet).
      predicted_target: ActorId | null;
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
      active: { containerize: number; taunt_actor: ActorId | null; taunt_swings: number; vanished: ActorId[] };
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
  | { type: "monster_swing_skipped"; reason: "containerize" }
  | { type: "containerize_stun_broken"; turns_active: number }
  | { type: "monster_target_redirected"; from: ActorId; to: ActorId; reason: "taunt" | "vanish" }
  | { type: "battle_hymn_consumed"; actor: ActorId; bonus: number; remaining: number }
  | { type: "mark_applied"; actor: ActorId; expires_after_round: number; bonus: number }
  | { type: "mark_bonus"; actor: ActorId; bonus: number }
  | { type: "shield_applied"; actor: ActorId; target: ActorId; restored: number; new_armor: number; bonus_barrier?: boolean }
  | { type: "passive_warden_shield"; actor: ActorId; amount: number }
  | { type: "passive_mage_mana_font"; actor: ActorId; amount: number }
  | { type: "passive_druid_regen"; actor: ActorId; amount: number }
  | { type: "passive_rogue_first_crit"; actor: ActorId }
  | { type: "passive_bard_aura"; actor: ActorId; source: ActorId; bonus: number }
  | { type: "passive_warlock_bleed"; actor: ActorId; magnitude: number; duration: number }
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
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string }
  | { type: "turn_skip"; actor: ActorId; reason: "frozen" }
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
const MONSTER_BASE_AC = 8;
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
    case "begin":
      return handleBegin(state, roll);
    case "attack":
    case "cast":
      return handlePlayerHit(state, action, roll);
    case "heal":
      return handleHeal(state, action, roll);
    case "shield":
      return handleShield(state, action);
    case "flee":
      return handleFlee(state, action, roll);
    case "position":
      return handlePosition(state, action);
    case "wait":
      return handleWait(state, action);
    case "mark":
      return handleMark(state, action);
    case "ability":
      return handleAbility(state, action, roll);
    case "monster_act":
      // After the monster acts, if the next actor is a Staff Sage with Foresee
      // active, inject the intel refresh right before the turn_start divider so
      // the Sage sees fresh info at the top of their incoming turn.
      return withForeseeForNextActor(handleMonsterAct(state, roll), roll);
    case "merc_act":
      return handleMercAct(state, roll);
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
  action: { kind: "attack" | "cast"; actor: ActorId; target_id?: ActorId },
  roll: RollFn,
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn (current: ${currentActor(state)})`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  // Cast costs 1 mana. Gate before tick so the rejection message is clean.
  if (action.kind === "cast" && fighter.mana < 1) {
    return reject(state, `${action.actor} has no mana to cast`);
  }
  // Back-row melee restriction only applies in a party — solo fights have
  // no positioning concept. Only ranged or focus weapons can attack from
  // the back row; melee weapons demand front-row engagement.
  if (
    action.kind === "attack"
    && fighter.position === "back"
    && state.fighters.length > 1
    && fighter.weapon_range !== "ranged"
    && fighter.weapon_range !== "focus"
  ) {
    return reject(state, "back-row melee blocked — equip a ranged or focus weapon, cast, or move to front");
  }

  // Target selection: use explicit target_id if provided, else pick first alive monster.
  const targetMonster = action.target_id
    ? state.monsters.find((m) => m.id === action.target_id && m.hp > 0)
    : state.monsters.find((m) => m.hp > 0);
  if (!targetMonster) return reject(state, "no valid target");

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  // Deduct cast mana on the post-tick state so subsequent reads see the
  // updated value. Hit/miss both consume — mana pays for the attempt.
  const manaCost = action.kind === "cast" ? 1 : 0;
  const s = manaCost > 0
    ? {
        ...tick.state,
        fighters: tick.state.fighters.map((f) =>
          f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - manaCost) } : f,
        ),
      }
    : tick.state;
  const tickedFighter = s.fighters.find((f) => f.id === action.actor)!;
  // Re-resolve target from updated state (tick may have killed the monster).
  const monster = s.monsters.find((m) => m.id === targetMonster.id && m.hp > 0);
  if (!monster) return reject(s, "target died before action resolved");

  const events: CombatEvent[] = [...tick.events];
  const classMod = action.kind === "cast" ? tickedFighter.magic_mod : tickedFighter.attack_mod;

  // ── d20 to-hit ──
  const d20 = roll(20);
  const ac = monsterAc(monster.tier);
  const hitTotal = d20 + classMod;
  const baseLanded = hitTotal >= ac;
  // Refactor Rogue — First Strike. The first `attack` of the fight is a
  // guaranteed crit. We force the to-hit to land too so an unlucky d20 can't
  // cancel a passive that the slack version (which has no to-hit) considers
  // unconditional.
  const rogueAutoLand =
    !baseLanded
    && action.kind === "attack"
    && classHasPassive(tickedFighter.class, "first_strike")
    && !isPassiveUsed(s, action.actor, PASSIVE_ROGUE_FIRST_CRIT);
  const landed = baseLanded || rogueAutoLand;
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
    modifier: classMod,
    total: hitTotal,
    ac,
    hit: landed,
  });

  if (!landed) {
    const next = advanceTurn(s);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // ── damage roll on hit ──
  const hit = resolvePlayerHit(action.kind, classMod, tickedFighter.weapon_power, roll);
  events.push({
    type: "roll",
    actor: action.actor,
    die: action.kind === "cast" ? "d8" : "d6",
    value: hit.roll,
    purpose: action.kind === "cast" ? "damage_cast" : "damage_attack",
  });

  // Refactor Rogue — First Strike. First `attack` of the fight is a guaranteed
  // crit. Skipped if the roll was already a crit (no double-trigger) or this is
  // a cast (the dagger-strike identity). Doubles the post-mod total.
  let damage = hit.damage;
  let isCrit = hit.isCrit;
  let rogueFirstCritFired = false;
  if (
    action.kind === "attack"
    && classHasPassive(tickedFighter.class, "first_strike")
    && !isCrit
    && !isPassiveUsed(s, action.actor, PASSIVE_ROGUE_FIRST_CRIT)
  ) {
    isCrit = true;
    damage = damage * 2;
    rogueFirstCritFired = true;
  }

  // DEX crit bonus — secondary crit chance for DEX > 5 (STATS_V2 only).
  // Only fires when not already a nat-crit or rogue first-crit.
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

  // Battle Elixir — Empowered: +25% damage for N turns.
  const hasEmpowered = tickedFighter.effects.some((e) => e.type === "empowered");
  if (hasEmpowered) damage = Math.round(damage * 1.25);

  // Bard Aura — non-Bard attackers gain +1 dmg while a Bard is alive; Battle
  // Hymn boosts the aura to +3 for HYMN_USES landed swings.
  const aura = computeBardAuraBonus(s, tickedFighter);
  const hymnCharges = s.ability_state?.battle_hymn ?? 0;
  const hymnRemaining = aura.hymn_consumed ? Math.max(0, hymnCharges - 1) : hymnCharges;
  const abilityStateAfterHymn = aura.hymn_consumed
    ? (hymnRemaining > 0
        ? { ...s.ability_state, battle_hymn: hymnRemaining }
        : stripField(s.ability_state, "battle_hymn"))
    : s.ability_state;

  // Mark / focus-fire — partymates (not the marker) get +MARK_BONUS damage
  // while the mark is active. Expires after MARK_ROUNDS rounds.
  const mark = s.ability_state?.mark;
  const markActive =
    mark
    && mark.marked_by !== action.actor
    && s.round <= mark.expires_after_round
    && (!mark.monster_id || mark.monster_id === action.target_id);
  const markBonus = markActive ? MARK_BONUS : 0;

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

  const finalDamage = Math.max(1, Math.round((damage + aura.bonus + markBonus) * shockMult * weaknessMult * resistMult));

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

  if (rogueFirstCritFired) {
    events.push({ type: "passive_rogue_first_crit", actor: action.actor });
  }
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
  if (markBonus > 0) {
    events.push({ type: "mark_bonus", actor: action.actor, bonus: markBonus });
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
    formula: `${hit.roll}+${hit.totalMod}${isCrit ? " ×2" : ""}${drinkBonusForFormula}${hasEmpowered ? " ⚡" : ""}${aura.bonus > 0 ? ` +${aura.bonus} aura` : ""}${markBonus > 0 ? ` +${markBonus} mark` : ""}`,
  });
  if (aura.hymn_consumed) {
    events.push({
      type: "battle_hymn_consumed",
      actor: action.actor,
      bonus: aura.bonus,
      remaining: hymnRemaining,
    });
  }

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
    contribution: (() => {
      const base = {
        ...s.contribution,
        [action.actor]: (s.contribution[action.actor] ?? 0) + finalDamage,
      };
      // When a Battle Hymn charge is consumed by someone other than the Bard,
      // credit the Bard for the aura bonus they provided.
      if (aura.hymn_consumed) {
        const bard = s.fighters.find(
          (f) => classIdOf(f) === "frontend_bard" && f.id !== action.actor,
        );
        if (bard) base[bard.id] = (base[bard.id] ?? 0) + aura.bonus;
      }
      return base;
    })(),
    ability_state: abilityStateAfterHymn,
    // Only overwrite drink_buffs when this turn actually consumed one —
    // otherwise leave the existing map untouched so the optional field
    // doesn't get coerced to undefined for unrelated turns.
    ...(drinkResult.event ? { drink_buffs: drinkResult.nextDrinkBuffs } : {}),
  };
  if (rogueFirstCritFired) {
    nextState = markPassiveUsed(nextState, action.actor, PASSIVE_ROGUE_FIRST_CRIT);
  }

  // Data Warlock — Cursed Strike. Applies bleed on a crit attack/cast. Always-on.
  if (isCrit && !monsterKilled) {
    const bleed = applyWarlockBleed(nextState, tickedFighter, monster.id, true);
    nextState = bleed.state;
    events.push(...bleed.events);
  }

  // Elemental weapon proc — applies status (burning/frozen/shocked) to target.
  if (!monsterKilled) {
    const proc = applyElementalProc(nextState, tickedFighter, monster.id, roll);
    nextState = proc.state;
    events.push(...proc.events);
  }

  if (phaseTransition) {
    events.push({ type: "boss_phase_transition", new_phase: 2 });
  }

  if (monsterKilled) {
    return resolveMonsterKill(nextState, monster.id, action.actor, events);
  }

  return { state: advanceTurn(nextState), events: [...events, ...turnStartEvent(nextState)] };
}

// Auto-resolved merc turn: simple d20 to-hit then d6 damage swing at the
// lowest-HP live monster. No class abilities, no crits, no mana. Server
// fires this in a loop after each player/monster action whenever the next
// actor is a merc, so the web client never sees a "pending merc turn".
function handleMercAct(state: CombatState, roll: RollFn): StepResult {
  const actorId = currentActor(state);
  if (!actorId || !isMercActor(actorId)) {
    return reject(state, "not a merc's turn");
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

  const hit = resolvePlayerHit("attack", mercAfterTick.attack_mod, mercAfterTick.weapon_power, roll);
  events.push({ type: "roll", actor: actorId, die: "d6", value: hit.roll, purpose: "damage_attack" });

  const { newShield: newMonsterShield, newHp, hpDamage: finalDamage } =
    applyDamageWithShield(hit.damage, monster.shield, monster.hp);

  events.push({
    type: "player_hit",
    actor: actorId,
    target: monster.id,
    damage: finalDamage,
    armor_absorbed: monster.shield - newMonsterShield,
    crit: hit.isCrit,
    formula: `d6+${mercAfterTick.attack_mod}a+${mercAfterTick.weapon_power}w`,
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
  return { state: advanceTurn(nextState), events: [...events, ...turnStartEvent(nextState)] };
}

function handlePosition(
  state: CombatState,
  action: { kind: "position"; actor: ActorId; to: BattlePosition },
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
  const s = tick.state;

  const events: CombatEvent[] = [
    ...tick.events,
    { type: "position_changed", actor: action.actor, from: fighter.position, to: action.to },
  ];
  const next = advanceTurn({
    ...s,
    fighters: s.fighters.map((f) =>
      f.id === action.actor ? { ...f, position: action.to } : f,
    ),
  });
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

function handleWait(
  state: CombatState,
  action: { kind: "wait"; actor: ActorId },
): StepResult {
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const next = advanceTurn(tick.state);
  return { state: next, events: [...tick.events, ...turnStartEvent(next)] };
}

// Mark / focus-fire. Caller designates the monster as the focus target; all
// partymate attacks/casts (except the marker's) get +MARK_BONUS damage until
// MARK_ROUNDS rounds have elapsed. Consumes the actor's turn — different from
// slack's free-action model, but cleaner under strict turn order. Re-marking
// resets the expiry.
function handleMark(
  state: CombatState,
  action: { kind: "mark"; actor: ActorId; target_id?: string | null },
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  if (state.monsters.every((m) => m.hp <= 0)) return reject(state, `no live foe to mark`);

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;

  // Resolve which monster is being marked. Explicit target_id wins; falls
  // back to the first live monster (single-monster fights, Slack path).
  const monster_id = action.target_id
    ?? s.monsters.find((m) => m.hp > 0)?.id;

  const expires_after_round = s.round + MARK_ROUNDS;
  const ability_state: AbilityRuntimeState = {
    ...(s.ability_state ?? {}),
    mark: { marked_by: action.actor, expires_after_round, monster_id },
  };
  const next = advanceTurn({ ...s, ability_state });
  return {
    state: next,
    events: [
      ...tick.events,
      { type: "mark_applied", actor: action.actor, expires_after_round, bonus: MARK_BONUS },
      ...turnStartEvent(next),
    ],
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
  const s = tick.state;
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
    const turnsElapsed = 5 - stunnedEffect.remaining;
    const breakChance = Math.min(1.0, turnsElapsed * 0.30);
    const breaks = (roll(100) / 100) < breakChance;
    const breakEvents: CombatEvent[] = breaks
      ? [{ type: "containerize_stun_broken", turns_active: turnsElapsed }]
      : [];
    const updatedMonsters = breaks
      ? s.monsters.map((m) =>
          m.id === actorId
            ? { ...m, effects: m.effects.filter((e) => e.type !== "stunned") }
            : m,
        )
      : s.monsters;
    const skippedState: CombatState = { ...s, monsters: updatedMonsters };
    const next = advanceTurn(skippedState);
    return {
      state: next,
      events: [
        ...events,
        { type: "monster_swing_skipped", reason: "containerize" },
        ...breakEvents,
        ...turnStartEvent(next),
      ],
    };
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
  const initialTarget = pickMonsterTarget(aliveFighters, () => roll(101) / 100, rmtCounts);
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
    const splashHits = splashTargets.map((f) => {
      const resistPct = splashDamageType !== "physical" ? (f.resistances?.[splashDamageType] ?? 0) : 0;
      const hit = resolveMonsterHit(monster.tier, aliveFighters.length, 0, bossPhase2, roll, splashDamageType, resistPct);
      const splashShocked = f.effects.find((e) => e.type === "shocked");
      const splashShockMult = splashShocked ? (splashShocked.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
      const posAdj = positionDamageMod(f.position, Math.round(hit.final * splashShockMult));
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
  const d20 = roll(20);
  const modifier = Math.floor(monster.tier / 2) + 4;
  const hitTotal = d20 + modifier;
  const targetAc = fighterAc(target.level);
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
    // Even a miss consumes one tick of taunt / vanish — the swing happened.
    const decremented: CombatState = { ...s, ability_state: tickAbilityCountersAfterSwing(s.ability_state), round_monster_targets: rmt };
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
        ability_state: tickAbilityCountersAfterSwing(s.ability_state),
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
  const hit = resolveMonsterHit(
    monster.tier,
    aliveFighters.length,
    0,
    bossPhase2,
    roll,
    attackDamageType,
    targetResistPct,
  );
  const targetShocked = target.effects.find((e) => e.type === "shocked");
  const targetShockMult = targetShocked ? (targetShocked.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
  const positionAdjusted = positionDamageMod(target.position, Math.round(hit.final * targetShockMult));
  // Physical attacks route through the armor pool first (shield = depletable armor).
  // Non-physical bypasses armor entirely and hits HP directly.
  const armorForHit = attackDamageType === "physical" ? target.shield : 0;
  const rawResult = applyDamageWithShield(positionAdjusted, armorForHit, target.hp);
  const newShield = attackDamageType === "physical" ? rawResult.newShield : target.shield;
  const newHp = rawResult.newHp;
  const shieldAbsorbed = rawResult.shieldAbsorbed;
  const hpDamage = rawResult.hpDamage;

  events.push({
    type: "roll",
    actor: actorId,
    die: "d4",
    value: hit.raw - monster.tier - Math.floor((aliveFighters.length - 1) / 2) - (bossPhase2 ? monster.tier : 0),
    purpose: "damage_monster",
  });
  events.push({
    type: "monster_attack",
    actor: actorId,
    target: target.id,
    damage_type: attackDamageType,
    raw_damage: hit.raw,
    damage_after_position: positionAdjusted,
    damage_after_mitigation: hit.final,
    armor_reduction: hit.armorReduction,
    resistance_reduction: hit.resistanceReduction,
    shield_absorbed: shieldAbsorbed,
    hp_damage: hpDamage,
  });

  const updatedFighters = s.fighters.map((f) =>
    f.id === target.id ? { ...f, shield: newShield, hp: Math.max(0, newHp) } : f,
  );
  const targetDowned = newHp <= 0 && target.hp > 0;
  if (targetDowned) {
    events.push({ type: "fighter_down", target: target.id });
  }

  let next: CombatState = {
    ...s,
    fighters: updatedFighters,
    ability_state: tickAbilityCountersAfterSwing(s.ability_state),
    stats: {
      ...s.stats,
      [target.id]: {
        ...(s.stats[target.id] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
        damage_taken: (s.stats[target.id]?.damage_taken ?? 0) + hpDamage,
      },
    },
    round_monster_targets: rmt,
  };

  // Elemental proc — fire/ice/lightning monster attacks can apply
  // burning / frozen / shocked to the target. 25% base, scaled down by
  // the target's resist_<type> stat. Skipped if the swing dropped them.
  if (newHp > 0 && (attackDamageType === "fire" || attackDamageType === "ice" || attackDamageType === "lightning")) {
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
    const heal = applyPaladinAutoHeal(next, target.id);
    next = heal.state;
    events.push(...heal.events);
  }

  const allDown = next.fighters.every((f) => f.hp <= 0);
  if (allDown) {
    events.push({ type: "defeat" });
    return { state: { ...next, status: "defeat" }, events };
  }
  next = advanceTurn(next);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

function handleHeal(
  state: CombatState,
  action: { kind: "heal"; actor: ActorId; target: ActorId },
  roll: RollFn,
): StepResult {
  const actor = state.fighters.find((f) => f.id === action.actor);
  if (!actor) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (actor.hp <= 0) return reject(state, `${action.actor} is downed`);
  if (actor.mana < 1) return reject(state, `${action.actor} has no mana to heal`);

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  // Heal costs 1 mana — deduct on the post-tick state.
  const s = {
    ...tick.state,
    fighters: tick.state.fighters.map((f) =>
      f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - 1) } : f,
    ),
  };
  const tickedActor = s.fighters.find((f) => f.id === action.actor)!;
  const target = s.fighters.find((f) => f.id === action.target);
  if (!target) return reject(s, `unknown heal target: ${action.target}`);
  if (target.hp <= 0) return reject(s, `cannot heal a downed target`);

  const { amount: baseRolled, roll: rollValue } = resolveHeal(tickedActor.magic_mod, roll);
  // Focus weapons boost heal output by their power (flat add).
  const rolled = baseRolled + tickedActor.focus_power;
  const newHp = Math.min(target.max_hp, target.hp + rolled);
  const applied = newHp - target.hp;

  const events: CombatEvent[] = [
    ...tick.events,
    { type: "roll", actor: action.actor, die: "d6", value: rollValue, purpose: "heal" },
    {
      type: "heal_applied",
      actor: action.actor,
      target: action.target,
      amount: applied,
      rolled,
    },
  ];

  const next = advanceTurn({
    ...s,
    fighters: s.fighters.map((f) =>
      f.id === action.target ? { ...f, hp: newHp } : f,
    ),
    stats: {
      ...s.stats,
      [action.actor]: {
        ...(s.stats[action.actor] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
        healing_done: (s.stats[action.actor]?.healing_done ?? 0) + applied,
      },
    },
  });
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

function handleShield(
  s: CombatState,
  action: { kind: "shield"; actor: ActorId; target?: ActorId },
): StepResult {
  const actor = s.fighters.find((f) => f.id === action.actor);
  if (!actor) return reject(s, `shield: actor ${action.actor} not found`);
  if (currentActor(s) !== action.actor) return reject(s, `not ${action.actor}'s turn`);
  if (actor.hp <= 0) return reject(s, "shield: actor is down");
  if (actor.mana < 1) return reject(s, `${action.actor} has no mana for shield`);

  const tick = tickAtTurnStart(s, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  // Shield costs 1 mana — deduct on the post-tick state.
  const state = {
    ...tick.state,
    fighters: tick.state.fighters.map((f) =>
      f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - 1) } : f,
    ),
  };

  const targetId = action.target ?? action.actor;
  const target = state.fighters.find((f) => f.id === targetId);
  if (!target) return reject(state, `shield: target ${targetId} not found`);
  if (target.hp <= 0) return reject(state, "shield: target is down");

  // Two modes:
  //   1. Target has armor equipped → replenish their depletable armor pool to
  //      floor(armor_power / 2). Same as the original self-shield behavior.
  //   2. Target has no armor → grant a flat "bonus barrier" capped by the
  //      MIN of actor.level and target.level so a high-level caster can't
  //      over-shield a low-level ally. Floor at 5, climbs slowly with level,
  //      hard cap at 15.
  // In both modes, never reduce existing shield — preserve overflow from
  // traps / passives.
  const tickedActor = state.fighters.find((f) => f.id === action.actor)!;
  const armorMax = Math.floor(target.armor_power / 2);
  let newArmor: number;
  let bonusBarrier = false;
  if (armorMax > 0) {
    newArmor = Math.max(target.shield, armorMax);
  } else {
    const minLevel = Math.min(tickedActor.level, target.level);
    const bonusShield = Math.min(15, 5 + Math.floor(minLevel / 2));
    newArmor = Math.max(target.shield, bonusShield);
    bonusBarrier = true;
  }
  const restored = newArmor - target.shield;

  const events: CombatEvent[] = [
    ...tick.events,
    {
      type: "shield_applied",
      actor: action.actor,
      target: targetId,
      restored,
      new_armor: newArmor,
      bonus_barrier: bonusBarrier,
    },
  ];

  const next = advanceTurn({
    ...state,
    fighters: state.fighters.map((f) =>
      f.id === targetId ? { ...f, shield: newArmor } : f,
    ),
    stats: {
      ...state.stats,
      [action.actor]: {
        ...(state.stats[action.actor] ?? { damage_taken: 0, healing_done: 0, shielding_done: 0, kills: 0 }),
        shielding_done: (state.stats[action.actor]?.shielding_done ?? 0) + restored,
      },
    },
  });
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

// ── Damage ability IDs ──────────────────────────────────────────────────────
// These active abilities deal direct damage and go through handleDamageAbility
// rather than the utility routing.
const DAMAGE_ABILITY_IDS = new Set([
  "smite", "wildgrowth", "crescendo", "manifest",
  "backstab", "bulwark_strike", "hex",
  "fireball",
]);

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

  // Drink buff — only buff_next_crit applies to ability damage.
  const drinkResult = dmgEffect.drink_buff_context === "ability"
    ? applyDrinkBuff(state, actorId, "ability", amount, isCrit)
    : { damage: amount, forceCrit: false, event: null as CombatEvent | null, nextDrinkBuffs: state.drink_buffs };
  amount = drinkResult.damage;
  if (drinkResult.forceCrit) isCrit = true;

  // Shocked amplifier.
  const sigShockedEffect = monster.effects.find((e) => e.type === "shocked");
  const sigShockMult = sigShockedEffect ? (sigShockedEffect.magnitude >= 2 ? 1.45 : 1.30) : 1.0;
  const finalDamage = Math.round(amount * sigShockMult);

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
  };

  if (phaseTransition) events.push({ type: "boss_phase_transition", new_phase: 2 });

  // Warlock Cursed Strike: crits apply bleed.
  if (isCrit && !monsterKilled) {
    const bleed = applyWarlockBleed(nextState, tickedActor, monster.id, true);
    nextState = bleed.state;
    events.push(...bleed.events);
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
  const hit = resolveMonsterHit(fleeMonster?.tier ?? 1, alive.length, 0, bossPhase2, roll, "physical", 0);
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
// Single entry point. Looks up the ActiveAbilityDef from the actor's class
// abilities array, validates mana, then routes damage abilities through
// handleDamageAbility and utility abilities through per-ability sub-handlers.

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

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const tickedActor = s.fighters.find((f) => f.id === action.actor)!;

  let sPostMana: CombatState = {
    ...s,
    fighters: s.fighters.map((f) =>
      f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - ability.mana_cost) } : f,
    ),
  };

  const usedEvent: CombatEvent = {
    type: "ability_used",
    actor: action.actor,
    ability_id: ability.id,
    name: ability.name,
    mana_spent: ability.mana_cost,
  };
  const preEvents: CombatEvent[] = [...tick.events, usedEvent];

  // ── Damage abilities ──
  if (DAMAGE_ABILITY_IDS.has(ability.id)) {
    if (ability.target === "all_enemies") {
      const liveMonsters = sPostMana.monsters.filter((m) => m.hp > 0);
      if (liveMonsters.length === 0) return reject(sPostMana, "no valid targets");
      return handleAoeDamageAbility(sPostMana, action.actor, tickedActor, ability, preEvents, roll);
    }

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

  // ── Utility abilities ──
  switch (ability.id) {
    case "taunt":
      return abilityTaunt(sPostMana, action.actor, preEvents);
    case "containerize":
      return abilityContainerize(sPostMana, action.actor, preEvents);
    case "regression_shield":
      return abilityRegressionShield(sPostMana, action.actor, preEvents);
    case "vanish":
      return abilityVanish(sPostMana, action.actor, preEvents);
    case "soul_drain": {
      const drainTarget = action.target_id
        ? sPostMana.monsters.find((m) => m.id === action.target_id && m.hp > 0)
        : sPostMana.monsters.find((m) => m.hp > 0);
      if (!drainTarget) return reject(sPostMana, "no valid target for soul drain");
      return abilitySoulDrain(sPostMana, action.actor, tickedActor, drainTarget.id, preEvents, roll);
    }
    case "battle_hymn":
      return abilityBattleHymn(sPostMana, action.actor, preEvents);
    case "foresee":
      return abilityForesee(sPostMana, action.actor, preEvents, roll);
    case "migrate":
      return abilityMigrate(sPostMana, action, preEvents);
    default:
      return reject(sPostMana, `unknown ability: ${ability.id}`);
  }
}

function abilityTaunt(state: CombatState, actor: ActorId, events: CombatEvent[]): StepResult {
  const SWINGS = 2;
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    taunt: { actor_id: actor, swings_remaining: SWINGS },
  };
  const next = advanceTurn({ ...state, ability_state });
  return {
    state: next,
    events: [...events, { type: "ability_taunt", actor, swings: SWINGS }, ...turnStartEvent(next)],
  };
}

function abilityContainerize(state: CombatState, actor: ActorId, events: CombatEvent[]): StepResult {
  // Apply "stunned" status effect to the current live monster. `remaining=5`
  // gives tickEffects four decrements before the safety-net expiry, matching
  // the 4-turn max stun duration (turnsElapsed = 5 - remaining after each tick).
  const targetMonster = state.monsters.find((m) => m.hp > 0);
  if (!targetMonster) return reject(state, "no live monster to containerize");
  const stunnedEffect: MachineStatusEffect = {
    type: "stunned",
    magnitude: 0,
    remaining: 5,
    source: actor,
  };
  const updatedMonsters = state.monsters.map((m) =>
    m.id === targetMonster.id
      ? { ...m, effects: [...m.effects.filter((e) => e.type !== "stunned"), stunnedEffect] }
      : m,
  );
  const next = advanceTurn({ ...state, monsters: updatedMonsters });
  return {
    state: next,
    events: [...events, { type: "ability_containerize" }, ...turnStartEvent(next)],
  };
}

function abilityRegressionShield(
  state: CombatState,
  actor: ActorId,
  events: CombatEvent[],
): StepResult {
  const paladin = state.fighters.find((f) => f.id === actor);
  const SHIELD_AMOUNT = 3 + Math.floor((paladin?.level ?? 1) / 4);
  const grants: { target: ActorId; amount: number }[] = [];
  const updatedFighters = state.fighters.map((f) => {
    if (f.hp <= 0) return f;
    const cap = f.max_hp * SHIELD_CAP_MULTIPLIER;
    const newShield = Math.min(cap, f.shield + SHIELD_AMOUNT);
    const added = newShield - f.shield;
    if (added > 0) grants.push({ target: f.id, amount: added });
    return { ...f, shield: newShield };
  });
  const next = advanceTurn({ ...state, fighters: updatedFighters });
  return {
    state: next,
    events: [
      ...events,
      { type: "ability_regression_shield", actor, grants },
      ...turnStartEvent(next),
    ],
  };
}

function abilityVanish(state: CombatState, actor: ActorId, events: CombatEvent[]): StepResult {
  const SWINGS = 2;
  const prev = state.ability_state?.vanished ?? {};
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    vanished: { ...prev, [actor]: SWINGS },
  };
  // If a taunt is currently locking the monster onto this fighter, the
  // vanish supersedes it — clear the taunt so the next swing re-picks.
  if (ability_state.taunt?.actor_id === actor) {
    delete ability_state.taunt;
  }
  const next = advanceTurn({ ...state, ability_state });
  return {
    state: next,
    events: [...events, { type: "ability_vanish", actor, swings: SWINGS }, ...turnStartEvent(next)],
  };
}

function abilitySoulDrain(
  state: CombatState,
  actor: ActorId,
  tickedActor: CombatFighter,
  targetMonsterId: ActorId,
  events: CombatEvent[],
  roll: RollFn,
): StepResult {
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return reject(state, "no valid target for soul drain");
  const d6 = roll(6);
  const rawDamage = d6 + tickedActor.magic_mod;
  // Cap at monster_hp - 1 so soul_drain never delivers the kill blow (matches
  // slack's pattern — keeps the engine's killed_by logic working off attacks).
  const damage = Math.min(rawDamage, Math.max(1, targetMonster.hp - 1));
  const heal = Math.floor(damage / 2);
  const newMonsterHp = Math.max(0, targetMonster.hp - damage);
  const oldHp = tickedActor.hp;
  const newHp = Math.min(tickedActor.max_hp, oldHp + heal);
  const applied = newHp - oldHp;

  const updatedFighters = state.fighters.map((f) =>
    f.id === actor ? { ...f, hp: newHp } : f,
  );

  const next = advanceTurn({
    ...state,
    fighters: updatedFighters,
    monsters: state.monsters.map((m) => m.id === targetMonsterId ? { ...m, hp: newMonsterHp } : m),
    contribution: {
      ...state.contribution,
      [actor]: (state.contribution[actor] ?? 0) + damage,
    },
  });

  return {
    state: next,
    events: [
      ...events,
      { type: "roll", actor, die: "d6", value: d6, purpose: "damage_cast" },
      {
        type: "ability_soul_drain",
        actor,
        damage,
        healed: applied,
        roll: d6,
        formula: `${d6}+${tickedActor.magic_mod}m, half drained`,
      },
      ...turnStartEvent(next),
    ],
  };
}

function abilityBattleHymn(state: CombatState, actor: ActorId, events: CombatEvent[]): StepResult {
  // Charges scale with Bard level: +1 every 5 levels beyond 1.
  // L1→2, L5→3, L10→4, L15→5, L20→6. Caps naturally — durational buff only,
  // no per-hit damage change, so high-level Bards sustain more turns of aura.
  const bard = state.fighters.find((f) => f.id === actor);
  const CHARGES = 2 + Math.floor((bard?.level ?? 1) / 5);
  const prev = state.ability_state?.battle_hymn ?? 0;
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    battle_hymn: prev + CHARGES,
  };
  const next = advanceTurn({ ...state, ability_state });
  return {
    state: next,
    events: [
      ...events,
      { type: "ability_battle_hymn", actor, charges_added: CHARGES },
      ...turnStartEvent(next),
    ],
  };
}

// Builds the full Foresee intel payload from current state. Shared between
// the initial cast and subsequent turn refreshes.
function buildForeseeEvent(
  state: CombatState,
  actor: ActorId,
  roll: RollFn,
  turnsRemaining: number,
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

  // Determine confirmed/predicted target (honors taunt and vanish).
  let predicted: ActorId | null = null;
  const taunted = abilityState.taunt;
  if (taunted && taunted.swings_remaining > 0) {
    const tauntTarget = aliveFighters.find((f) => f.id === taunted.actor_id);
    if (tauntTarget) predicted = tauntTarget.id;
  }
  if (!predicted && aliveFighters.length > 0) {
    const eligible = aliveFighters.filter((f) => (vanishedMap[f.id] ?? 0) <= 0);
    const pool = eligible.length > 0 ? eligible : aliveFighters;
    const pick = pickMonsterTarget(pool, () => roll(101) / 100);
    predicted = pick.id;
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
    containerize: liveMonster?.effects.some((e) => e.type === "stunned") ? 1 : 0,
    taunt_actor: taunted && taunted.swings_remaining > 0 ? taunted.actor_id : null,
    taunt_swings: taunted?.swings_remaining ?? 0,
    vanished: vanishedIds,
  };

  return {
    type: "ability_foresee",
    actor,
    predicted_target: predicted,
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

function abilityForesee(
  state: CombatState,
  actor: ActorId,
  events: CombatEvent[],
  roll: RollFn,
): StepResult {
  const FORESEE_TURNS = 2;
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    foresee_turns: FORESEE_TURNS,
  };
  const next = advanceTurn({ ...state, ability_state });
  return {
    state: next,
    events: [
      ...events,
      buildForeseeEvent({ ...state, ability_state }, actor, roll, FORESEE_TURNS),
      ...turnStartEvent(next),
    ],
  };
}

// After the monster acts, checks if the next actor is a Staff Sage with
// foresee_turns > 0. If so, inserts the intel refresh event immediately
// BEFORE the final turn_start divider so the Sage sees fresh info at the
// top of their own turn — after the monster's swing settled, before they
// pick their action.
function withForeseeForNextActor(result: StepResult, roll: RollFn): StepResult {
  const actorId = currentActor(result.state);
  if (!actorId || isMonsterActor(actorId)) return result;
  const sage = result.state.fighters.find((f) => f.id === actorId && classHasPassive(f.class, "sages_reading"));
  if (!sage) return result;
  const turns = result.state.ability_state?.foresee_turns ?? 0;
  if (turns <= 0) return result;

  const remaining = turns - 1;
  const ability_state: AbilityRuntimeState = remaining > 0
    ? { ...(result.state.ability_state ?? {}), foresee_turns: remaining }
    : (stripField(result.state.ability_state, "foresee_turns") ?? {});
  const newState = { ...result.state, ability_state };
  const refreshEvent = buildForeseeEvent(newState, actorId, roll, remaining);

  // Insert before the last turn_start event so the readout appears inside
  // the Sage's upcoming turn block rather than at the tail of the monster's.
  const events = [...result.events];
  let insertAt = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "turn_start") { insertAt = i; break; }
  }
  events.splice(insertAt, 0, refreshEvent);
  return { state: newState, events };
}

function abilityMigrate(
  state: CombatState,
  action: { kind: "ability"; actor: ActorId; target?: ActorId; position?: BattlePosition },
  events: CombatEvent[],
): StepResult {
  const targetId = action.target ?? action.actor;
  const target = state.fighters.find((f) => f.id === targetId);
  if (!target) return reject(state, `unknown migrate target: ${targetId}`);
  if (target.hp <= 0) return reject(state, `cannot migrate a downed partymate`);
  if (!action.position) return reject(state, `migrate requires a position`);
  if (target.position === action.position) {
    return reject(state, `${targetId} is already in the ${action.position} row`);
  }
  const updatedFighters = state.fighters.map((f) =>
    f.id === targetId ? { ...f, position: action.position! } : f,
  );
  const next = advanceTurn({ ...state, fighters: updatedFighters });
  return {
    state: next,
    events: [
      ...events,
      {
        type: "ability_migrate",
        actor: action.actor,
        target: targetId,
        from: target.position,
        to: action.position,
      },
      ...turnStartEvent(next),
    ],
  };
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
    if (eff.type === "empowered" || eff.type === "frozen" || eff.type === "shocked" || eff.type === "stunned") {
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
    const newState: CombatState = {
      ...state,
      monsters: state.monsters.map((m) =>
        m.id === actorId ? { ...m, hp: tick.newHp, effects: tick.newEffects } : m,
      ),
    };
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

// SRE Warden — Harden Up. First action of the fight grants WARDEN_STARTING_SHIELD
// shield (clamped to cap). Once per fight.
function applyWardenStartingShield(
  state: CombatState,
  actor: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (!classHasPassive(actor.class, "harden_up")) return { state, events: [] };
  if (isPassiveUsed(state, actor.id, PASSIVE_WARDEN_SHIELD)) return { state, events: [] };
  // VIT-based when STATS_V2 stats are present; level fallback for legacy states.
  const wardenShield = actor.stats
    ? Math.floor(actor.stats.vit / 2)
    : WARDEN_STARTING_SHIELD + Math.floor(actor.level / 6);
  const cap = Math.floor(actor.armor_power / 2);
  const newShield = Math.min(cap, actor.shield + wardenShield);
  const added = newShield - actor.shield;
  const updated = state.fighters.map((f) =>
    f.id === actor.id ? { ...f, shield: newShield } : f,
  );
  const marked = markPassiveUsed({ ...state, fighters: updated }, actor.id, PASSIVE_WARDEN_SHIELD);
  return {
    state: marked,
    events: [{ type: "passive_warden_shield", actor: actor.id, amount: added }],
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
  const warden = applyWardenStartingShield(state, fighter);
  const wardenFighter = warden.state.fighters.find((f) => f.id === actorId) ?? fighter;
  const druid = applyDruidRegen(warden.state, wardenFighter);
  const druidFighter = druid.state.fighters.find((f) => f.id === actorId) ?? wardenFighter;
  const mana = applyManaFont(druid.state, druidFighter);
  const finalFighter = mana.state.fighters.find((f) => f.id === actorId) ?? druidFighter;
  return {
    state: mana.state,
    fighter: finalFighter,
    events: [...warden.events, ...druid.events, ...mana.events],
  };
}

// Frontend Bard — Bardic Aura. While any Bard is alive, every non-Bard
// partymate attack/cast deals +1 damage. Battle Hymn temporarily boosts the
// aura to +3 for HYMN_USES attacks (each landed swing consumes one charge).
// Returns the bonus and whether a hymn charge was consumed.
function computeBardAuraBonus(
  state: CombatState,
  attacker: CombatFighter,
): { bonus: number; hymn_consumed: boolean } {
  if (classHasPassive(attacker.class, "bardic_aura")) return { bonus: 0, hymn_consumed: false };
  const bardAlive = state.fighters.some(
    (f) => f.hp > 0 && classHasPassive(f.class, "bardic_aura"),
  );
  if (!bardAlive) return { bonus: 0, hymn_consumed: false };
  const hymnCharges = state.ability_state?.battle_hymn ?? 0;
  if (hymnCharges > 0) {
    return { bonus: BARD_AURA_HYMN_DAMAGE, hymn_consumed: true };
  }
  return { bonus: BARD_AURA_DAMAGE, hymn_consumed: false };
}

// Data Warlock — Cursed Strike. On a critical attack/cast, apply a 2-turn
// bleed to the target monster. Always-on (no usage tracking).
function applyWarlockBleed(
  state: CombatState,
  actor: CombatFighter,
  targetMonsterId: ActorId,
  isCrit: boolean,
): { state: CombatState; events: CombatEvent[] } {
  if (!isCrit || !classHasPassive(actor.class, "cursed_strike")) return { state, events: [] };
  const targetMonster = state.monsters.find((m) => m.id === targetMonsterId && m.hp > 0);
  if (!targetMonster) return { state, events: [] };
  const newEffect: MachineStatusEffect = {
    type: "bleeding",
    magnitude: WARLOCK_BLEED_MAGNITUDE,
    remaining: WARLOCK_BLEED_DURATION,
    source: actor.id,
  };
  const updated: CombatState = {
    ...state,
    monsters: state.monsters.map((m) =>
      m.id === targetMonsterId ? { ...m, effects: mergeEffect(m.effects, newEffect) } : m,
    ),
  };
  return {
    state: updated,
    events: [
      {
        type: "passive_warlock_bleed",
        actor: actor.id,
        magnitude: WARLOCK_BLEED_MAGNITUDE,
        duration: WARLOCK_BLEED_DURATION,
      },
    ],
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

// QA Paladin — Lay on Hands. After a monster swing lands, if any alive
// fighter ended below PALADIN_AUTO_HEAL_THRESHOLD of max HP, the first
// unused Paladin in the party auto-heals them for PALADIN_AUTO_HEAL_AMOUNT.
// Once per fight per Paladin.
function applyPaladinAutoHeal(
  state: CombatState,
  hitTargetId: ActorId,
): { state: CombatState; events: CombatEvent[] } {
  const target = state.fighters.find((f) => f.id === hitTargetId);
  if (!target || target.hp <= 0) return { state, events: [] };
  if (target.hp >= target.max_hp * PALADIN_AUTO_HEAL_THRESHOLD) return { state, events: [] };
  const paladin = state.fighters.find(
    (f) =>
      classHasPassive(f.class, "lay_on_hands")
      && f.hp > 0
      && !isPassiveUsed(state, f.id, PASSIVE_PALADIN_AUTO_HEAL),
  );
  if (!paladin) return { state, events: [] };
  const healAmount = PALADIN_AUTO_HEAL_AMOUNT + Math.floor((paladin.level ?? 1) / 4);
  const newHp = Math.min(target.max_hp, target.hp + healAmount);
  const added = newHp - target.hp;
  const healed = state.fighters.map((f) =>
    f.id === target.id ? { ...f, hp: newHp } : f,
  );
  const marked = markPassiveUsed({ ...state, fighters: healed }, paladin.id, PASSIVE_PALADIN_AUTO_HEAL);
  return {
    state: marked,
    events: [
      {
        type: "passive_paladin_auto_heal",
        paladin: paladin.id,
        target: target.id,
        amount: added,
      },
    ],
  };
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
  context: "attack" | "cast" | "ability",
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
  } else if (buff.kind === "buff_magic" && context === "cast") {
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
      return { ...state, turn_index: candidate, round: state.round + roundBump };
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
