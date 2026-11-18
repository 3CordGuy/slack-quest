// The zone reducer. stepZone(state, action) is pure and seeded, like
// stepWorld: it returns the next state, what happened (for the client to
// show) and what the server must carry out.
//
// Out of a fight everyone walks freely, at once. A hero who comes within
// sight of an enemy group starts one: the group and every hero near it
// roll initiative, and from then on those in the fight take turns while
// everyone else keeps walking. Walk near the fight and you are in it.
//
// A turn is an Action, a Bonus action and movement, spent in any order.
// Heroes next to each other in the initiative order share a turn. Enemy
// turns are played here, at once, so nothing waits on a client.

import { STARTING_STATS, hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { classAbilitiesOf, poolFor, withClassAbilities } from "../classabilities";
import { ABILITIES, DRUID_REGEN, EFFECT_TICK, ENEMIES, HERO_CLASSES, WEAPONS, abilitiesFor } from "../content";
import { weaponItem } from "../gear";
import { battleDrops } from "../drops";
import { tileAt } from "../map";
import type { HeroSheet } from "../hero";
import { addStats, maxFocusFor, maxHpFor } from "../progression";
import { makeRng, seedFromString } from "../rng";
import { enemyTurn } from "./ai";
import { abilityArea, checkAbility, checkCommon, checkDrink, checkLight, checkThrow, doCommon, drinkItem, resolveAbility, throwItem, walk } from "./combat";
import { has, heal, removeCondition, tick, type Ctx } from "./engine";
import { ALERT_RANGE, JOIN_RANGE, freeHexNear, generateZone } from "./gen";
import { generateDelve } from "./delve";
import { checkOpen, openChest } from "./loot";
import { isCrateId } from "./crates";
import { FREE_WALK, blast, blockerAt, inFight, pathIn, sameHex, sees, solid, unitAt, unitById, zoneReach } from "./geometry";
import { AURAS, FLEE_RANGE, STARTING_ITEMS, THROWABLES, THROWABLE_KINDS, cleanItems, commonCost, enemyHp, enemyMove, tacticOf } from "./kit";
import { d20, heroMove, mod, rollDice, statOf } from "./rules";
import { hiddenEnemies, sentToClient } from "./light";
import { tickWeather, weatherAtTurn } from "./weather";
import { checkPickup, clearSurfaces, lightTorch, pickUpTorch, placeSurface, standInSurface, tickLights, tickSurfaces } from "./surfaces";
import { exploreRound, passTime } from "./clock";
import { checkUnlock, dropKeys, heardBy, workDoor } from "./doors";
import { checkForage, forage } from "./forage";
import type { Budget, DevOp, Encounter, Throwable, Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneHero, ZoneOptions, ZoneState, ZoneStep, ZoneView } from "./types";

/** Rounds a surface painted from the dev toolbox lasts. */
const PAINT_ROUNDS = 6;

// ---------- making a zone ----------

function enemyUnit(state: ZoneState, kind: string, pos: HexPos, group: string): Unit {
  const hp = enemyHp(kind, state.options.level, state.options.threat);
  return {
    id: `e${++state.seq}`,
    side: "enemy",
    name: ENEMIES[kind].name,
    kind,
    level: state.options.level,
    pos,
    hp,
    maxHp: hp,
    focus: 0,
    maxFocus: 0,
    armor: 0,
    power: 0,
    abilities: [],
    conditions: [],
    down: false,
    cooldowns: {},
    items: {},
    group,
    home: pos,
  };
}

/**
 * A cave is left by its mouth, and only there (ZoneView). One made without a mouth (open cave floor from before
 * delves, or a dev map) is given one where heroes arrive: its start. Run on every cave made, and on every saved
 * one as it is loaded, so none is ever left with no way out. Returns the same state, changed in place.
 */
export function ensureMouth(state: ZoneState): ZoneState {
  if (state.options.biome !== "caves" || state.map.pois.some((p) => p.kind === "landing")) return state;
  state.map.pois.push({ id: "landing", kind: "landing", pos: { q: state.start.q, r: state.start.r }, hidden: false, cleared: false, usedBy: [], enemies: [] });
  return state;
}

export function createZone(code: string, seed: string, options: ZoneOptions): ZoneState {
  const plan = options.delve ? generateDelve(seed, options) : generateZone(seed, options);
  const state: ZoneState = { v: 1, code, seed, rng: seedFromString(`zone-run|${seed}`), options, map: plan.map, start: plan.start, units: [], groups: {}, surfaces: {}, encounter: null, seq: 0 };
  if (plan.keys && plan.keys.length > 0) state.keyHolders = [...plan.keys];
  for (const group of plan.groups) {
    const id = group.id ?? `g${++state.seq}`;
    state.groups[id] = { alerted: false };
    group.kinds.forEach((kind, i) => state.units.push(enemyUnit(state, kind, group.posts[i], id)));
  }
  ensureMouth(state);
  return state;
}

/** What a client is sent. */
export function zoneView(state: ZoneState, you: string): ZoneView {
  const { rng: _rng, seed: _seed, ...rest } = state;
  const hidden = hiddenEnemies(state);
  if (hidden.length === 0) return { ...rest, you };
  // What the dark hides is not sent at all, unless it is in a fight: then it keeps its place in the order, marked.
  const fighting = hidden.filter((id) => inFight(state, id));
  return { ...rest, units: rest.units.filter(sentToClient(state, new Set(hidden))), you, ...(fighting.length > 0 ? { dark: fighting } : {}) };
}

/** Whose turn the server is waiting on, as a key that changes when the wait does. Null out of a fight. */
export function zoneAwaiting(state: ZoneState): string | null {
  return state.encounter && state.encounter.acting.length > 0 ? `t:${state.encounter.turnNo}` : null;
}

/** Everything a hero can use in a fight: what their weapon gives, then the class abilities they chose. */
function heroAbilities(hero: ZoneHero): string[] {
  return withClassAbilities(abilitiesFor(hero.weapon), hero.classAbilities);
}

function heroUnit(hero: ZoneHero, pos: HexPos, controller?: string): Unit {
  return {
    id: hero.id,
    side: "hero",
    name: hero.name,
    kind: hero.classId,
    level: hero.level,
    pos,
    hp: hero.maxHp,
    maxHp: hero.maxHp,
    focus: hero.maxFocus,
    maxFocus: hero.maxFocus,
    stats: hero.stats,
    armor: hero.armor,
    power: hero.weaponPower,
    abilities: heroAbilities(hero),
    outfit: hero.outfit,
    conditions: [],
    down: false,
    cooldowns: {},
    items: { ...(hero.items ?? STARTING_ITEMS) },
    controller,
  };
}

/** A hero's sheet, as a zone needs it: stats with gear, how much they can take, and (`items`) what their pack holds to drink or throw. */
export function zoneHero(sheet: HeroSheet, items?: Partial<Record<Throwable, number>>): ZoneHero {
  const stats = addStats(sheet.base, sheet.bonus);
  return {
    id: sheet.id, name: sheet.name, classId: sheet.classId, level: sheet.level, stats, weapon: sheet.weapon, weaponPower: sheet.weaponPower ?? 0, armor: sheet.armor ?? 0, outfit: sheet.outfit,
    maxHp: maxHpFor(stats, sheet.level), maxFocus: maxFocusFor(sheet.level),
    classAbilities: classAbilitiesOf(sheet.classId, sheet.level, sheet.abilityLoadout),
    ...(items ? { items: cleanItems(items) } : {}),
  };
}

/** A stand-in crewmate of a class, as it starts out: for trying fights with a party when alone. */
export function standInHero(classId: string, id: string, level: number): ZoneHero | null {
  const cls = HERO_CLASSES.find((c) => c.id === classId);
  const stats = STARTING_STATS[classId];
  if (!cls || !stats) return null;
  return { id, name: cls.name.split(" ").slice(-1)[0], classId, level, stats, weapon: cls.weapons[0], weaponPower: 0, armor: 0, maxHp: maxHpFor(stats, level), maxFocus: maxFocusFor(level) };
}

// ---------- fights ----------

const standing = (state: ZoneState, side: Unit["side"]) => state.units.filter((u) => u.side === side && !u.down);

/**
 * Roll a unit's initiative and slot it into the order: highest first, heroes ahead of enemies on a tie. One coming
 * back into a fight they fled has the place they had: no fresh roll, so no fresh turn out of getting away and back.
 */
function enter(ctx: Ctx, enc: Encounter, unit: Unit): void {
  if (enc.order.includes(unit.id)) return;
  if (enc.init[unit.id] === undefined) {
    const bonus = unit.side === "hero" ? mod(statOf(unit, "agi")) : Math.round(((ENEMIES[unit.kind]?.speed ?? 50) - 50) / 15);
    const roll = d20(ctx.rng, { kind: "initiative", id: unit.id, label: "Initiative", bonus, vs: 0, adv: 0 });
    ctx.events.push({ t: "roll", roll });
    enc.init[unit.id] = roll.total;
  }
  const side = (id: string) => (unitById(ctx.state, id)?.side === "hero" ? 0 : 1);
  const before = (a: string, b: string) => enc.init[b] - enc.init[a] || side(a) - side(b) || a.localeCompare(b);
  const at = enc.order.findIndex((id) => before(unit.id, id) < 0);
  enc.order.splice(at < 0 ? enc.order.length : at, 0, unit.id);
  // One who fled it and is back is simply in it again.
  if (enc.fled?.includes(unit.id)) enc.fled = enc.fled.filter((id) => id !== unit.id);
  // A Warden walks into every fight with their guard up.
  if (unit.kind === "sre_warden" && !has(unit, "guarded")) unit.conditions.push({ kind: "guarded", rounds: 1 });
}

/**
 * Whether a hero out of the fight is near enough to be drawn into it: within JOIN_RANGE of anyone in it.
 * One who fled it has got clear, and only an enemy in it coming within FLEE_RANGE brings them back.
 */
function drawnIn(state: ZoneState, enc: Encounter, hero: Unit): boolean {
  const fled = !!enc.fled?.includes(hero.id);
  return state.units.some((f) => enc.order.includes(f.id) && !f.down && (fled ? f.side !== hero.side && hexDistance(f.pos, hero.pos) <= FLEE_RANGE : hexDistance(f.pos, hero.pos) <= JOIN_RANGE));
}

/** Heroes near anyone in the fight are in it. */
function pullIn(ctx: Ctx): void {
  const enc = ctx.state.encounter;
  if (!enc) return;
  for (const hero of standing(ctx.state, "hero")) {
    // Nobody is dragged into a fight while their player is not there to play it.
    if (hero.away || enc.order.includes(hero.id) || !drawnIn(ctx.state, enc, hero)) continue;
    enter(ctx, enc, hero);
    ctx.events.push({ t: "fight_join", id: hero.id });
  }
}

/**
 * Whatever a hero out of the fight does to someone in it, harm or help, puts them in it: a shot from afar,
 * a bomb, a heal for a friend still fighting. (Walking near it does too: pullIn.) Not one who fled it: see reachBack.
 */
function reachIn(ctx: Ctx, unit: Unit, touched: Unit[]): void {
  const enc = ctx.state.encounter;
  if (!enc || unit.side !== "hero" || unit.down || enc.order.includes(unit.id)) return;
  if (!touched.some((u) => u.id !== unit.id && enc.order.includes(u.id))) return;
  enter(ctx, enc, unit);
  ctx.events.push({ t: "fight_join", id: unit.id });
}

/**
 * Why a hero who fled the fight cannot do this, in words, or null. Out of the fight they have no turn to wait for,
 * no Action to spend and no cooldowns running, so nothing they do to anyone in it is allowed until an enemy in it
 * draws them back (drawnIn): else every Flee would buy a free blow, flask or rescue, off the turn order.
 */
function reachBack(state: ZoneState, unit: Unit, touched: Unit[]): string | null {
  const enc = state.encounter;
  if (!enc?.fled?.includes(unit.id) || !touched.some((u) => u.id !== unit.id && enc.order.includes(u.id))) return null;
  return `You got away from that fight: to act on anyone in it, go back until an enemy in it is within ${FLEE_RANGE} hexes of you.`;
}

/**
 * A hero gets away (Flee): out of the order and out of the turn, free to walk. The fight goes on for anyone
 * still in it; once no hero is, it is over (settle). Their initiative is kept for if they come back, and they
 * have had this round's turn.
 */
function flee(ctx: Ctx, unit: Unit): void {
  const enc = ctx.state.encounter!;
  const at = enc.order.indexOf(unit.id);
  enc.order.splice(at, 1);
  delete enc.budgets[unit.id];
  const acting = enc.acting.includes(unit.id);
  enc.acting = enc.acting.filter((id) => id !== unit.id);
  enc.done = enc.done.filter((id) => id !== unit.id);
  // The turn was theirs alone: the next goes to whoever came after them.
  if (acting && enc.acting.length === 0) enc.resume = enc.order[at] ?? null;
  enc.fled = [...(enc.fled ?? []), unit.id];
  enc.waits = [...(enc.waits ?? []), unit.id];
  endTurn(unit);
  ctx.events.push({ t: "fled", id: unit.id });
}

/** Enemy groups have noticed someone: they are in a fight. One starts if none is on. */
function engage(ctx: Ctx, groups: string[], by: Unit): void {
  const { state } = ctx;
  const fresh = groups.filter((g) => state.groups[g] && !state.groups[g].alerted);
  if (fresh.length === 0) return;
  for (const g of fresh) {
    state.groups[g].alerted = true;
    ctx.events.push({ t: "alert", group: g, by: by.id });
  }
  const members = state.units.filter((u) => u.group && fresh.includes(u.group) && !u.down);
  if (members.length === 0) return;
  const starting = !state.encounter;
  const enc: Encounter = state.encounter ?? { round: 1, order: [], init: {}, acting: [], done: [], budgets: {}, reacted: [], turnNo: 0, deadline: null };
  state.encounter = enc;
  const joining = [...members, ...(by.side === "hero" && !by.down ? [by] : [])];
  if (starting) ctx.events.push({ t: "fight_start", units: joining.map((u) => u.id) });
  for (const u of joining) {
    if (enc.order.includes(u.id)) continue;
    enter(ctx, enc, u);
    if (!starting) ctx.events.push({ t: "fight_join", id: u.id });
  }
  pullIn(ctx);
}

/** The groups, not yet alerted, with someone who can see `unit` from close by. */
function noticedBy(state: ZoneState, unit: Unit): string[] {
  const out = new Set<string>();
  for (const e of standing(state, "enemy")) {
    if (!e.group || state.groups[e.group]?.alerted) continue;
    if (hexDistance(e.pos, unit.pos) <= ALERT_RANGE && sees(state.map, e.pos, unit.pos)) out.add(e.group);
  }
  return [...out];
}

/** After each step: has this unit walked into a fight, or brought one to somebody? True stops it where it is. */
function onStep(ctx: Ctx, unit: Unit, flush: () => void): boolean {
  if (unit.side !== "hero") {
    // An enemy closing in draws nearby heroes into the fight; it carries on.
    pullIn(ctx);
    return false;
  }
  const noticed = noticedBy(ctx.state, unit);
  if (noticed.length > 0) {
    flush();
    engage(ctx, noticed, unit);
    return true;
  }
  const enc = ctx.state.encounter;
  if (enc && !inFight(ctx.state, unit.id) && drawnIn(ctx.state, enc, unit)) {
    flush();
    pullIn(ctx);
    return true;
  }
  return false;
}

/** Start a unit's turn: its conditions and the ground act on it, and it gets its budget. False if it has no turn to take. */
function beginTurn(ctx: Ctx, enc: Encounter, unit: Unit): boolean {
  for (const key of Object.keys(unit.cooldowns)) {
    unit.cooldowns[key] -= 1;
    if (unit.cooldowns[key] <= 0) delete unit.cooldowns[key];
  }
  removeCondition(unit, "guarded");
  removeCondition(unit, "taunting");
  for (const kind of ["bleeding", "burning"] as const) if (has(unit, kind)) tick(ctx, unit, kind, EFFECT_TICK[kind] ?? 0);
  if (unit.down) return false;
  // A Druid mends a little every turn.
  if (unit.kind === "backend_druid" && unit.hp < unit.maxHp) heal(ctx, unit, DRUID_REGEN, { actor: unit.id, what: "regen" });
  // A Healing Aura mends the bearer and everyone of theirs standing beside them.
  if (has(unit, "mending")) {
    for (const u of ctx.state.units) {
      if (u.side === unit.side && !u.down && u.hp < u.maxHp && hexDistance(u.pos, unit.pos) <= AURAS.range) heal(ctx, u, rollDice(ctx.rng, AURAS.heal), { actor: unit.id, what: "healing_aura" });
    }
  }
  // A troll's wounds close at the start of each of its turns, unless it is on fire.
  const grows = unit.side === "enemy" ? ENEMIES[unit.kind]?.regen : undefined;
  if (grows && unit.hp < unit.maxHp && !has(unit, grows.unless)) heal(ctx, unit, grows.amount, { actor: unit.id, what: grows.name });
  standInSurface(ctx, unit);
  if (unit.down) return false;
  if (has(unit, "stunned")) {
    removeCondition(unit, "stunned");
    ctx.events.push({ t: "skip", id: unit.id, kind: "stunned" });
    return false;
  }
  const base = unit.side === "hero" && unit.stats ? heroMove(unit.stats) : enemyMove(unit.kind);
  let move = base;
  if (has(unit, "slowed")) move = Math.floor(move / 2);
  if (has(unit, "hasted")) move *= 2;
  // Getting up off the ground takes half a turn's movement.
  if (has(unit, "prone")) {
    removeCondition(unit, "prone");
    move = Math.floor(move / 2);
  }
  enc.budgets[unit.id] = { action: true, bonus: true, move, moveMax: base, disengaged: false };
  // Weather it stands in acts now its turn is underway, with a budget for the winds to change.
  weatherAtTurn(ctx, unit);
  return !unit.down;
}

/** End a unit's turn: each condition has one turn less to run, bar those put on during this very turn. */
function endTurn(unit: Unit): void {
  for (const c of unit.conditions) {
    if (c.fresh) c.fresh = false;
    else c.rounds -= 1;
  }
  unit.conditions = unit.conditions.filter((c) => c.rounds > 0);
}

/**
 * If the fight is decided, end it. Won: the fallen heroes get up on 1 HP and the enemy dead are cleared
 * away. Lost: the heroes wake at the start on 1 HP, and the enemy are back at their posts, healed.
 * Fled (every hero still standing got away, and none is left in it): nobody wins. The enemy go back to
 * their posts and bind their wounds, but those of them that fell stay fallen: fleeing gets a party out,
 * and what it killed stays killed, but it is no way to wear a band down. It never costs more than losing:
 * nobody is moved or hurt, and nothing is paid.
 */
function settle(ctx: Ctx): boolean {
  const { state } = ctx;
  const enc = state.encounter;
  if (!enc) return false;
  const fighters = state.units.filter((u) => enc.order.includes(u.id));
  const heroes = fighters.filter((u) => u.side === "hero");
  const foes = fighters.filter((u) => u.side === "enemy");
  const won = foes.every((u) => u.down);
  const lost = !won && heroes.length > 0 && heroes.every((u) => u.down);
  const fled = !won && heroes.length === 0;
  if (!won && !lost && !fled) return false;
  state.encounter = null;
  ctx.events.push({ t: "fight_end", outcome: won ? "victory" : lost ? "defeat" : "fled" });
  for (const h of heroes) {
    if (h.down) {
      h.down = false;
      h.hp = 1;
      ctx.events.push({ t: "up", id: h.id });
    }
    h.conditions = [];
    h.cooldowns = {};
  }
  // Those who got away took part too: what they were waiting on in it is over with it.
  for (const id of enc.fled ?? []) {
    const h = unitById(state, id);
    if (h) h.cooldowns = {};
  }
  if (won) {
    // Every hero who fought takes the whole XP and their own roll of what the fallen left. A stand-in takes nothing.
    const xp = foes.reduce((sum, f) => sum + (ENEMIES[f.kind]?.xp ?? 0), 0);
    for (const h of heroes) {
      if (h.controller) continue;
      const resources = battleDrops(ctx.rng, foes.map((f) => f.kind));
      ctx.effects.push({ type: "grant", heroId: h.id, xp, resources });
      ctx.events.push({ t: "spoils", id: h.id, xp, resources });
    }
  } else if (fled) {
    // Nobody left to fight: back to their posts, whole again, ready to turn on whoever they see next. The dead stay dead.
    const groups = new Set(foes.map((f) => f.group));
    for (const g of groups) if (g && state.groups[g]) state.groups[g].alerted = false;
    const back = state.units.filter((u) => u.side === "enemy" && !u.down && groups.has(u.group));
    const was = new Map(back.map((f) => [f.id, f.pos]));
    // Off the board for a moment, so each finds its own post, or the nearest free hex if a hero stands on it.
    for (const f of back) {
      f.hp = f.maxHp;
      f.conditions = [];
      f.pos = { q: -99, r: -99 };
    }
    for (const f of back) {
      const post = f.home ?? was.get(f.id)!;
      f.pos = freeHexNear(state.map, post, (p) => !!unitAt(state, p) || blockerAt(state, p), (p) => tileAt(state.map, p)) ?? was.get(f.id)!;
    }
  } else {
    const groups = new Set(foes.map((f) => f.group));
    for (const g of groups) if (g && state.groups[g]) state.groups[g].alerted = false;
    for (const f of state.units.filter((u) => u.side === "enemy" && groups.has(u.group))) {
      f.down = false;
      f.hp = f.maxHp;
      f.conditions = [];
      f.pos = f.home ?? f.pos;
    }
    for (const h of heroes) {
      h.hp = 1;
      // Off the board for a moment, so each finds its own free hex by the start.
      h.pos = { q: -99, r: -99 };
    }
    for (const h of heroes) h.pos = freeHexNear(state.map, state.start, (p) => !!unitAt(state, p) || blockerAt(state, p), (p) => tileAt(state.map, p)) ?? state.start;
  }
  sweep(state);
  if (won && !state.units.some((u) => u.side === "enemy")) ctx.events.push({ t: "cleared" });
  return true;
}

/** Clear away enemies that have fallen and are in no fight, and the groups with nobody left. */
function sweep(state: ZoneState): void {
  state.units = state.units.filter((u) => u.side === "hero" || !u.down || inFight(state, u.id));
  for (const g of Object.keys(state.groups)) if (!state.units.some((u) => u.group === g)) delete state.groups[g];
}

/** Where in the order the turn just taken ends: at its last actor, or, if the one taking it fled, just before whoever came after them. */
function turnEnd(enc: Encounter): number {
  if (enc.acting.length > 0) return Math.max(...enc.acting.map((id) => enc.order.indexOf(id)));
  if (enc.resume === undefined) return -1;
  return enc.resume === null ? enc.order.length - 1 : Math.max(-1, enc.order.indexOf(enc.resume) - 1);
}

/** Move the fight on to whoever is next, playing enemy turns as they come, until a hero's turn or the end. */
function advance(ctx: Ctx): void {
  const { state } = ctx;
  for (let guard = 0; guard < 400; guard++) {
    const enc = state.encounter;
    if (!enc || settle(ctx)) return;
    for (const id of enc.acting) {
      const u = unitById(state, id);
      if (u) endTurn(u);
    }
    let i = turnEnd(enc);
    delete enc.resume;
    enc.acting = [];
    enc.done = [];
    enc.budgets = {};
    const next: Unit[] = [];
    for (let looked = 0; next.length === 0 && looked <= enc.order.length; looked++) {
      i += 1;
      if (i >= enc.order.length) {
        i = 0;
        enc.round += 1;
        enc.reacted = [];
        delete enc.waits;
        ctx.events.push({ t: "round", n: enc.round });
        // Everyone not in the fight lives through the round as well (the clock stands still while one is on):
        // a hero who got away still burns and bleeds, and what is on them still runs down.
        for (const out of state.units.filter((u) => !enc.order.includes(u.id))) exploreRound(ctx, out);
        tickSurfaces(ctx);
        tickWeather(ctx);
        tickLights(ctx);
      }
      // One back in after fleeing on their turn this round waits for the next.
      const waiting = (u: Unit | undefined) => !u || u.down || !!enc.waits?.includes(u.id);
      const u = unitById(state, enc.order[i]);
      if (waiting(u)) continue;
      next.push(u!);
      // Heroes one after another in the order take their turns together.
      while (u!.side === "hero" && i + 1 < enc.order.length && unitById(state, enc.order[i + 1])?.side !== "enemy") {
        i += 1;
        const also = unitById(state, enc.order[i]);
        if (!waiting(also)) next.push(also!);
      }
    }
    if (next.length === 0) {
      settle(ctx);
      return;
    }
    enc.turnNo += 1;
    enc.acting = next.map((u) => u.id);
    const ready = next.filter((u) => beginTurn(ctx, enc, u));
    enc.done = next.filter((u) => !ready.includes(u)).map((u) => u.id);
    if (settle(ctx)) return;
    if (ready.length === 0) continue;
    if (next[0].side === "enemy") {
      enemyTurn(ctx, next[0], enc.budgets[next[0].id]);
      enc.done = [next[0].id];
      continue;
    }
    ctx.events.push({ t: "turn", ids: ready.map((u) => u.id) });
    return;
  }
}

// ---------- actions ----------

/** The unit a player is acting as: their own hero, or a stand-in they control. */
function mine(state: ZoneState, by: string, id: string): Unit | string {
  const unit = unitById(state, id);
  if (!unit || unit.side !== "hero" || (unit.id !== by && unit.controller !== by)) return "That is not yours to move.";
  if (unit.down) return `${unit.name} is down.`;
  return unit;
}

/** What `unit` has left this turn, if it is in a fight: an error if it is not its turn, null if it is in no fight. */
function budgetOf(state: ZoneState, unit: Unit): Budget | null | string {
  const enc = state.encounter;
  if (!enc || !enc.order.includes(unit.id)) return null;
  if (!enc.acting.includes(unit.id) || enc.done.includes(unit.id)) return "It is not your turn.";
  return enc.budgets[unit.id] ?? "It is not your turn.";
}

function spend(budget: Budget | null, cost: "action" | "bonus"): string | null {
  if (!budget) return null;
  if (!budget[cost]) return cost === "action" ? "You have used your Action this turn." : "You have used your Bonus action this turn.";
  budget[cost] = false;
  return null;
}

/** The highest level a dev kit (DevOp "kit") will make a hero. */
export const KIT_MAX_LEVEL = 20;

function dev(ctx: Ctx, by: string, op: DevOp): string | null {
  const { state } = ctx;
  const free = (near: HexPos) => freeHexNear(state.map, near, (p) => !!unitAt(state, p) || blockerAt(state, p), (p) => tileAt(state.map, p));
  if (op.op === "spawn") {
    const kinds = op.kinds.filter((k) => ENEMIES[k]).slice(0, 6);
    if (kinds.length === 0 || solid(tileAt(state.map, op.at))) return "Nothing to put there.";
    const group = `g${++state.seq}`;
    state.groups[group] = { alerted: false };
    for (const kind of kinds) {
      const pos = free(op.at);
      if (pos) state.units.push(enemyUnit(state, kind, pos, group));
    }
  } else if (op.op === "paint") {
    const hexes = op.hexes.filter((p) => tileAt(state.map, p)).slice(0, 60);
    if (op.kind) placeSurface(ctx, hexes, op.kind, PAINT_ROUNDS, null);
    else clearSurfaces(ctx, hexes);
  } else if (op.op === "standin") {
    const owner = unitById(state, by);
    const hero = standInHero(op.classId, `s${++state.seq}`, owner?.level ?? state.options.level);
    const pos = free(owner?.pos ?? state.start);
    if (!hero || !pos) return "No room for a stand-in.";
    state.units.push(heroUnit(hero, pos, by));
    ctx.events.push({ t: "joined", id: hero.id });
  } else if (op.op === "heal") {
    for (const h of state.units.filter((u) => u.side === "hero")) {
      h.down = false;
      h.hp = h.maxHp;
      h.focus = h.maxFocus;
      // Restocked: brought up to the starting kit, with anything more they carry left alone.
      for (const kind of THROWABLE_KINDS) if ((STARTING_ITEMS[kind] ?? 0) > (h.items[kind] ?? 0)) h.items[kind] = STARTING_ITEMS[kind];
      h.conditions = [];
      h.cooldowns = {};
    }
  } else if (op.op === "end_fight") {
    for (const f of state.units.filter((u) => u.side === "enemy" && inFight(state, u.id))) {
      f.hp = 0;
      f.down = true;
    }
  } else if (op.op === "start_fight") {
    const owner = unitById(state, by);
    const nearest = state.units
      .filter((u) => u.side === "enemy" && !u.down && u.group && !state.groups[u.group]?.alerted)
      .sort((a, b) => hexDistance(a.pos, owner?.pos ?? state.start) - hexDistance(b.pos, owner?.pos ?? state.start))[0];
    if (!owner || !nearest) return "There is nobody to fight.";
    engage(ctx, [nearest.group!], owner);
  } else if (op.op === "kit") {
    const u = unitById(state, op.unit);
    if (!u || u.side !== "hero" || (u.id !== by && u.controller !== by)) return "That is not one of your heroes.";
    const weapon = WEAPONS[op.weapon];
    if (!weapon || weapon.classId !== op.classId) return "That is not a weapon of that class.";
    const level = Math.max(1, Math.min(KIT_MAX_LEVEL, Math.floor(Number(op.level)) || 1));
    const sheet = standInHero(op.classId, u.id, level);
    if (!sheet) return "There is no such class.";
    const pool = new Set(poolFor(op.classId).map((e) => e.id));
    const abilities = withClassAbilities(weapon.abilities, op.abilities.filter((a) => pool.has(a)));
    const item = weaponItem(weapon.id);
    Object.assign(u, { kind: op.classId, level, stats: sheet.stats, maxHp: sheet.maxHp, hp: sheet.maxHp, maxFocus: sheet.maxFocus, focus: sheet.maxFocus, cooldowns: {}, devKit: true });
    u.outfit = { ...u.outfit, main_hand: { icon: item.icon, ref: item.ref, rarity: item.rarity } };
    // A torch swung in the main hand stays there: the new weapon is what is taken up when it goes.
    if (u.torchHand === "main") u.stowed = abilities;
    else u.abilities = abilities;
  } else if (op.op === "ai") {
    state.aiOff = op.off;
  } else if (op.op === "clear_surfaces") {
    clearSurfaces(ctx, Object.keys(state.surfaces).map((key) => ({ q: Number(key.split(",")[0]), r: Number(key.split(",")[1]) })));
  }
  return null;
}

function act(ctx: Ctx, action: ZoneAction): string | null {
  const { state } = ctx;
  if (action.type === "away") {
    for (const u of state.units) {
      if (u.side !== "hero" || (u.id !== action.player && u.controller !== action.player)) continue;
      if (action.away) u.away = true;
      else delete u.away;
    }
    return null;
  }
  if (action.type === "join") {
    const hero = action.hero;
    // Back on the map: their hero, and the stand-ins they play, are here again.
    for (const u of state.units) if (u.id === hero.id || u.controller === hero.id) delete u.away;
    const here = unitById(state, hero.id);
    if (here) {
      // What their pack holds is what they carry, fight or no fight.
      if (hero.items) here.items = { ...hero.items };
      // Back again, perhaps with different gear: the sheet is refreshed, and where they stand and how hurt they are is kept.
      // Not in a fight, though: that is fought in the gear it was started in. Nor a hero given a dev kit.
      if (inFight(state, here.id) || here.devKit) return null;
      Object.assign(here, { name: hero.name, kind: hero.classId, level: hero.level, stats: hero.stats, armor: hero.armor, power: hero.weaponPower, outfit: hero.outfit, maxHp: hero.maxHp, maxFocus: hero.maxFocus });
      // A torch swung in the main hand stays there: the new weapon is what is taken up when it goes.
      if (here.torchHand === "main") here.stowed = heroAbilities(hero);
      else here.abilities = heroAbilities(hero);
      here.hp = Math.min(here.hp, here.maxHp);
      return null;
    }
    // Teleported to a crewmate: beside them, unless they have since got into a fight.
    const friend = action.near ? unitById(state, action.near) : undefined;
    const beside = friend && friend.side === "hero" && !inFight(state, friend.id) ? friend.pos : state.start;
    const pos = freeHexNear(state.map, beside, (p) => !!unitAt(state, p) || blockerAt(state, p), (p) => tileAt(state.map, p));
    if (!pos) return "There is no room to arrive.";
    state.units.push(heroUnit(hero, pos));
    ctx.events.push({ t: "joined", id: hero.id });
    return null;
  }
  if (action.type === "timeout") {
    if (state.encounter) state.encounter.done = [...state.encounter.acting];
    return null;
  }
  if (action.type === "time") {
    passTime(ctx, action.now);
    return null;
  }
  if (action.type === "stock") {
    const hero = unitById(state, action.unit);
    if (hero?.side === "hero") hero.items = cleanItems(action.items);
    return null;
  }
  if (action.type === "dev") return dev(ctx, action.by, action.dev);

  const unit = mine(state, action.by, action.unit);
  if (typeof unit === "string") return unit;
  const budget = budgetOf(state, unit);
  if (typeof budget === "string") return budget;

  if (action.type === "end_turn") {
    if (!budget) return "There is no turn to end.";
    state.encounter!.done.push(unit.id);
    return null;
  }
  if (action.type === "move") {
    if (sameHex(action.to, unit.pos)) return null;
    const reach = zoneReach(state, unit, budget ? budget.move : FREE_WALK);
    const end = reach.get(posKey(action.to));
    if (!end) return budget ? "You cannot get there with the movement you have left." : "You cannot get there.";
    if (!end.stop) return "Someone is standing there.";
    walk(ctx, unit, pathIn(reach, action.to) ?? [], budget);
    return null;
  }
  if (action.type === "use") {
    const def = ABILITIES[action.ability];
    const tactic = tacticOf(action.ability);
    // Focus is for a roll to hit: a blow at a crate always lands, so none is spent on it.
    const aim = { target: action.target, at: action.at, focus: !!action.focus && !isCrateId(state, action.target) };
    const wrong = checkAbility(state, unit, action.ability, aim);
    if (wrong) return wrong;
    // Something that takes a shape can catch a group that had not noticed anyone: it has now.
    const area = new Set(abilityArea(state, unit, action.ability, action.at).map(posKey));
    const touched = state.units.filter((u) => u.id === action.target || area.has(posKey(u.pos)));
    const back = reachBack(state, unit, touched);
    if (back) return back;
    if (budget && (unit.cooldowns[action.ability] ?? 0) > 0) return `${def.name} is not ready yet.`;
    if (aim.focus && unit.focus <= 0) return "You have no Focus left.";
    const cost = spend(budget, tactic.cost);
    if (cost) return cost;
    if (aim.focus) unit.focus -= 1;
    if (budget && tactic.cooldown) unit.cooldowns[action.ability] = tactic.cooldown + 1;
    const struck = touched.filter((u) => u.side === "enemy" && !u.down).map((u) => u.group!);
    resolveAbility(ctx, unit, action.ability, aim);
    engage(ctx, struck, unit);
    reachIn(ctx, unit, touched);
    return null;
  }
  if (action.type === "common") {
    const aim = { target: action.target, at: action.at };
    const wrong = checkCommon(state, unit, action.what, aim, budget);
    if (wrong) return wrong;
    const target = action.what === "shove" || action.what === "help" ? unitById(state, action.target!) : undefined;
    const back = reachBack(state, unit, target ? [target] : []);
    if (back) return back;
    const cost = spend(budget, commonCost(action.what, unit.kind));
    if (cost) return cost;
    doCommon(ctx, unit, action.what, aim, budget);
    if (action.what === "shove" && target?.group) engage(ctx, [target.group], unit);
    if (target) reachIn(ctx, unit, [target]);
    if (action.what === "flee") flee(ctx, unit);
    return null;
  }
  if (action.type === "drink") {
    const wrong = checkDrink(unit, action.item);
    if (wrong) return wrong;
    const cost = spend(budget, "bonus");
    if (cost) return cost;
    drinkItem(ctx, unit, action.item);
    return null;
  }
  if (action.type === "pickup") {
    const wrong = checkPickup(state, unit, action.at);
    if (wrong) return wrong;
    // Out of a fight it is free; in one, a Bonus action, like lighting one.
    const cost = spend(budget, "bonus");
    if (cost) return cost;
    pickUpTorch(ctx, unit, action.at);
    return null;
  }
  if (action.type === "open") {
    const chest = state.map.pois.find((p) => p.id === action.poi && p.kind === "cache");
    const wrong = checkOpen(state, unit, chest);
    if (wrong) return wrong;
    const cost = spend(budget, "action");
    if (cost) return cost;
    openChest(ctx, unit, chest!);
    return null;
  }
  if (action.type === "forage") {
    const patch = state.map.pois.find((p) => p.id === action.poi && p.kind === "glowcap");
    const wrong = checkForage(state, unit, patch);
    if (wrong) return wrong;
    const cost = spend(budget, "action");
    if (cost) return cost;
    forage(ctx, unit, patch!);
    return null;
  }
  if (action.type === "unlock") {
    const door = state.map.pois.find((p) => p.id === action.poi && p.kind === "gate");
    const wrong = checkUnlock(state, unit, door);
    if (wrong) return wrong;
    const cost = spend(budget, "action");
    if (cost) return cost;
    // A key is quiet. Forcing it is heard, whether the door gives or not: the nearest band that has not noticed anyone comes.
    const { forced } = workDoor(ctx, unit, door!);
    const heard = forced ? heardBy(state, door!.pos) : undefined;
    if (heard) {
      ctx.events.push({ t: "noise", group: heard });
      engage(ctx, [heard], unit);
    }
    return null;
  }
  if (action.type === "light") {
    const wrong = checkLight(unit);
    if (wrong) return wrong;
    const cost = spend(budget, "bonus");
    if (cost) return cost;
    lightTorch(ctx, unit, action.hand);
    return null;
  }
  // Throw.
  const wrong = checkThrow(state, unit, action.item, action.at);
  if (wrong) return wrong;
  const def = THROWABLES[action.item];
  const area = new Set(blast(state.map, action.at, def.radius).map(posKey));
  const touched = state.units.filter((u) => area.has(posKey(u.pos)));
  const back = reachBack(state, unit, touched);
  if (back) return back;
  const cost = spend(budget, "action");
  if (cost) return cost;
  // A healing potion among enemies is a kindness; anything else is a declaration.
  const struck = def.heal ? [] : touched.filter((u) => u.side === "enemy" && !u.down).map((u) => u.group!);
  throwItem(ctx, unit, action.item, action.at);
  engage(ctx, struck, unit);
  reachIn(ctx, unit, touched);
  return null;
}

export function stepZone(prev: ZoneState, action: ZoneAction): ZoneStep {
  const state = structuredClone(prev);
  const ctx: Ctx = { state, rng: makeRng(state.rng), events: [] as ZoneEvent[], effects: [] as ZoneEffect[] };
  ctx.onStep = (unit, flush) => onStep(ctx, unit, flush);
  const error = act(ctx, action);
  if (error) return { ok: false, error };
  pullIn(ctx);
  // Out of a fight nobody stays down: a hero who falls to the ground alone gets back up on 1 HP.
  for (const h of state.units.filter((u) => u.side === "hero" && u.down && !inFight(state, u.id))) {
    h.down = false;
    h.hp = 1;
    h.conditions = [];
    ctx.events.push({ t: "up", id: h.id });
  }
  const enc = state.encounter;
  if (enc && !settle(ctx)) {
    const waiting = enc.acting.some((id) => !enc.done.includes(id) && !unitById(state, id)?.down);
    if (!waiting) advance(ctx);
  }
  // A band beaten that carried a key: it goes on the ring.
  dropKeys(ctx);
  sweep(state);
  state.rng = ctx.rng.state();
  return { ok: true, state, events: ctx.events, effects: ctx.effects };
}
