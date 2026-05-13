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
import { SHIELD_CAP_MULTIPLIER, classByName, type EffectType } from "./flavor";

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
  weapon_power: number;
  armor_power: number;
  initiative: number;      // rolled at begin
  effects: MachineStatusEffect[];
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
}

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
  | { kind: "wait"; actor: ActorId }
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
export interface CombatInit {
  fighters: Omit<CombatFighter, "initiative" | "effects">[];
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
    case "wait":
      return handleWait(state, action);
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

  const events: CombatEvent[] = [];
  const classMod = action.kind === "cast" ? fighter.magic_mod : fighter.attack_mod;

  // ── d20 to-hit ──
  const d20 = roll(20);
  const ac = monsterAc(state.monster.tier);
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
    const next = advanceTurn(state);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // ── damage roll on hit ──
  const hit = resolvePlayerHit(action.kind, classMod, fighter.weapon_power, roll);
  events.push({
    type: "roll",
    actor: action.actor,
    die: action.kind === "cast" ? "d8" : "d6",
    value: hit.roll,
    purpose: action.kind === "cast" ? "damage_cast" : "damage_attack",
  });

  const oldHp = state.monster.hp;
  const newHp = Math.max(0, oldHp - hit.damage);
  const monsterKilled = newHp <= 0;
  const phaseTransition =
    state.monster.is_boss &&
    state.monster.boss_phase === 1 &&
    isBossPhaseTransition(state.monster.max_hp, oldHp, newHp);

  events.push({
    type: "player_hit",
    actor: action.actor,
    target: MONSTER_ID,
    damage: hit.damage,
    crit: hit.isCrit,
    formula: `${hit.roll}+${hit.totalMod}${hit.isCrit ? " ×2" : ""}`,
  });

  let nextState: CombatState = {
    ...state,
    monster: {
      ...state.monster,
      hp: newHp,
      ...(phaseTransition ? { boss_phase: 2 as const } : {}),
    },
    contribution: {
      ...state.contribution,
      [action.actor]: (state.contribution[action.actor] ?? 0) + hit.damage,
    },
  };

  if (phaseTransition) {
    events.push({ type: "boss_phase_transition", new_phase: 2 });
  }

  if (monsterKilled) {
    events.push({ type: "monster_down", killed_by: action.actor });
    events.push({ type: "victory" });
    return { state: { ...nextState, status: "victory" }, events };
  }

  return { state: advanceTurn(nextState), events: [...events, ...turnStartEvent(nextState)] };
}

function handleWait(
  state: CombatState,
  action: { kind: "wait"; actor: ActorId },
): StepResult {
  if (currentActor(state) !== action.actor) {
    return reject(state, `not ${action.actor}'s turn`);
  }
  const next = advanceTurn(state);
  return { state: next, events: turnStartEvent(next) };
}

function handleMonsterAct(state: CombatState, roll: RollFn): StepResult {
  if (currentActor(state) !== MONSTER_ID) {
    return reject(state, "not the monster's turn");
  }

  const events: CombatEvent[] = [];
  const aliveFighters = state.fighters.filter((f) => f.hp > 0);
  if (aliveFighters.length === 0) {
    // Should be unreachable — defeat is checked after each fighter falls.
    return { state: { ...state, status: "defeat" }, events: [{ type: "defeat" }] };
  }

  const target = pickMonsterTarget(aliveFighters, () => roll(101) / 100);

  // ── d20 to-hit ──
  const d20 = roll(20);
  const modifier = state.monster.tier;
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
    const next = advanceTurn(state);
    return { state: next, events: [...events, ...turnStartEvent(next)] };
  }

  // ── damage roll on hit ──
  const totalArmor = target.armor_power;
  const bossPhase2 = state.monster.is_boss && state.monster.boss_phase === 2;
  const hit = resolveMonsterHit(
    state.monster.tier,
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
    value: hit.raw - state.monster.tier - Math.floor((aliveFighters.length - 1) / 2) - (bossPhase2 ? state.monster.tier : 0),
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

  const updatedFighters = state.fighters.map((f) =>
    f.id === target.id ? { ...f, shield: newShield, hp: Math.max(0, newHp) } : f,
  );
  const targetDowned = newHp <= 0 && target.hp > 0;
  if (targetDowned) {
    events.push({ type: "fighter_down", target: target.id });
  }

  const allDown = updatedFighters.every((f) => f.hp <= 0);
  let next: CombatState = { ...state, fighters: updatedFighters };
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
  const target = state.fighters.find((f) => f.id === action.target);
  if (!target) return reject(state, `unknown heal target: ${action.target}`);
  if (target.hp <= 0) return reject(state, `cannot heal a downed target`);

  const { amount: rolled, roll: rollValue } = resolveHeal(actor.magic_mod, roll);
  const newHp = Math.min(target.max_hp, target.hp + rolled);
  const applied = newHp - target.hp;

  const events: CombatEvent[] = [
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
    ...state,
    fighters: state.fighters.map((f) =>
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
  const target = state.fighters.find((f) => f.id === action.target);
  if (!target) return reject(state, `unknown shield target: ${action.target}`);
  if (target.hp <= 0) return reject(state, `cannot shield a downed target`);

  const { amount: rolled, roll: rollValue } = resolveShield(actor.magic_mod, roll);
  const cap = target.max_hp * SHIELD_CAP_MULTIPLIER;
  const newShield = Math.min(cap, target.shield + rolled);
  const applied = newShield - target.shield;

  const events: CombatEvent[] = [
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
    ...state,
    fighters: state.fighters.map((f) =>
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
  if (actor.mana < 1) return reject(state, `${action.actor} has no mana for signature`);

  const cls = classByName(actor.class);
  const partySize = state.fighters.filter((f) => f.hp > 0).length;
  const sig = resolveSignature(
    cls.id,
    actor.attack_mod,
    actor.magic_mod,
    actor.weapon_power,
    state.monster.tier,
    partySize,
    state.monster.max_hp,
    roll,
  );

  const oldHp = state.monster.hp;
  const newHp = Math.max(0, oldHp - sig.damage);
  const monsterKilled = newHp <= 0;
  const phaseTransition =
    state.monster.is_boss &&
    state.monster.boss_phase === 1 &&
    isBossPhaseTransition(state.monster.max_hp, oldHp, newHp);

  const events: CombatEvent[] = [
    {
      type: "signature_used",
      actor: action.actor,
      damage: sig.damage,
      formula: sig.formula,
      mana_spent: 1,
    },
  ];

  let nextState: CombatState = {
    ...state,
    fighters: state.fighters.map((f) =>
      f.id === action.actor ? { ...f, mana: Math.max(0, f.mana - 1) } : f,
    ),
    monster: {
      ...state.monster,
      hp: newHp,
      ...(phaseTransition ? { boss_phase: 2 as const } : {}),
    },
    contribution: {
      ...state.contribution,
      [action.actor]: (state.contribution[action.actor] ?? 0) + sig.damage,
    },
  };

  if (phaseTransition) {
    events.push({ type: "boss_phase_transition", new_phase: 2 });
  }
  if (monsterKilled) {
    events.push({ type: "monster_down", killed_by: action.actor });
    events.push({ type: "victory" });
    return { state: { ...nextState, status: "victory" }, events };
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

  // d20 + max(atk, mag) vs DC = 10 + monster.tier. Flexible — fighter-y
  // classes get atk, caster-y classes get mag; nobody is locked out.
  const d20 = roll(20);
  const modifier = Math.max(actor.attack_mod, actor.magic_mod);
  const dc = 10 + state.monster.tier;
  const total = d20 + modifier;
  const success = total >= dc;

  const events: CombatEvent[] = [
    { type: "roll", actor: action.actor, die: "d20", value: d20, purpose: "flee_check" },
    { type: "flee_check", actor: action.actor, roll: d20, modifier, total, dc, success },
  ];

  if (success) {
    events.push({ type: "fled" });
    return { state: { ...state, status: "fled" }, events };
  }

  // Failed flee: free hit from the monster. No d20 to hit (you're exposed),
  // no armor mitigation (back turned). Damage = resolveMonsterHit's normal
  // damage roll, applied through shield/HP.
  const alive = state.fighters.filter((f) => f.hp > 0);
  const bossPhase2 = state.monster.is_boss && state.monster.boss_phase === 2;
  const hit = resolveMonsterHit(state.monster.tier, alive.length, 0, bossPhase2, roll);
  const positionAdjusted = positionDamageMod(actor.position, hit.final);
  const { newShield, newHp, shieldAbsorbed, hpDamage } = applyDamageWithShield(
    positionAdjusted,
    actor.shield,
    actor.hp,
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

  const updatedFighters = state.fighters.map((f) =>
    f.id === action.actor ? { ...f, hp: Math.max(0, newHp), shield: newShield } : f,
  );
  if (newHp <= 0 && actor.hp > 0) {
    events.push({ type: "fighter_down", target: action.actor });
  }
  const allDown = updatedFighters.every((f) => f.hp <= 0);
  let next: CombatState = { ...state, fighters: updatedFighters };
  if (allDown) {
    events.push({ type: "defeat" });
    return { state: { ...next, status: "defeat" }, events };
  }
  next = advanceTurn(next);
  return { state: next, events: [...events, ...turnStartEvent(next)] };
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
