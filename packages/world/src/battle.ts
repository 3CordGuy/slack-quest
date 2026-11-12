// Line-up combat. Heroes on one side, enemies on the other, no grid.
// Pure: stepBattle(state, actor, action, rng) returns a new state and the
// events that happened. Enemy turns resolve immediately inside the same
// step, so the server never waits on a client to advance the fight.

import type { StatKey } from "@gantt-quest/core";
import { rollCheck, statPct, type CheckResult } from "./check";
import { ABILITIES, ARMOR_DAMAGE_DIVISOR, BARD_AURA, DRUID_REGEN, EFFECT_TICK, ENEMIES, WARLOCK_BLEED_TURNS, type AbilityDef, type EffectKind } from "./content";
import { afterArmor, type Outfit } from "./gear";
import type { Rng } from "./rng";

export interface ActiveEffect {
  kind: EffectKind;
  turns: number;
}

export interface Combatant {
  id: string;
  side: "hero" | "enemy";
  name: string;
  /** Class id for heroes, enemy kind for enemies. Drives the sprite. */
  kind: string;
  level: number;
  hp: number;
  maxHp: number;
  /** Per-roll success chance by stat. Heroes only. */
  pct: Partial<Record<StatKey, number>>;
  /** What a hero is visibly wearing, for drawing the sprite. */
  outfit?: Outfit;
  /** Added to this hero's ability damage. From the equipped weapon. */
  power: number;
  /** Blunts each enemy hit. From equipped armor. */
  armor: number;
  /** Initiative base, 0–100. */
  speed: number;
  focus: number;
  potions: number;
  abilities: string[];
  effects: ActiveEffect[];
  down: boolean;
}

export type BattleStatus = "active" | "victory" | "defeat" | "fled";

export interface BattleState {
  /** POI the fight is over, or null for a fight an NPC started. */
  poiId: string | null;
  combatants: Combatant[];
  /** Combatant ids in turn order. */
  order: string[];
  turn: number;
  round: number;
  status: BattleStatus;
  /** XP each hero earns on victory. */
  xp: number;
  boss: boolean;
}

export type BattleAction =
  | { type: "ability"; ability: string; target?: string; focus?: number }
  | { type: "potion" }
  | { type: "flee"; focus?: number };

export type BattleEvent =
  | { t: "turn"; id: string }
  | { t: "check"; actor: string; check: CheckResult }
  | { t: "hit"; actor: string; target: string; amount: number; ability: string; perfect: boolean }
  | { t: "miss"; actor: string; target: string; ability: string }
  | { t: "heal"; actor: string; target: string; amount: number; ability: string }
  | { t: "effect"; target: string; effect: EffectKind; turns: number }
  | { t: "tick"; target: string; effect: EffectKind; amount: number }
  | { t: "skip"; id: string; effect: EffectKind }
  | { t: "down"; id: string }
  | { t: "flee"; actor: string; ok: boolean }
  | { t: "end"; status: BattleStatus };

export const POTION_HEAL = 12;

export interface BattleSetup {
  heroes: Combatant[];
  enemyKinds: string[];
  /** Display name override for the boss, from the story bible. */
  bossName?: string;
  avgLevel: number;
  poiId: string | null;
}

/** Build enemies scaled to the party, roll initiative, and run any enemy turns that come first. */
export function createBattle(setup: BattleSetup, rng: Rng): { state: BattleState; events: BattleEvent[] } {
  const party = setup.heroes.length;
  const levelScale = 1 + 0.15 * Math.max(0, setup.avgLevel - 1);
  const enemies: Combatant[] = setup.enemyKinds.map((kind, i) => {
    const def = ENEMIES[kind];
    // Bosses grow with party size; rank-and-file get more bodies instead.
    const sizeScale = def.boss ? 0.75 + 0.25 * party : 1;
    const hp = Math.round(def.hp * levelScale * sizeScale);
    return {
      id: `e${i}`,
      side: "enemy",
      name: def.boss && setup.bossName ? setup.bossName : def.name,
      kind,
      level: Math.max(1, Math.round(setup.avgLevel)),
      hp,
      maxHp: hp,
      pct: {},
      power: 0,
      armor: 0,
      speed: def.speed,
      focus: 0,
      potions: 0,
      abilities: [],
      effects: [],
      down: false,
    };
  });
  // The Lighthouse Warden comes into every fight already guarded (see advance for how long it lasts).
  const combatants = [
    ...setup.heroes.map((h) => {
      const down = h.hp <= 0;
      const effects: ActiveEffect[] = h.kind === "sre_warden" && !down ? [{ kind: "guarded", turns: 1 }] : [];
      return { ...h, effects, down };
    }),
    ...enemies,
  ];
  const initiative = new Map(combatants.map((c) => [c.id, c.speed + rng.next() * 30]));
  const order = combatants.map((c) => c.id).sort((a, b) => initiative.get(b)! - initiative.get(a)!);
  const state: BattleState = {
    poiId: setup.poiId,
    combatants,
    order,
    turn: -1,
    round: 1,
    status: "active",
    xp: setup.enemyKinds.reduce((a, k) => a + ENEMIES[k].xp, 0),
    boss: setup.enemyKinds.some((k) => ENEMIES[k].boss),
  };
  const events: BattleEvent[] = [];
  advance(state, rng, events);
  return { state, events };
}

export function currentActor(state: BattleState): Combatant | undefined {
  return state.combatants.find((c) => c.id === state.order[state.turn]);
}

const find = (state: BattleState, id: string) => state.combatants.find((c) => c.id === id);
const living = (state: BattleState, side: "hero" | "enemy") =>
  state.combatants.filter((c) => c.side === side && !c.down);

function addEffect(target: Combatant, effect: EffectKind, turns: number, events: BattleEvent[]) {
  const existing = target.effects.find((e) => e.kind === effect);
  if (existing) existing.turns = Math.max(existing.turns, turns);
  else target.effects.push({ kind: effect, turns });
  events.push({ t: "effect", target: target.id, effect, turns });
}

/** Apply damage. `direct` hits are blunted by armor; bleeding and burning are not. */
function damage(state: BattleState, target: Combatant, raw: number, events: BattleEvent[], direct = true): number {
  const guarded = target.effects.some((e) => e.kind === "guarded");
  const blunted = direct ? afterArmor(raw, target.armor) : raw;
  const amount = Math.max(0, guarded ? Math.ceil(blunted / 2) : blunted);
  target.hp = Math.max(0, target.hp - amount);
  if (target.hp === 0 && !target.down) {
    target.down = true;
    target.effects = [];
    events.push({ t: "down", id: target.id });
  }
  settle(state);
  return amount;
}

function settle(state: BattleState) {
  if (state.status !== "active") return;
  if (living(state, "enemy").length === 0) state.status = "victory";
  else if (living(state, "hero").length === 0) state.status = "defeat";
}

/** Move to the next combatant, resolving start-of-turn effects and enemy turns, until a hero must choose. */
function advance(state: BattleState, rng: Rng, events: BattleEvent[]) {
  // Bounded: a full round with everyone stunned still terminates.
  for (let guard = 0; guard < 200 && state.status === "active"; guard++) {
    state.turn += 1;
    if (state.turn >= state.order.length) {
      state.turn = 0;
      state.round += 1;
    }
    const actor = currentActor(state)!;
    if (actor.down) continue;

    // Guard and taunt last until the start of the combatant's next turn. The
    // Lighthouse Warden's opening guard holds through its first turn, to its second.
    const keepGuard = actor.kind === "sre_warden" && actor.side === "hero" && state.round === 1;
    actor.effects = actor.effects.filter((e) => e.kind !== "taunting" && (keepGuard || e.kind !== "guarded"));
    for (const e of [...actor.effects]) {
      const tick = EFFECT_TICK[e.kind];
      if (tick) {
        const amount = damage(state, actor, tick, events, false);
        events.push({ t: "tick", target: actor.id, effect: e.kind, amount });
        e.turns -= 1;
      }
    }
    actor.effects = actor.effects.filter((e) => e.turns > 0 || e.kind === "stunned");
    if (state.status !== "active") break;
    if (actor.down) continue;

    // The Reef Druid grows back a little at the start of each of its turns, stunned or not.
    if (actor.side === "hero" && actor.kind === "backend_druid" && actor.hp < actor.maxHp) {
      const amount = Math.min(actor.maxHp - actor.hp, DRUID_REGEN);
      actor.hp += amount;
      events.push({ t: "heal", actor: actor.id, target: actor.id, amount, ability: "Deep Roots" });
    }

    const stun = actor.effects.find((e) => e.kind === "stunned");
    if (stun) {
      actor.effects = actor.effects.filter((e) => e !== stun);
      events.push({ t: "skip", id: actor.id, effect: "stunned" });
      continue;
    }

    events.push({ t: "turn", id: actor.id });
    if (actor.side === "hero") return;
    enemyTurn(state, actor, rng, events);
  }
  if (state.status !== "active") events.push({ t: "end", status: state.status });
}

function enemyTurn(state: BattleState, actor: Combatant, rng: Rng, events: BattleEvent[]) {
  const def = ENEMIES[actor.kind];
  const total = def.attacks.reduce((a, k) => a + k.weight, 0);
  let r = rng.next() * total;
  let attack = def.attacks[0];
  for (const a of def.attacks) {
    r -= a.weight;
    if (r <= 0) {
      attack = a;
      break;
    }
  }
  const heroes = living(state, "hero");
  // A taunting hero draws every single-target attack onto itself.
  const taunting = heroes.filter((h) => h.effects.some((e) => e.kind === "taunting"));
  const targets = attack.target === "all_heroes" ? heroes : [rng.pick(taunting.length > 0 ? taunting : heroes)];
  const check = rollCheck(rng, { label: attack.name, pct: attack.pct, count: attack.rolls });
  events.push({ t: "check", actor: actor.id, check });
  const scaled = Math.round(((attack.damage + Math.floor(actor.level / 2)) * check.successes) / attack.rolls);
  for (const target of targets) {
    if (state.status !== "active") break;
    if (check.fumble) {
      events.push({ t: "miss", actor: actor.id, target: target.id, ability: attack.name });
      continue;
    }
    const amount = damage(state, target, scaled, events);
    events.push({ t: "hit", actor: actor.id, target: target.id, amount, ability: attack.name, perfect: check.perfect });
    if (check.perfect && attack.perfect && !target.down) {
      addEffect(target, attack.perfect.effect, attack.perfect.turns, events);
    }
  }
}

function resolveAbility(
  state: BattleState,
  actor: Combatant,
  def: AbilityDef,
  targetId: string | undefined,
  focus: number,
  rng: Rng,
  events: BattleEvent[],
): string | null {
  let targets: Combatant[];
  if (def.target === "self") targets = [actor];
  else if (def.target === "all_enemies") targets = living(state, "enemy");
  else {
    const side = def.target === "enemy" ? "enemy" : "hero";
    const t = targetId ? find(state, targetId) : living(state, side)[0];
    if (!t || t.side !== side || t.down) return "invalid target";
    targets = [t];
  }
  actor.focus -= focus;
  const check = rollCheck(rng, {
    label: def.name,
    stat: def.stat,
    pct: actor.pct[def.stat] ?? statPct(5),
    count: def.rolls,
    focus,
  });
  events.push({ t: "check", actor: actor.id, check });
  const scale = check.successes / def.rolls;
  // While a Shanty Bard stands, every other hero hits a little harder.
  const aura = actor.side === "hero" && actor.kind !== "frontend_bard" && living(state, "hero").some((h) => h.kind === "frontend_bard") ? BARD_AURA : 0;

  for (const target of targets) {
    if (def.damage !== undefined) {
      if (check.fumble) {
        events.push({ t: "miss", actor: actor.id, target: target.id, ability: def.name });
        continue;
      }
      // Bulwark Strike leans on the Warden's armor; Hex on the size of its target.
      const armorBonus = def.armorDamage ? Math.floor(actor.armor / ARMOR_DAMAGE_DIVISOR) : 0;
      const sizeBonus = def.maxHpDamage ? Math.round(target.maxHp * def.maxHpDamage) : 0;
      const amount = damage(state, target, Math.round((def.damage + actor.level + actor.power + aura + armorBonus + sizeBonus) * scale), events);
      events.push({ t: "hit", actor: actor.id, target: target.id, amount, ability: def.name, perfect: check.perfect });
      if (check.perfect && def.perfect && !target.down) addEffect(target, def.perfect.effect, def.perfect.turns, events);
      // The Wreck Warlock's perfect hits leave the target bleeding.
      if (check.perfect && actor.side === "hero" && actor.kind === "data_warlock" && !target.down) addEffect(target, "bleeding", WARLOCK_BLEED_TURNS, events);
      if (def.drain && amount > 0 && !actor.down && actor.hp < actor.maxHp) {
        const healed = Math.min(actor.maxHp - actor.hp, Math.max(1, Math.round(amount * def.drain)));
        actor.hp += healed;
        events.push({ t: "heal", actor: actor.id, target: actor.id, amount: healed, ability: def.name });
      }
    }
    if (def.heal !== undefined && !check.fumble) {
      const amount = Math.min(target.maxHp - target.hp, Math.round((def.heal + actor.level) * scale));
      target.hp += amount;
      events.push({ t: "heal", actor: actor.id, target: target.id, amount, ability: def.name });
    }
  }
  if (def.selfEffect && !check.fumble) addEffect(actor, def.selfEffect.effect, def.selfEffect.turns, events);
  return null;
}

export type BattleStep = { ok: true; state: BattleState; events: BattleEvent[] } | { ok: false; error: string };

export function stepBattle(prev: BattleState, actorId: string, action: BattleAction, rng: Rng): BattleStep {
  if (prev.status !== "active") return { ok: false, error: "battle is over" };
  const state = structuredClone(prev);
  const actor = currentActor(state);
  if (!actor || actor.id !== actorId || actor.side !== "hero") return { ok: false, error: "not your turn" };
  const events: BattleEvent[] = [];

  if (action.type === "ability") {
    const def = ABILITIES[action.ability];
    if (!def || !actor.abilities.includes(def.id)) return { ok: false, error: "unknown ability" };
    const focus = Math.max(0, Math.floor(action.focus ?? 0));
    if (focus > actor.focus || focus > def.rolls) return { ok: false, error: "not enough focus" };
    const err = resolveAbility(state, actor, def, action.target, focus, rng, events);
    if (err) return { ok: false, error: err };
  } else if (action.type === "potion") {
    if (actor.potions <= 0) return { ok: false, error: "no potions" };
    actor.potions -= 1;
    const amount = Math.min(actor.maxHp - actor.hp, POTION_HEAL);
    actor.hp += amount;
    events.push({ t: "heal", actor: actor.id, target: actor.id, amount, ability: "Potion" });
  } else if (action.type === "flee") {
    if (state.boss) return { ok: false, error: "there is no running from this fight" };
    const focus = Math.max(0, Math.floor(action.focus ?? 0));
    if (focus > actor.focus || focus > 2) return { ok: false, error: "not enough focus" };
    actor.focus -= focus;
    const check = rollCheck(rng, { label: "Flee", stat: "agi", pct: actor.pct.agi ?? statPct(5), count: 2, focus });
    events.push({ t: "check", actor: actor.id, check });
    events.push({ t: "flee", actor: actor.id, ok: !check.fumble });
    if (!check.fumble) {
      state.status = "fled";
      events.push({ t: "end", status: "fled" });
      return { ok: true, state, events };
    }
  } else {
    return { ok: false, error: "unknown action" };
  }

  if (state.status === "active") advance(state, rng, events);
  else events.push({ t: "end", status: state.status });
  return { ok: true, state, events };
}
