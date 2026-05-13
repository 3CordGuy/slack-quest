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
  resolveShield,
  resolveSignature,
  type BattlePosition,
} from "./combat";
import {
  ABILITIES,
  SHIELD_CAP_MULTIPLIER,
  classByName,
  type AbilityId,
  type EffectType,
  type WeaponRange,
} from "./flavor";

export type ActorId = string;
export const MONSTER_ID: ActorId = "__monster__";

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
}

export interface GauntletWaveSpec {
  name: string;
  max_hp: number;
}

export interface CombatMonster {
  name: string;
  hp: number;
  max_hp: number;
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
}

export type CombatStatus = "pending" | "active" | "victory" | "defeat" | "fled";

export interface CombatState {
  fighters: CombatFighter[];
  monster: CombatMonster;
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
  // Active class abilities write transient buffs/debuffs here. Each field
  // counts down on use; absence means inactive. Persists across rounds until
  // exhausted or combat ends.
  ability_state?: AbilityRuntimeState;
  // Once-per-fight passives that have already fired, keyed by fighter id.
  // Always-on passives (Bard aura, Druid regen, Warlock crit-bleed, Sage info)
  // don't appear here — they don't burn out.
  passives_used?: Record<ActorId, string[]>;
}

// Passive tuning knobs. Mirror src/commands.ts constants in main.
const WARDEN_STARTING_SHIELD = 5;
const DRUID_PASSIVE_REGEN = 1;
const BARD_AURA_DAMAGE = 1;
const BARD_AURA_HYMN_DAMAGE = 3;
const WARLOCK_BLEED_MAGNITUDE = 2;
const WARLOCK_BLEED_DURATION = 2;
const PALADIN_AUTO_HEAL_AMOUNT = 8;
const PALADIN_AUTO_HEAL_THRESHOLD = 0.3;

// Keys for once-per-fight passives.
const PASSIVE_WARDEN_SHIELD = "warden_shield";
const PASSIVE_MAGE_FREE_SIG = "mage_free_sig";
const PASSIVE_ROGUE_FIRST_CRIT = "rogue_first_crit";
const PASSIVE_PALADIN_AUTO_HEAL = "paladin_auto_heal";

export interface AbilityRuntimeState {
  // SRE Warden — monster's next N swings forced to target actor_id.
  taunt?: { actor_id: ActorId; swings_remaining: number };
  // DevOps Mage — monster skips its next N swings entirely.
  skip_swings?: number;
  // Refactor Rogue — these fighters cannot be targeted; map of actor → swings left.
  vanished?: Record<ActorId, number>;
  // Frontend Bard — next N partymate attacks deal +2 damage.
  battle_hymn?: number;
  // Mark / focus-fire — partymates other than the marker get +MARK_BONUS
  // damage on attack/cast until `expires_after_round` is exceeded. Cleared
  // when the monster falls or a wave transition fires.
  mark?: { marked_by: ActorId; expires_after_round: number };
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
  | { kind: "attack"; actor: ActorId }
  | { kind: "cast"; actor: ActorId }
  | { kind: "heal"; actor: ActorId; target: ActorId }
  | { kind: "shield"; actor: ActorId; target: ActorId }
  | { kind: "signature"; actor: ActorId }
  | { kind: "flee"; actor: ActorId }
  | { kind: "position"; actor: ActorId; to: BattlePosition }
  | { kind: "wait"; actor: ActorId }
  | { kind: "mark"; actor: ActorId }
  | {
      kind: "ability";
      actor: ActorId;
      ability_id: AbilityId;
      // Used by migrate (target+position) and would be ignored otherwise.
      target?: ActorId;
      position?: BattlePosition;
    }
  | { kind: "monster_act" };

export type RollPurpose =
  | "initiative"
  | "hit_check"
  | "damage_attack"
  | "damage_cast"
  | "damage_monster"
  | "heal"
  | "shield"
  | "signature"
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
      crit: boolean;
      formula: string;
    }
  | {
      type: "monster_attack";
      target: ActorId;
      raw_damage: number;
      damage_after_position: number;
      damage_after_armor: number;
      shield_absorbed: number;
      hp_damage: number;
    }
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
      type: "shield_applied";
      actor: ActorId;
      target: ActorId;
      amount: number;        // actual shield added (clamped to cap)
      rolled: number;        // shield rolled before clamp
    }
  | {
      type: "signature_used";
      actor: ActorId;
      damage: number;
      formula: string;
      mana_spent: number;
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
      ability_id: AbilityId;
      name: string;
      mana_spent: number;
    }
  | { type: "ability_taunt"; actor: ActorId; swings: number }
  | { type: "ability_containerize"; swings: number }
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
      predicted_target: ActorId | null;
      damage_lo: number;
      damage_hi: number;
    }
  | {
      type: "ability_migrate";
      actor: ActorId;
      target: ActorId;
      from: BattlePosition;
      to: BattlePosition;
    }
  | { type: "monster_swing_skipped"; reason: "containerize" }
  | { type: "monster_target_redirected"; from: ActorId; to: ActorId; reason: "taunt" | "vanish" }
  | { type: "battle_hymn_consumed"; actor: ActorId; bonus: number; remaining: number }
  | { type: "mark_applied"; actor: ActorId; expires_after_round: number; bonus: number }
  | { type: "mark_bonus"; actor: ActorId; bonus: number }
  | { type: "passive_warden_shield"; actor: ActorId; amount: number }
  | { type: "passive_mage_free_sig"; actor: ActorId }
  | { type: "passive_druid_regen"; actor: ActorId; amount: number }
  | { type: "passive_rogue_first_crit"; actor: ActorId }
  | { type: "passive_bard_aura"; actor: ActorId; source: ActorId; bonus: number }
  | { type: "passive_warlock_bleed"; actor: ActorId; magnitude: number; duration: number }
  | { type: "passive_paladin_auto_heal"; paladin: ActorId; target: ActorId; amount: number }
  | { type: "victory" }
  | { type: "defeat" }
  | { type: "rejected"; reason: string };

// AC formulas — defense thresholds the attacker must equal or exceed on a
// d20 + relevant modifier. Tuned so low-tier monsters are easy to hit and
// boss-tier (tier 5+) take real swings to land. Armor still mitigates
// landed damage in resolveMonsterHit — it doesn't double-up here as AC.
const MONSTER_BASE_AC = 10;
const FIGHTER_AC = 10;
export const monsterAc = (tier: number) => MONSTER_BASE_AC + Math.max(0, tier);

export interface StepResult {
  state: CombatState;
  events: CombatEvent[];
}

export type RollFn = (sides: number) => number;

// Inputs for the initial state. Build it once from D1 data, then feed into
// step({ kind: "begin" }) to roll initiative and enter the active phase.
// Wave fields on monster are opt-in: omit them for standard/boss combats.
export interface CombatInit {
  // focus_power and weapon_range default to 0 and "melee" when omitted — keeps
  // older call sites and tests valid without having to know about focus weapons.
  fighters: (Omit<CombatFighter, "initiative" | "effects" | "focus_power" | "weapon_range"> & {
    focus_power?: number;
    weapon_range?: WeaponRange;
  })[];
  monster: Omit<CombatMonster, "initiative" | "effects" | "boss_phase"> & {
    boss_phase?: 1 | 2;
  };
}

export function createCombatState(init: CombatInit): CombatState {
  const contribution: Record<ActorId, number> = {};
  for (const f of init.fighters) contribution[f.id] = 0;
  return {
    fighters: init.fighters.map((f) => ({
      ...f,
      focus_power: f.focus_power ?? 0,
      weapon_range: f.weapon_range ?? "melee",
      initiative: 0,
      effects: [],
    })),
    monster: {
      ...init.monster,
      initiative: 0,
      effects: [],
      boss_phase: init.monster.boss_phase ?? 1,
    },
    turn_order: [],
    turn_index: 0,
    round: 0,
    status: "pending",
    contribution,
  };
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
      return handleShield(state, action, roll);
    case "signature":
      return handleSignature(state, action, roll);
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
      return handleMonsterAct(state, roll);
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
      const init = roll(20);
      initiatives[f.id] = init;
      return { ...f, initiative: init };
    }),
    monster: {
      ...state.monster,
      initiative: (() => {
        const init = roll(20);
        initiatives[MONSTER_ID] = init;
        return init;
      })(),
    },
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
      {
        type: "roll",
        actor: MONSTER_ID,
        die: "d20",
        value: next.monster.initiative,
        purpose: "initiative",
      },
      { type: "turn_start", actor: firstActor, round: 1 },
    ],
  };
}

function handlePlayerHit(
  state: CombatState,
  action: { kind: "attack" | "cast"; actor: ActorId },
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
    action.kind === "attack"
    && fighter.position === "back"
    && state.fighters.length > 1
    && fighter.weapon_range !== "ranged"
    && fighter.weapon_range !== "focus"
  ) {
    return reject(state, "back-row melee blocked — equip a ranged or focus weapon, cast, or move to front");
  }

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const tickedFighter = s.fighters.find((f) => f.id === action.actor)!;

  const events: CombatEvent[] = [...tick.events];
  const classMod = action.kind === "cast" ? tickedFighter.magic_mod : tickedFighter.attack_mod;

  // ── d20 to-hit ──
  const d20 = roll(20);
  const ac = monsterAc(s.monster.tier);
  const hitTotal = d20 + classMod;
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
    target: MONSTER_ID,
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
    && classIdOf(tickedFighter) === "refactor_rogue"
    && !isCrit
    && !isPassiveUsed(s, action.actor, PASSIVE_ROGUE_FIRST_CRIT)
  ) {
    isCrit = true;
    damage = damage * 2;
    rogueFirstCritFired = true;
  }

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
    && s.round <= mark.expires_after_round;
  const markBonus = markActive ? MARK_BONUS : 0;

  const finalDamage = damage + aura.bonus + markBonus;

  const oldHp = s.monster.hp;
  const newHp = Math.max(0, oldHp - finalDamage);
  const monsterKilled = newHp <= 0;
  const phaseTransition =
    s.monster.is_boss &&
    s.monster.boss_phase === 1 &&
    isBossPhaseTransition(s.monster.max_hp, oldHp, newHp);

  if (rogueFirstCritFired) {
    events.push({ type: "passive_rogue_first_crit", actor: action.actor });
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
  events.push({
    type: "player_hit",
    actor: action.actor,
    target: MONSTER_ID,
    damage: finalDamage,
    crit: isCrit,
    formula: `${hit.roll}+${hit.totalMod}${isCrit ? " ×2" : ""}${aura.bonus > 0 ? ` +${aura.bonus} aura` : ""}${markBonus > 0 ? ` +${markBonus} mark` : ""}`,
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
    monster: {
      ...s.monster,
      hp: newHp,
      ...(phaseTransition ? { boss_phase: 2 as const } : {}),
    },
    contribution: {
      ...s.contribution,
      [action.actor]: (s.contribution[action.actor] ?? 0) + finalDamage,
    },
    ability_state: abilityStateAfterHymn,
  };
  if (rogueFirstCritFired) {
    nextState = markPassiveUsed(nextState, action.actor, PASSIVE_ROGUE_FIRST_CRIT);
  }

  // Data Warlock — Cursed Strike. Applies bleed on a crit attack/cast. Always-on.
  if (isCrit && !monsterKilled) {
    const bleed = applyWarlockBleed(nextState, tickedFighter, true);
    nextState = bleed.state;
    events.push(...bleed.events);
  }

  if (phaseTransition) {
    events.push({ type: "boss_phase_transition", new_phase: 2 });
  }

  if (monsterKilled) {
    return resolveMonsterKill(nextState, action.actor, events);
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
  action: { kind: "mark"; actor: ActorId },
): StepResult {
  const fighter = state.fighters.find((f) => f.id === action.actor);
  if (!fighter) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (fighter.hp <= 0) return reject(state, `${action.actor} is downed`);
  if (state.monster.hp <= 0) return reject(state, `no live foe to mark`);

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;

  const expires_after_round = s.round + MARK_ROUNDS;
  const ability_state: AbilityRuntimeState = {
    ...(s.ability_state ?? {}),
    mark: { marked_by: action.actor, expires_after_round },
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
  if (currentActor(state) !== MONSTER_ID) {
    return reject(state, "not the monster's turn");
  }

  const tick = tickAtTurnStart(state, MONSTER_ID);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;

  const events: CombatEvent[] = [...tick.events];

  // Containerize: monster skips this swing entirely. Consume one charge,
  // emit the skip event, advance turn. No to-hit roll, no damage.
  const skips = s.ability_state?.skip_swings ?? 0;
  if (skips > 0) {
    const remaining = skips - 1;
    const ability_state = remaining > 0
      ? { ...s.ability_state, skip_swings: remaining }
      : stripField(s.ability_state, "skip_swings");
    const skippedState: CombatState = { ...s, ability_state };
    const next = advanceTurn(skippedState);
    return {
      state: next,
      events: [
        ...events,
        { type: "monster_swing_skipped", reason: "containerize" },
        ...turnStartEvent(next),
      ],
    };
  }

  const aliveFighters = s.fighters.filter((f) => f.hp > 0);
  if (aliveFighters.length === 0) {
    // Should be unreachable — defeat is checked after each fighter falls.
    return { state: { ...s, status: "defeat" }, events: [...events, { type: "defeat" }] };
  }

  // Target selection honors taunt (override) and vanish (filter out).
  const initialTarget = pickMonsterTarget(aliveFighters, () => roll(101) / 100);
  const vanished = s.ability_state?.vanished ?? {};
  const taunted = s.ability_state?.taunt;
  let target = initialTarget;
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
      const reroll = pickMonsterTarget(eligible, () => roll(101) / 100);
      events.push({
        type: "monster_target_redirected",
        from: initialTarget.id,
        to: reroll.id,
        reason: "vanish",
      });
      target = reroll;
    }
    // If all alive fighters are vanished, the swing falls through to the
    // initial pick — vanish doesn't grant collective invincibility.
  }

  // ── d20 to-hit ──
  const d20 = roll(20);
  const modifier = s.monster.tier;
  const hitTotal = d20 + modifier;
  const landed = hitTotal >= FIGHTER_AC;
  events.push({
    type: "roll",
    actor: MONSTER_ID,
    die: "d20",
    value: d20,
    purpose: "hit_check",
  });
  events.push({
    type: "hit_check",
    actor: MONSTER_ID,
    target: target.id,
    roll: d20,
    modifier,
    total: hitTotal,
    ac: FIGHTER_AC,
    hit: landed,
  });

  if (!landed) {
    // Even a miss consumes one tick of taunt / vanish — the swing happened.
    const decremented: CombatState = { ...s, ability_state: tickAbilityCountersAfterSwing(s.ability_state) };
    const next = advanceTurn(decremented);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // ── damage roll on hit ──
  const totalArmor = target.armor_power;
  const bossPhase2 = s.monster.is_boss && s.monster.boss_phase === 2;
  const hit = resolveMonsterHit(
    s.monster.tier,
    aliveFighters.length,
    totalArmor,
    bossPhase2,
    roll,
  );
  const positionAdjusted = positionDamageMod(target.position, hit.final);
  const { newShield, newHp, shieldAbsorbed, hpDamage } = applyDamageWithShield(
    positionAdjusted,
    target.shield,
    target.hp,
  );

  events.push({
    type: "roll",
    actor: MONSTER_ID,
    die: "d4",
    value: hit.raw - s.monster.tier - Math.floor((aliveFighters.length - 1) / 2) - (bossPhase2 ? s.monster.tier : 0),
    purpose: "damage_monster",
  });
  events.push({
    type: "monster_attack",
    target: target.id,
    raw_damage: hit.raw,
    damage_after_position: positionAdjusted,
    damage_after_armor: hit.final,
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
  };

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

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
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
  });
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

function handleShield(
  state: CombatState,
  action: { kind: "shield"; actor: ActorId; target: ActorId },
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
  const target = s.fighters.find((f) => f.id === action.target);
  if (!target) return reject(s, `unknown shield target: ${action.target}`);
  if (target.hp <= 0) return reject(s, `cannot shield a downed target`);

  const { amount: baseRolled, roll: rollValue } = resolveShield(tickedActor.magic_mod, roll);
  const rolled = baseRolled + tickedActor.focus_power;
  const cap = target.max_hp * SHIELD_CAP_MULTIPLIER;
  const newShield = Math.min(cap, target.shield + rolled);
  const applied = newShield - target.shield;

  const events: CombatEvent[] = [
    ...tick.events,
    { type: "roll", actor: action.actor, die: "d6", value: rollValue, purpose: "shield" },
    {
      type: "shield_applied",
      actor: action.actor,
      target: action.target,
      amount: applied,
      rolled,
    },
  ];

  const next = advanceTurn({
    ...s,
    fighters: s.fighters.map((f) =>
      f.id === action.target ? { ...f, shield: newShield } : f,
    ),
  });
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

function handleSignature(
  state: CombatState,
  action: { kind: "signature"; actor: ActorId },
  roll: RollFn,
): StepResult {
  const actor = state.fighters.find((f) => f.id === action.actor);
  if (!actor) return reject(state, `unknown actor: ${action.actor}`);
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  if (actor.hp <= 0) return reject(state, `${action.actor} is downed`);
  // DevOps Mage — Mana Catalyst. First signature each fight is free (0 mana).
  // We check this BEFORE tickAtTurnStart so the mana gate accepts a Mage with
  // 0 mana on their first signature.
  const mageFreeSig =
    classByName(actor.class).id === "devops_mage"
    && !isPassiveUsed(state, action.actor, PASSIVE_MAGE_FREE_SIG);
  if (!mageFreeSig && actor.mana < 1) return reject(state, `${action.actor} has no mana for signature`);

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const tickedActor = s.fighters.find((f) => f.id === action.actor)!;

  const cls = classByName(tickedActor.class);
  const partySize = s.fighters.filter((f) => f.hp > 0).length;
  const sig = resolveSignature(
    cls.id,
    tickedActor.attack_mod,
    tickedActor.magic_mod,
    tickedActor.weapon_power,
    s.monster.tier,
    partySize,
    s.monster.max_hp,
    roll,
  );

  const oldHp = s.monster.hp;
  const newHp = Math.max(0, oldHp - sig.damage);
  const monsterKilled = newHp <= 0;
  const phaseTransition =
    s.monster.is_boss &&
    s.monster.boss_phase === 1 &&
    isBossPhaseTransition(s.monster.max_hp, oldHp, newHp);

  const manaSpent = mageFreeSig ? 0 : 1;
  const events: CombatEvent[] = [
    ...tick.events,
    {
      type: "signature_used",
      actor: action.actor,
      damage: sig.damage,
      formula: sig.formula,
      mana_spent: manaSpent,
    },
  ];
  if (mageFreeSig) {
    events.push({ type: "passive_mage_free_sig", actor: action.actor });
  }

  let nextState: CombatState = {
    ...s,
    fighters: s.fighters.map((f) =>
      f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - manaSpent) } : f,
    ),
    monster: {
      ...s.monster,
      hp: newHp,
      ...(phaseTransition ? { boss_phase: 2 as const } : {}),
    },
    contribution: {
      ...s.contribution,
      [action.actor]: (s.contribution[action.actor] ?? 0) + sig.damage,
    },
  };
  if (mageFreeSig) {
    nextState = markPassiveUsed(nextState, action.actor, PASSIVE_MAGE_FREE_SIG);
  }

  if (phaseTransition) {
    events.push({ type: "boss_phase_transition", new_phase: 2 });
  }
  if (monsterKilled) {
    return resolveMonsterKill(nextState, action.actor, events);
  }
  nextState = advanceTurn(nextState);
  return { state: nextState, events: [...events, ...turnStartEvent(nextState)] };
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
  const d20 = roll(20);
  const modifier = Math.max(tickedActor.attack_mod, tickedActor.magic_mod);
  const dc = 10 + s.monster.tier;
  const total = d20 + modifier;
  const success = total >= dc;

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
  // no armor mitigation (back turned). Damage = resolveMonsterHit's normal
  // damage roll, applied through shield/HP.
  const alive = s.fighters.filter((f) => f.hp > 0);
  const bossPhase2 = s.monster.is_boss && s.monster.boss_phase === 2;
  const hit = resolveMonsterHit(s.monster.tier, alive.length, 0, bossPhase2, roll);
  const positionAdjusted = positionDamageMod(tickedActor.position, hit.final);
  const { newShield, newHp, shieldAbsorbed, hpDamage } = applyDamageWithShield(
    positionAdjusted,
    tickedActor.shield,
    tickedActor.hp,
  );

  events.push({
    type: "monster_attack",
    target: action.actor,
    raw_damage: hit.raw,
    damage_after_position: positionAdjusted,
    damage_after_armor: hit.final,
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
  let next: CombatState = { ...s, fighters: updatedFighters };
  if (allDown) {
    events.push({ type: "defeat" });
    return { state: { ...next, status: "defeat" }, events };
  }
  next = advanceTurn(next);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
}

// ── Class abilities ───────────────────────────────────────────────────────
//
// Single entry point: routes by ability_id to the per-class handler. Caller
// MUST send the correct ability_id for the actor's class — handlers don't
// re-validate class membership (the worker layer maps class → ability_id).

function handleAbility(
  state: CombatState,
  action: {
    kind: "ability";
    actor: ActorId;
    ability_id: AbilityId;
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
  const spec = ABILITIES[cls.id];
  if (!spec) return reject(state, `${fighter.class} has no active ability`);
  if (spec.id !== action.ability_id) {
    return reject(state, `${fighter.class}'s ability is ${spec.id}, not ${action.ability_id}`);
  }
  if (fighter.mana < spec.mana_cost) {
    return reject(state, `not enough mana (need ${spec.mana_cost})`);
  }

  const tick = tickAtTurnStart(state, action.actor);
  if (tick.earlyReturn) return tick.earlyReturn;
  const s = tick.state;
  const tickedActor = s.fighters.find((f) => f.id === action.actor)!;

  // Deduct mana up front; every sub-handler returns end-of-turn.
  const sPostMana: CombatState = {
    ...s,
    fighters: s.fighters.map((f) =>
      f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - spec.mana_cost) } : f,
    ),
  };

  const usedEvent: CombatEvent = {
    type: "ability_used",
    actor: action.actor,
    ability_id: spec.id,
    name: spec.name,
    mana_spent: spec.mana_cost,
  };
  const preEvents: CombatEvent[] = [...tick.events, usedEvent];

  switch (spec.id) {
    case "taunt":
      return abilityTaunt(sPostMana, action.actor, preEvents);
    case "containerize":
      return abilityContainerize(sPostMana, action.actor, preEvents);
    case "regression_shield":
      return abilityRegressionShield(sPostMana, action.actor, preEvents);
    case "vanish":
      return abilityVanish(sPostMana, action.actor, preEvents);
    case "soul_drain":
      return abilitySoulDrain(sPostMana, action.actor, tickedActor, preEvents, roll);
    case "battle_hymn":
      return abilityBattleHymn(sPostMana, action.actor, preEvents);
    case "foresee":
      return abilityForesee(sPostMana, action.actor, preEvents, roll);
    case "migrate":
      return abilityMigrate(sPostMana, action, preEvents);
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

function abilityContainerize(state: CombatState, _actor: ActorId, events: CombatEvent[]): StepResult {
  const prev = state.ability_state?.skip_swings ?? 0;
  const ability_state: AbilityRuntimeState = {
    ...(state.ability_state ?? {}),
    skip_swings: prev + 1,
  };
  const next = advanceTurn({ ...state, ability_state });
  return {
    state: next,
    events: [...events, { type: "ability_containerize", swings: 1 }, ...turnStartEvent(next)],
  };
}

function abilityRegressionShield(
  state: CombatState,
  actor: ActorId,
  events: CombatEvent[],
): StepResult {
  const SHIELD_AMOUNT = 3;
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
  events: CombatEvent[],
  roll: RollFn,
): StepResult {
  const d6 = roll(6);
  const rawDamage = d6 + tickedActor.magic_mod;
  // Cap at monster_hp - 1 so soul_drain never delivers the kill blow (matches
  // slack's pattern — keeps the engine's killed_by logic working off attacks).
  const damage = Math.min(rawDamage, Math.max(1, state.monster.hp - 1));
  const heal = Math.floor(damage / 2);
  const newMonsterHp = Math.max(0, state.monster.hp - damage);
  const oldHp = tickedActor.hp;
  const newHp = Math.min(tickedActor.max_hp, oldHp + heal);
  const applied = newHp - oldHp;

  const updatedFighters = state.fighters.map((f) =>
    f.id === actor ? { ...f, hp: newHp } : f,
  );

  const next = advanceTurn({
    ...state,
    fighters: updatedFighters,
    monster: { ...state.monster, hp: newMonsterHp },
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
  const CHARGES = 2;
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

function abilityForesee(
  state: CombatState,
  actor: ActorId,
  events: CombatEvent[],
  roll: RollFn,
): StepResult {
  // Predict who the monster will hit next: same picker it'll use on its
  // turn, honoring taunt/vanish. Info-only; we don't lock the actual pick.
  const aliveFighters = state.fighters.filter((f) => f.hp > 0);
  let predicted: ActorId | null = null;
  if (aliveFighters.length > 0) {
    const taunted = state.ability_state?.taunt;
    if (taunted && taunted.swings_remaining > 0) {
      const tauntTarget = aliveFighters.find((f) => f.id === taunted.actor_id);
      if (tauntTarget) predicted = tauntTarget.id;
    }
    if (!predicted) {
      const vanished = state.ability_state?.vanished ?? {};
      const eligible = aliveFighters.filter((f) => (vanished[f.id] ?? 0) <= 0);
      const pool = eligible.length > 0 ? eligible : aliveFighters;
      const pick = pickMonsterTarget(pool, () => roll(101) / 100);
      predicted = pick.id;
    }
  }
  const tier = state.monster.tier;
  const lo = 1 + tier;
  const hi = 6 + tier;
  const next = advanceTurn(state);
  return {
    state: next,
    events: [
      ...events,
      {
        type: "ability_foresee",
        actor,
        predicted_target: predicted,
        damage_lo: lo,
        damage_hi: hi,
      },
      ...turnStartEvent(next),
    ],
  };
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
// Called every time monster hp drops to 0. If the quest is a gauntlet with
// remaining waves, transitions to the next wave's monster (preserving turn
// order + initiative + the killer's credit) and continues combat. Otherwise
// emits victory. monster_down always fires either way so the UI gets the
// "killing blow" beat.
export function resolveMonsterKill(
  state: CombatState,
  killedBy: ActorId,
  precedingEvents: CombatEvent[],
): StepResult {
  const events: CombatEvent[] = [...precedingEvents];
  events.push({ type: "monster_down", killed_by: killedBy });

  const upcoming = state.monster.upcoming_waves ?? [];
  if (upcoming.length === 0) {
    events.push({ type: "victory" });
    return { state: { ...state, status: "victory" }, events };
  }

  const [next, ...rest] = upcoming;
  const newMonster: CombatMonster = {
    name: next.name,
    hp: next.max_hp,
    max_hp: next.max_hp,
    tier: state.monster.tier,
    initiative: state.monster.initiative,
    effects: [],
    is_boss: false,            // gauntlet waves are never boss-tier
    boss_phase: 1,
    wave: (state.monster.wave ?? 1) + 1,
    total_waves: state.monster.total_waves,
    upcoming_waves: rest,
  };
  events.push({
    type: "wave_transition",
    from_monster: state.monster.name,
    to_monster: next.name,
    to_max_hp: next.max_hp,
    new_wave: newMonster.wave!,
    total_waves: newMonster.total_waves ?? newMonster.wave!,
  });
  // Wave transition clears mark — the previous focus target is gone.
  const ability_state = stripField(state.ability_state, "mark");
  // Combat continues — advance turn from the killer to the next actor so
  // the new monster doesn't immediately get hit again by the same fighter.
  const advanced = advanceTurn({ ...state, monster: newMonster, ability_state });
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
  if (actorId === MONSTER_ID) {
    const tick = tickEffects(
      state.monster.hp,
      state.monster.max_hp,
      state.monster.effects,
      MONSTER_ID,
    );
    const newState: CombatState = {
      ...state,
      monster: {
        ...state.monster,
        hp: tick.newHp,
        effects: tick.newEffects,
      },
    };
    if (tick.newHp <= 0) {
      // Credit the kill to whoever applied the longest-running tick source,
      // falling back to the first alive fighter. Pure best-effort — used
      // for the UI's "killed by" banner and contribution count.
      const killerId =
        state.monster.effects.find((e) => e.source)?.source ??
        state.fighters.find((f) => f.hp > 0)?.id ??
        MONSTER_ID;
      // Credit the killing tick's damage to the source so the contribution
      // split on victory matches what actually happened.
      const tickDmg = state.monster.hp - tick.newHp;
      const contribution =
        killerId !== MONSTER_ID
          ? {
              ...state.contribution,
              [killerId]: (state.contribution[killerId] ?? 0) + tickDmg,
            }
          : state.contribution;
      // Defer victory vs wave transition to the shared resolver so
      // gauntlet quests keep going past a poison-kill.
      const withContribution: CombatState = { ...newState, contribution };
      const result = resolveMonsterKill(withContribution, killerId, tick.events);
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
  if (classIdOf(actor) !== "sre_warden") return { state, events: [] };
  if (isPassiveUsed(state, actor.id, PASSIVE_WARDEN_SHIELD)) return { state, events: [] };
  const cap = actor.max_hp * SHIELD_CAP_MULTIPLIER;
  const newShield = Math.min(cap, actor.shield + WARDEN_STARTING_SHIELD);
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

// Backend Druid — Database-Tree Communion. +1 HP at the start of every Druid
// action (always-on). Clamped to max_hp; emits nothing if already at full HP.
function applyDruidRegen(
  state: CombatState,
  actor: CombatFighter,
): { state: CombatState; events: CombatEvent[] } {
  if (classIdOf(actor) !== "backend_druid") return { state, events: [] };
  if (actor.hp <= 0) return { state, events: [] };
  const newHp = Math.min(actor.max_hp, actor.hp + DRUID_PASSIVE_REGEN);
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
  const finalFighter = druid.state.fighters.find((f) => f.id === actorId) ?? wardenFighter;
  return {
    state: druid.state,
    fighter: finalFighter,
    events: [...warden.events, ...druid.events],
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
  if (classIdOf(attacker) === "frontend_bard") return { bonus: 0, hymn_consumed: false };
  const bardAlive = state.fighters.some(
    (f) => f.hp > 0 && classIdOf(f) === "frontend_bard",
  );
  if (!bardAlive) return { bonus: 0, hymn_consumed: false };
  const hymnCharges = state.ability_state?.battle_hymn ?? 0;
  if (hymnCharges > 0) {
    return { bonus: BARD_AURA_HYMN_DAMAGE, hymn_consumed: true };
  }
  return { bonus: BARD_AURA_DAMAGE, hymn_consumed: false };
}

// Data Warlock — Cursed Strike. On a critical attack/cast, apply a 2-turn
// bleed to the monster. Always-on (no usage tracking).
function applyWarlockBleed(
  state: CombatState,
  actor: CombatFighter,
  isCrit: boolean,
): { state: CombatState; events: CombatEvent[] } {
  if (!isCrit || classIdOf(actor) !== "data_warlock") return { state, events: [] };
  if (state.monster.hp <= 0) return { state, events: [] };
  const newEffect: MachineStatusEffect = {
    type: "bleeding",
    magnitude: WARLOCK_BLEED_MAGNITUDE,
    remaining: WARLOCK_BLEED_DURATION,
    source: actor.id,
  };
  const updated: CombatState = {
    ...state,
    monster: {
      ...state.monster,
      effects: [...state.monster.effects, newEffect],
    },
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
      classIdOf(f) === "qa_paladin"
      && f.hp > 0
      && !isPassiveUsed(state, f.id, PASSIVE_PALADIN_AUTO_HEAL),
  );
  if (!paladin) return { state, events: [] };
  const newHp = Math.min(target.max_hp, target.hp + PALADIN_AUTO_HEAL_AMOUNT);
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
    { id: MONSTER_ID, init: state.monster.initiative },
  ];
  // Highest initiative first; ties broken by id for determinism.
  entries.sort((a, b) => (b.init - a.init) || a.id.localeCompare(b.id));
  return entries.map((e) => e.id);
}

// Advances turn_index past any downed fighters so the next live actor takes
// the turn. Increments round when wrapping.
function advanceTurn(state: CombatState): CombatState {
  if (state.turn_order.length === 0) return state;
  const total = state.turn_order.length;
  for (let i = 1; i <= total; i++) {
    const candidate = state.turn_index + i;
    const id = state.turn_order[candidate % total];
    if (id === MONSTER_ID) {
      return {
        ...state,
        turn_index: candidate,
        round: state.round + (candidate >= total && Math.floor(state.turn_index / total) < Math.floor(candidate / total) ? 1 : 0),
      };
    }
    const f = state.fighters.find((x) => x.id === id);
    if (f && f.hp > 0) {
      return {
        ...state,
        turn_index: candidate,
        round: state.round + (Math.floor(state.turn_index / total) < Math.floor(candidate / total) ? 1 : 0),
      };
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
