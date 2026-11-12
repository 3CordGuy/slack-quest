// Line-up combat. Heroes on one side, enemies on the other, no grid.
// Pure: stepBattle(state, actor, action, rng) returns a new state and the
// events that happened. Enemy turns resolve immediately inside the same
// step, so the server never waits on a client to advance the fight.
//
// Turns run on a speed timeline, For the King style: every combatant has a
// clock time for its next turn, and after acting it waits a delay that
// shrinks with speed, so fast things act more often than slow ones. Enemies
// pick their next move (their intent) as soon as their turn is scheduled,
// and the heroes can see it coming.

import type { StatKey } from "@gantt-quest/core";
import { rollCheck, statPct, type CheckResult } from "./check";
import {
  ABILITIES,
  ARMOR_DAMAGE_DIVISOR,
  BARD_AURA,
  DRUID_REGEN,
  EFFECT_TICK,
  ENEMIES,
  EXPOSED_BONUS,
  HASTE_FACTOR,
  SLOW_FACTOR,
  WARLOCK_BLEED_TURNS,
  type AbilityDef,
  type EffectKind,
} from "./content";
import { afterArmor, type Outfit } from "./gear";
import type { Rng } from "./rng";
import { DEBUFFS, TRAIT_BY_ID, type TraitRule } from "./traits";

export interface ActiveEffect {
  kind: EffectKind;
  turns: number;
}

/** What an enemy will do on its next turn. Chosen when that turn is scheduled. */
export interface Intent {
  /** Index into ENEMIES[kind].attacks. */
  attack: number;
  /** The hero it means to hit, or null for an attack on every hero. */
  target: string | null;
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
  /** 0–100. Sets how often this combatant acts (see turnDelay). */
  speed: number;
  focus: number;
  potions: number;
  abilities: string[];
  effects: ActiveEffect[];
  down: boolean;
  /** Timeline clock of this combatant's next turn. Set by createBattle. */
  next?: number;
  /** Turns this combatant has started in this fight. */
  turns?: number;
  /** Enemies only: the move it will make on its next turn. */
  intent?: Intent | null;
  /** Heroes only: the class traits they picked (traits.ts). */
  traits?: string[];
  /** Once-a-fight traits already used up this fight, by trait id. */
  spent?: string[];
}

export type BattleStatus = "active" | "victory" | "defeat" | "fled";

export interface BattleState {
  /** POI the fight is over, or null for a fight an NPC started. */
  poiId: string | null;
  combatants: Combatant[];
  /** Whose turn it is. */
  actor: string | null;
  /** Timeline clock: the `next` of the current actor when its turn began. */
  clock: number;
  /** Turns started so far, by anyone. Keys the turn timer. */
  turnNo: number;
  /** The acting hero has used its one free item action this turn. */
  itemUsed: boolean;
  status: BattleStatus;
  /** XP each hero earns on victory. */
  xp: number;
  boss: boolean;
}

export type BattleAction =
  | { type: "ability"; ability: string; target?: string; focus?: number }
  /** Free: does not end the turn, once per turn. `target` is a standing ally; yourself by default. */
  | { type: "potion"; target?: string }
  | { type: "flee"; focus?: number };

export type BattleEvent =
  | { t: "turn"; id: string }
  | { t: "intent"; id: string; intent: Intent }
  | { t: "check"; actor: string; check: CheckResult }
  | { t: "hit"; actor: string; target: string; amount: number; ability: string; perfect: boolean }
  /** A failed attack, or (`heal`) a heal that failed every roll. */
  | { t: "miss"; actor: string; target: string; ability: string; heal?: boolean }
  | { t: "heal"; actor: string; target: string; amount: number; ability: string }
  | { t: "effect"; target: string; effect: EffectKind; turns: number }
  | { t: "tick"; target: string; effect: EffectKind; amount: number }
  | { t: "skip"; id: string; effect: EffectKind }
  | { t: "down"; id: string }
  | { t: "flee"; actor: string; ok: boolean }
  | { t: "end"; status: BattleStatus }
  /** A class trait kicked in. */
  | { t: "trait"; id: string; trait: string };

export const POTION_HEAL = 12;

/** Clock ticks between turns at speed 0 is TURN_TICKS / TURN_SPEED_BASE; speed 75 waits about 10, speed 30 about 17. */
export const TURN_TICKS = 1200;
export const TURN_SPEED_BASE = 40;

/** Clock ticks a combatant waits between turns, before haste or slow. */
export function turnDelay(c: Pick<Combatant, "speed">): number {
  return TURN_TICKS / (TURN_SPEED_BASE + Math.max(0, c.speed));
}

export interface BattleSetup {
  heroes: Combatant[];
  enemyKinds: string[];
  /** Display name override for the boss, from the story bible. */
  bossName?: string;
  avgLevel: number;
  poiId: string | null;
}

/** Build enemies scaled to the party, place everyone on the timeline, and run any enemy turns that come first. */
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
  const combatants: Combatant[] = [
    ...setup.heroes.map((h) => {
      const down = h.hp <= 0;
      const effects: ActiveEffect[] = h.kind === "sre_warden" && !down ? [{ kind: "guarded", turns: 1 }] : [];
      return { ...h, effects, down, intent: undefined };
    }),
    ...enemies,
  ];
  // Everyone's first turn lands somewhere in their first wait, so the quick usually go first but not always.
  for (const c of combatants) {
    c.next = turnDelay(c) * (0.25 + 0.75 * rng.next());
    c.turns = 0;
  }
  const state: BattleState = {
    poiId: setup.poiId,
    combatants,
    actor: null,
    clock: 0,
    turnNo: 0,
    itemUsed: false,
    status: "active",
    xp: setup.enemyKinds.reduce((a, k) => a + ENEMIES[k].xp, 0),
    boss: setup.enemyKinds.some((k) => ENEMIES[k].boss),
  };
  const events: BattleEvent[] = [];
  for (const e of enemies) chooseIntent(state, e, rng, events);
  for (const h of combatants.filter((c) => c.side === "hero" && !c.down)) {
    for (const { id, rule } of rulesOf(h, "start_effect")) {
      addEffect(state, h, rule.effect, rule.turns, events);
      events.push({ t: "trait", id: h.id, trait: id });
    }
  }
  advance(state, rng, events);
  return { state, events };
}

export function currentActor(state: BattleState): Combatant | undefined {
  return state.combatants.find((c) => c.id === state.actor);
}

const find = (state: BattleState, id: string) => state.combatants.find((c) => c.id === id);
const living = (state: BattleState, side: "hero" | "enemy") =>
  state.combatants.filter((c) => c.side === side && !c.down);
const hasEffect = (c: Combatant, kind: EffectKind) => c.effects.some((e) => e.kind === kind);

/** A combatant's trait rules of one kind, with the trait each came from. */
function rulesOf<K extends TraitRule["t"]>(c: Combatant, kind: K): { id: string; rule: Extract<TraitRule, { t: K }> }[] {
  if (c.side !== "hero" || !c.traits) return [];
  return c.traits
    .filter((id) => TRAIT_BY_ID[id]?.rule.t === kind)
    .map((id) => ({ id, rule: TRAIT_BY_ID[id].rule as Extract<TraitRule, { t: K }> }));
}

/** Different debuffs on a combatant right now. */
const debuffCount = (c: Combatant) => c.effects.filter((e) => DEBUFFS.includes(e.kind)).length;

/** Who acts next: the lowest clock, then the faster, then the earlier in the line-up. */
function nextUp(state: BattleState): Combatant | undefined {
  let best: Combatant | undefined;
  for (const c of state.combatants) {
    if (c.down) continue;
    if (!best) best = c;
    else if ((c.next ?? 0) < (best.next ?? 0) - 1e-9) best = c;
    else if (Math.abs((c.next ?? 0) - (best.next ?? 0)) <= 1e-9 && c.speed > best.speed) best = c;
  }
  return best;
}

/** One wait's multiplier from haste or slow. Spends one turn of the effect when `spend` is set. */
function tempo(c: Combatant, spend: boolean): number {
  let mult = 1;
  for (const kind of ["hasted", "slowed"] as const) {
    const e = c.effects.find((x) => x.kind === kind);
    if (!e) continue;
    mult *= kind === "hasted" ? HASTE_FACTOR : SLOW_FACTOR;
    if (spend) e.turns -= 1;
  }
  if (spend) c.effects = c.effects.filter((e) => !((e.kind === "hasted" || e.kind === "slowed") && e.turns <= 0));
  return mult;
}

/** End a combatant's turn: put its next one on the timeline and, for an enemy, pick what it will do. */
function endTurn(state: BattleState, c: Combatant, rng: Rng, events: BattleEvent[]) {
  c.next = state.clock + turnDelay(c) * tempo(c, true);
  if (c.side === "enemy" && !c.down) chooseIntent(state, c, rng, events);
}

function chooseIntent(state: BattleState, c: Combatant, rng: Rng, events: BattleEvent[]) {
  const def = ENEMIES[c.kind];
  const total = def.attacks.reduce((a, k) => a + k.weight, 0);
  let r = rng.next() * total;
  let attack = 0;
  for (const [i, a] of def.attacks.entries()) {
    r -= a.weight;
    if (r <= 0) {
      attack = i;
      break;
    }
  }
  const heroes = living(state, "hero");
  const target = def.attacks[attack].target === "all_heroes" || heroes.length === 0 ? null : rng.pick(heroes).id;
  c.intent = { attack, target };
  events.push({ t: "intent", id: c.id, intent: c.intent });
}

function addEffect(state: BattleState, target: Combatant, effect: EffectKind, turns: number, events: BattleEvent[], by?: Combatant) {
  // Some traits make the effects their hero causes last longer.
  if (by) for (const { rule } of rulesOf(by, "longer")) if (rule.effects.includes(effect)) turns += rule.turns;
  const existing = target.effects.find((e) => e.kind === effect);
  if (existing) existing.turns = Math.max(existing.turns, turns);
  else target.effects.push({ kind: effect, turns });
  events.push({ t: "effect", target: target.id, effect, turns });
  // Haste and slow move a turn that is already waiting, and that counts as one of their turns.
  // The current actor's next turn isn't placed yet; endTurn applies the effect to it.
  if ((effect === "hasted" || effect === "slowed") && target.id !== state.actor && !target.down) {
    const base = turnDelay(target);
    const shift = effect === "hasted" ? base * (HASTE_FACTOR - 1) : base * (SLOW_FACTOR - 1);
    target.next = Math.max(state.clock, (target.next ?? state.clock) + shift);
    const applied = target.effects.find((e) => e.kind === effect)!;
    applied.turns -= 1;
    if (applied.turns <= 0) target.effects = target.effects.filter((e) => e !== applied);
  }
}

/**
 * Apply damage. `direct` hits are blunted by armor; bleeding and burning are not.
 * `cause` is the event saying what did it (the hit, the tick): it is logged
 * first, so a "goes down" always comes after the blow that caused it.
 * `ignoreGuard` hits go straight through Guarded.
 */
function damage(state: BattleState, target: Combatant, raw: number, events: BattleEvent[], direct: boolean, cause: (amount: number) => BattleEvent, ignoreGuard = false): number {
  const guarded = !ignoreGuard && hasEffect(target, "guarded");
  const exposed = direct && hasEffect(target, "exposed") ? EXPOSED_BONUS : 0;
  const blunted = direct ? afterArmor(raw + exposed, target.armor) : raw;
  const amount = Math.max(0, guarded ? Math.ceil(blunted / 2) : blunted);
  target.hp = Math.max(0, target.hp - amount);
  events.push(cause(amount));
  // A once-a-fight trait can keep a hero up on 1 HP.
  if (target.hp === 0 && !target.down) {
    const stand = rulesOf(target, "last_stand").find(({ id }) => !(target.spent ?? []).includes(id));
    if (stand) {
      target.hp = 1;
      (target.spent ??= []).push(stand.id);
      events.push({ t: "trait", id: target.id, trait: stand.id });
    }
  }
  if (target.hp === 0 && !target.down) {
    target.down = true;
    target.effects = [];
    target.intent = null;
    events.push({ t: "down", id: target.id });
    // Some heroes take heart (and HP) from every enemy that falls.
    if (target.side === "enemy") {
      for (const h of living(state, "hero")) {
        for (const { id, rule } of rulesOf(h, "on_kill_heal")) {
          const healed = Math.min(h.maxHp - h.hp, rule.amount);
          if (healed <= 0) continue;
          h.hp += healed;
          events.push({ t: "heal", actor: h.id, target: h.id, amount: healed, ability: TRAIT_BY_ID[id].name });
        }
      }
    }
  }
  settle(state);
  return amount;
}

function settle(state: BattleState) {
  if (state.status !== "active") return;
  if (living(state, "enemy").length === 0) state.status = "victory";
  else if (living(state, "hero").length === 0) state.status = "defeat";
}

/** A check made while glitched: one roll fails whatever happens, and the glitch is spent. */
function glitchable(actor: Combatant, opts: Parameters<typeof rollCheck>[1], rng: Rng): CheckResult {
  const glitch = actor.effects.find((e) => e.kind === "glitched");
  if (!glitch) return rollCheck(rng, opts);
  actor.effects = actor.effects.filter((e) => e !== glitch);
  const count = Math.max(1, Math.floor(opts.count));
  const rest = count > 1 ? rollCheck(rng, { ...opts, count: count - 1, focus: Math.min(opts.focus ?? 0, count - 1) }).rolls : [];
  const rolls = [...rest, false];
  const successes = rolls.filter(Boolean).length;
  return {
    label: `${opts.label} (fouled)`,
    stat: opts.stat ?? null,
    pct: opts.pct,
    rolls,
    focus: Math.min(opts.focus ?? 0, count - 1),
    successes,
    perfect: false,
    fumble: successes === 0,
  };
}

/** Move to the next combatant, resolving start-of-turn effects and enemy turns, until a hero must choose. */
function advance(state: BattleState, rng: Rng, events: BattleEvent[]) {
  // Bounded: a long run of stunned turns still terminates.
  for (let guard = 0; guard < 400 && state.status === "active"; guard++) {
    const actor = nextUp(state);
    if (!actor) break;
    state.clock = actor.next ?? state.clock;
    state.actor = actor.id;
    state.turnNo += 1;
    state.itemUsed = false;
    const firstTurn = (actor.turns ?? 0) === 0;
    actor.turns = (actor.turns ?? 0) + 1;

    // Guard and taunt last until the start of the combatant's next turn. The
    // Lighthouse Warden's opening guard holds through its first turn, to its second.
    const keepGuard = actor.kind === "sre_warden" && actor.side === "hero" && firstTurn;
    actor.effects = actor.effects.filter((e) => e.kind !== "taunting" && (keepGuard || e.kind !== "guarded"));
    for (const e of [...actor.effects]) {
      const tick = EFFECT_TICK[e.kind];
      if (tick) {
        damage(state, actor, tick, events, false, (amount) => ({ t: "tick", target: actor.id, effect: e.kind, amount }));
        e.turns -= 1;
      } else if (e.kind === "exposed") {
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
    for (const { id, rule } of rulesOf(actor, "regen")) {
      const amount = Math.min(actor.maxHp - actor.hp, rule.amount);
      if (amount <= 0) continue;
      actor.hp += amount;
      events.push({ t: "heal", actor: actor.id, target: actor.id, amount, ability: TRAIT_BY_ID[id].name });
    }
    for (const { id } of rulesOf(actor, "low_hp_guard")) {
      if (actor.hp * 3 >= actor.maxHp || hasEffect(actor, "guarded")) continue;
      addEffect(state, actor, "guarded", 1, events);
      events.push({ t: "trait", id: actor.id, trait: id });
    }

    const stun = actor.effects.find((e) => e.kind === "stunned");
    if (stun) {
      actor.effects = actor.effects.filter((e) => e !== stun);
      events.push({ t: "skip", id: actor.id, effect: "stunned" });
      // A stunned enemy loses the move it was winding up and picks a new one.
      endTurn(state, actor, rng, events);
      continue;
    }

    events.push({ t: "turn", id: actor.id });
    if (actor.side === "hero") return;
    enemyTurn(state, actor, rng, events);
    endTurn(state, actor, rng, events);
  }
  if (state.status !== "active") events.push({ t: "end", status: state.status });
}

function enemyTurn(state: BattleState, actor: Combatant, rng: Rng, events: BattleEvent[]) {
  const def = ENEMIES[actor.kind];
  const intent = actor.intent ?? { attack: 0, target: null };
  const attack = def.attacks[intent.attack] ?? def.attacks[0];
  const heroes = living(state, "hero");
  // A taunting hero draws every single-target attack onto itself; otherwise the
  // enemy hits whom it said it would, or someone else if they're already down.
  const taunting = heroes.filter((h) => hasEffect(h, "taunting"));
  const meant = heroes.find((h) => h.id === intent.target);
  const targets =
    attack.target === "all_heroes" ? heroes : [taunting.length > 0 ? rng.pick(taunting) : meant ?? rng.pick(heroes)];
  const check = glitchable(actor, { label: attack.name, pct: attack.pct, count: attack.rolls }, rng);
  events.push({ t: "check", actor: actor.id, check });
  const scaled = Math.round(((attack.damage + Math.floor(actor.level / 2)) * check.successes) / attack.rolls);
  for (const target of targets) {
    if (state.status !== "active") break;
    if (check.fumble) {
      events.push({ t: "miss", actor: actor.id, target: target.id, ability: attack.name });
      continue;
    }
    damage(state, target, scaled, events, true, (amount) => ({ t: "hit", actor: actor.id, target: target.id, amount, ability: attack.name, perfect: check.perfect }));
    if (check.perfect && attack.perfect && !target.down) {
      addEffect(state, target, attack.perfect.effect, attack.perfect.turns, events);
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
  const check = glitchable(actor, {
    label: def.name,
    stat: def.stat,
    pct: actor.pct[def.stat] ?? statPct(5),
    count: def.rolls,
    focus,
  }, rng);
  events.push({ t: "check", actor: actor.id, check });
  // A crewmate's perfect gives some heroes focus.
  if (check.perfect && actor.side === "hero") {
    for (const h of living(state, "hero")) {
      if (h === actor) continue;
      for (const { id } of rulesOf(h, "ally_perfect_focus")) {
        h.focus += 1;
        events.push({ t: "trait", id: h.id, trait: id });
      }
    }
  }
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
      // Payoffs for what the target already carries, from the ability and from traits.
      let flat = 0;
      let mult = 1;
      if (def.perDebuffDamage) flat += def.perDebuffDamage * debuffCount(target);
      if (def.vsEffect && hasEffect(target, def.vsEffect.effect)) flat += def.vsEffect.bonus;
      const bleed = def.bleedPayoff ? target.effects.find((e) => e.kind === "bleeding") : undefined;
      if (bleed) flat += def.bleedPayoff! * bleed.turns;
      for (const { rule } of rulesOf(actor, "vs_effect")) if (hasEffect(target, rule.effect)) flat += rule.bonus;
      for (const { rule } of rulesOf(actor, "per_debuff")) flat += rule.bonus * debuffCount(target);
      const weak = target.hp * 4 < target.maxHp;
      if (weak && def.finisher) mult *= def.finisher;
      if (weak) for (const { rule } of rulesOf(actor, "finisher")) mult *= rule.mult;
      const base = Math.round((def.damage + actor.level + actor.power + aura + armorBonus + sizeBonus) * scale);
      const amount = damage(state, target, Math.round((base + flat) * mult), events, true, (amount) => ({
        t: "hit", actor: actor.id, target: target.id, amount, ability: def.name, perfect: check.perfect,
      }), def.ignoreGuard);
      if (bleed) target.effects = target.effects.filter((e) => e.kind !== "bleeding");
      if (check.perfect && def.perfect && !target.down) addEffect(state, target, def.perfect.effect, def.perfect.turns, events, actor);
      // The Wreck Warlock's perfect hits leave the target bleeding.
      if (check.perfect && actor.side === "hero" && actor.kind === "data_warlock" && !target.down) addEffect(state, target, "bleeding", WARLOCK_BLEED_TURNS, events, actor);
      if (check.perfect && !target.down) for (const { rule } of rulesOf(actor, "perfect_effect")) addEffect(state, target, rule.effect, rule.turns, events, actor);
      if (def.drain && amount > 0 && !actor.down && actor.hp < actor.maxHp) {
        const healed = Math.min(actor.maxHp - actor.hp, Math.max(1, Math.round(amount * def.drain)));
        actor.hp += healed;
        events.push({ t: "heal", actor: actor.id, target: actor.id, amount: healed, ability: def.name });
      }
    }
    // A heal-only ability that fails every roll says so, rather than passing in silence.
    if (def.heal !== undefined && check.fumble && def.damage === undefined) {
      events.push({ t: "miss", actor: actor.id, target: target.id, ability: def.name, heal: true });
    }
    if (def.heal !== undefined && !check.fumble) {
      const amount = Math.min(target.maxHp - target.hp, Math.round((def.heal + actor.level) * scale));
      target.hp += amount;
      events.push({ t: "heal", actor: actor.id, target: target.id, amount, ability: def.name });
    }
    if (def.targetEffect && !check.fumble && !target.down) addEffect(state, target, def.targetEffect.effect, def.targetEffect.turns, events, actor);
    // All Hands: the crewmate it picks takes the very next turn.
    if (def.actNext && !check.fumble && target !== actor && !target.down) target.next = state.clock;
  }
  if (def.selfEffect && !check.fumble) addEffect(state, actor, def.selfEffect.effect, def.selfEffect.turns, events, actor);
  return null;
}

/**
 * Bring a fight saved before the speed timeline (turn order plus an index)
 * onto it: the old order becomes the first pass of clock times, and enemies
 * pick their intents. Returns the state unchanged when it is already current.
 */
export function upgradeBattle(state: BattleState, rng: Rng): BattleState {
  if (typeof state.turnNo === "number" && state.combatants.every((c) => typeof c.next === "number")) return state;
  const old = state as BattleState & { order?: string[]; turn?: number };
  const order = old.order ?? state.combatants.map((c) => c.id);
  const at = Math.max(0, old.turn ?? 0);
  const events: BattleEvent[] = [];
  const out: BattleState = { ...state, actor: order[at] ?? null, clock: 0, turnNo: 1, itemUsed: false };
  delete (out as { order?: unknown }).order;
  delete (out as { turn?: unknown }).turn;
  delete (out as { round?: unknown }).round;
  out.combatants = state.combatants.map((c) => {
    const pos = order.indexOf(c.id);
    const behind = pos < 0 ? order.length : (pos - at + order.length) % order.length;
    return { ...c, next: behind, turns: 1 };
  });
  for (const c of out.combatants) if (c.side === "enemy" && !c.down) chooseIntent(out, c, rng, events);
  return out;
}

/**
 * The next `count` turns as the timeline stands, for the turn-order bar. A
 * projection: it knows haste, slow and stuns already on the board, not what
 * anyone will do between now and then.
 */
export function upcomingTurns(state: BattleState, count = 8): { id: string; skip: boolean }[] {
  if (state.status !== "active") return [];
  const sim = state.combatants
    .filter((c) => !c.down)
    .map((c) => ({
      c,
      next: c.next ?? 0,
      hasted: c.effects.find((e) => e.kind === "hasted")?.turns ?? 0,
      slowed: c.effects.find((e) => e.kind === "slowed")?.turns ?? 0,
      stunned: c.effects.some((e) => e.kind === "stunned"),
    }));
  const out: { id: string; skip: boolean }[] = [];
  const wait = (s: (typeof sim)[number]) => {
    let mult = 1;
    if (s.hasted > 0) { mult *= HASTE_FACTOR; s.hasted -= 1; }
    if (s.slowed > 0) { mult *= SLOW_FACTOR; s.slowed -= 1; }
    return turnDelay(s.c) * mult;
  };
  // The actor is mid-turn: its slot is now, and its next one follows a wait.
  const me = sim.find((s) => s.c.id === state.actor);
  if (me) {
    out.push({ id: me.c.id, skip: false });
    me.next = state.clock + wait(me);
  }
  for (let guard = 0; out.length < count && guard < 200 && sim.length > 0; guard++) {
    let best = sim[0];
    for (const s of sim) {
      if (s.next < best.next - 1e-9 || (Math.abs(s.next - best.next) <= 1e-9 && s.c.speed > best.c.speed)) best = s;
    }
    out.push({ id: best.c.id, skip: best.stunned });
    best.stunned = false;
    best.next += wait(best);
  }
  return out;
}

export type BattleStep = { ok: true; state: BattleState; events: BattleEvent[] } | { ok: false; error: string };

export function stepBattle(prev: BattleState, actorId: string, action: BattleAction, rng: Rng): BattleStep {
  if (prev.status !== "active") return { ok: false, error: "battle is over" };
  const state = structuredClone(upgradeBattle(prev, rng));
  const actor = currentActor(state);
  if (!actor || actor.id !== actorId || actor.side !== "hero") return { ok: false, error: "not your turn" };
  const events: BattleEvent[] = [];

  if (action.type === "potion") {
    // Drinking is a free action: the turn stays with the hero.
    if (state.itemUsed) return { ok: false, error: "you've already used an item this turn" };
    if (actor.potions <= 0) return { ok: false, error: "no potions" };
    const target = action.target ? find(state, action.target) : actor;
    if (!target || target.side !== "hero" || target.down) return { ok: false, error: "invalid target" };
    actor.potions -= 1;
    state.itemUsed = true;
    const bonus = rulesOf(actor, "potion_bonus").reduce((a, { rule }) => a + rule.amount, 0);
    const amount = Math.min(target.maxHp - target.hp, POTION_HEAL + bonus);
    target.hp += amount;
    events.push({ t: "heal", actor: actor.id, target: target.id, amount, ability: "Potion" });
    return { ok: true, state, events };
  }

  if (action.type === "ability") {
    const def = ABILITIES[action.ability];
    if (!def || !actor.abilities.includes(def.id)) return { ok: false, error: "unknown ability" };
    const focus = Math.max(0, Math.floor(action.focus ?? 0));
    if (focus > actor.focus || focus > def.rolls) return { ok: false, error: "not enough focus" };
    const err = resolveAbility(state, actor, def, action.target, focus, rng, events);
    if (err) return { ok: false, error: err };
    // The first focus spent in a fight can come back.
    if (focus > 0) {
      const free = rulesOf(actor, "first_focus_free").find(({ id }) => !(actor.spent ?? []).includes(id));
      if (free) {
        actor.focus += 1;
        (actor.spent ??= []).push(free.id);
        events.push({ t: "trait", id: actor.id, trait: free.id });
      }
    }
  } else if (action.type === "flee") {
    if (state.boss) return { ok: false, error: "there is no running from this fight" };
    const focus = Math.max(0, Math.floor(action.focus ?? 0));
    if (focus > actor.focus || focus > 2) return { ok: false, error: "not enough focus" };
    actor.focus -= focus;
    const check = glitchable(actor, { label: "Flee", stat: "agi", pct: actor.pct.agi ?? statPct(5), count: 2, focus }, rng);
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

  if (state.status === "active") {
    endTurn(state, actor, rng, events);
    advance(state, rng, events);
  } else events.push({ t: "end", status: state.status });
  return { ok: true, state, events };
}
