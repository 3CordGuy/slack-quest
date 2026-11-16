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
import { ABILITIES, DRUID_REGEN, EFFECT_TICK, ENEMIES, HERO_CLASSES, abilitiesFor } from "../content";
import { tileAt } from "../map";
import type { HeroSheet } from "../hero";
import { addStats, maxFocusFor, maxHpFor } from "../progression";
import { makeRng, seedFromString } from "../rng";
import { enemyTurn } from "./ai";
import { abilityArea, checkAbility, checkCommon, checkDrink, checkThrow, doCommon, drinkItem, resolveAbility, throwItem, walk } from "./combat";
import { has, heal, removeCondition, tick, type Ctx } from "./engine";
import { ALERT_RANGE, JOIN_RANGE, freeHexNear, generateZone } from "./gen";
import { FREE_WALK, blast, inFight, pathIn, sameHex, sees, solid, unitAt, unitById, zoneReach } from "./geometry";
import { STARTING_ITEMS, THROWABLES, commonCost, enemyHp, enemyMove, tacticOf } from "./kit";
import { d20, heroMove, mod, statOf } from "./rules";
import { clearSurfaces, placeSurface, standInSurface, tickSurfaces } from "./surfaces";
import type { Budget, DevOp, Encounter, Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneHero, ZoneOptions, ZoneState, ZoneStep, ZoneView } from "./types";

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

export function createZone(code: string, seed: string, options: ZoneOptions): ZoneState {
  const plan = generateZone(seed, options);
  const state: ZoneState = { v: 1, code, seed, rng: seedFromString(`zone-run|${seed}`), options, map: plan.map, start: plan.start, units: [], groups: {}, surfaces: {}, encounter: null, seq: 0 };
  for (const group of plan.groups) {
    const id = `g${++state.seq}`;
    state.groups[id] = { alerted: false };
    group.kinds.forEach((kind, i) => state.units.push(enemyUnit(state, kind, group.posts[i], id)));
  }
  return state;
}

/** What a client is sent. */
export function zoneView(state: ZoneState, you: string): ZoneView {
  const { rng: _rng, seed: _seed, ...rest } = state;
  return { ...rest, you };
}

/** Whose turn the server is waiting on, as a key that changes when the wait does. Null out of a fight. */
export function zoneAwaiting(state: ZoneState): string | null {
  return state.encounter && state.encounter.acting.length > 0 ? `t:${state.encounter.turnNo}` : null;
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
    abilities: abilitiesFor(hero.weapon),
    outfit: hero.outfit,
    conditions: [],
    down: false,
    cooldowns: {},
    items: { ...STARTING_ITEMS },
    controller,
  };
}

/** A hero's sheet, as a zone needs it: stats with gear, and how much they can take. */
export function zoneHero(sheet: HeroSheet): ZoneHero {
  const stats = addStats(sheet.base, sheet.bonus);
  return { id: sheet.id, name: sheet.name, classId: sheet.classId, level: sheet.level, stats, weapon: sheet.weapon, weaponPower: sheet.weaponPower ?? 0, armor: sheet.armor ?? 0, outfit: sheet.outfit, maxHp: maxHpFor(stats, sheet.level), maxFocus: maxFocusFor(sheet.level) };
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

/** Roll a unit's initiative and slot it into the order: highest first, heroes ahead of enemies on a tie. */
function enter(ctx: Ctx, enc: Encounter, unit: Unit): void {
  if (enc.order.includes(unit.id)) return;
  const bonus = unit.side === "hero" ? mod(statOf(unit, "agi")) : Math.round(((ENEMIES[unit.kind]?.speed ?? 50) - 50) / 15);
  const roll = d20(ctx.rng, { kind: "initiative", id: unit.id, label: "Initiative", bonus, vs: 0, adv: 0 });
  ctx.events.push({ t: "roll", roll });
  enc.init[unit.id] = roll.total;
  const side = (id: string) => (unitById(ctx.state, id)?.side === "hero" ? 0 : 1);
  const before = (a: string, b: string) => enc.init[b] - enc.init[a] || side(a) - side(b) || a.localeCompare(b);
  const at = enc.order.findIndex((id) => before(unit.id, id) < 0);
  enc.order.splice(at < 0 ? enc.order.length : at, 0, unit.id);
  // A Warden walks into every fight with their guard up.
  if (unit.kind === "sre_warden" && !has(unit, "guarded")) unit.conditions.push({ kind: "guarded", rounds: 1 });
}

/** Heroes near anyone in the fight are in it. */
function pullIn(ctx: Ctx): void {
  const enc = ctx.state.encounter;
  if (!enc) return;
  const fighters = ctx.state.units.filter((u) => enc.order.includes(u.id) && !u.down);
  for (const hero of standing(ctx.state, "hero")) {
    if (enc.order.includes(hero.id) || !fighters.some((f) => hexDistance(f.pos, hero.pos) <= JOIN_RANGE)) continue;
    enter(ctx, enc, hero);
    ctx.events.push({ t: "fight_join", id: hero.id });
  }
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
  if (enc && !inFight(ctx.state, unit.id) && ctx.state.units.some((f) => enc.order.includes(f.id) && !f.down && hexDistance(f.pos, unit.pos) <= JOIN_RANGE)) {
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
  return true;
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
  if (!won && !lost) return false;
  state.encounter = null;
  ctx.events.push({ t: "fight_end", outcome: won ? "victory" : "defeat" });
  for (const h of heroes) {
    if (h.down) {
      h.down = false;
      h.hp = 1;
      ctx.events.push({ t: "up", id: h.id });
    }
    h.conditions = [];
    h.cooldowns = {};
  }
  if (won) {
    const xp = foes.reduce((sum, f) => sum + (ENEMIES[f.kind]?.xp ?? 0), 0);
    for (const h of heroes) if (!h.controller) ctx.effects.push({ type: "grant", heroId: h.id, xp });
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
    for (const h of heroes) h.pos = freeHexNear(state.map, state.start, (p) => !!unitAt(state, p), (p) => tileAt(state.map, p)) ?? state.start;
  }
  sweep(state);
  return true;
}

/** Clear away enemies that have fallen and are in no fight, and the groups with nobody left. */
function sweep(state: ZoneState): void {
  state.units = state.units.filter((u) => u.side === "hero" || !u.down || inFight(state, u.id));
  for (const g of Object.keys(state.groups)) if (!state.units.some((u) => u.group === g)) delete state.groups[g];
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
    let i = enc.acting.length > 0 ? Math.max(...enc.acting.map((id) => enc.order.indexOf(id))) : -1;
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
        ctx.events.push({ t: "round", n: enc.round });
        tickSurfaces(ctx);
      }
      const u = unitById(state, enc.order[i]);
      if (!u || u.down) continue;
      next.push(u);
      // Heroes one after another in the order take their turns together.
      while (u.side === "hero" && i + 1 < enc.order.length && unitById(state, enc.order[i + 1])?.side !== "enemy") {
        i += 1;
        const also = unitById(state, enc.order[i]);
        if (also && !also.down) next.push(also);
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

function dev(ctx: Ctx, by: string, op: DevOp): string | null {
  const { state } = ctx;
  const free = (near: HexPos) => freeHexNear(state.map, near, (p) => !!unitAt(state, p), (p) => tileAt(state.map, p));
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
      h.items = { ...STARTING_ITEMS };
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
  } else if (op.op === "ai") {
    state.aiOff = op.off;
  } else if (op.op === "clear_surfaces") {
    clearSurfaces(ctx, Object.keys(state.surfaces).map((key) => ({ q: Number(key.split(",")[0]), r: Number(key.split(",")[1]) })));
  }
  return null;
}

function act(ctx: Ctx, action: ZoneAction): string | null {
  const { state } = ctx;
  if (action.type === "join") {
    const hero = action.hero;
    const here = unitById(state, hero.id);
    if (here) {
      // Back again, perhaps with different gear: the sheet is refreshed, and where they stand and how hurt they are is kept.
      // Not in a fight, though: that is fought in the gear it was started in.
      if (inFight(state, here.id)) return null;
      Object.assign(here, { name: hero.name, kind: hero.classId, level: hero.level, stats: hero.stats, armor: hero.armor, power: hero.weaponPower, abilities: abilitiesFor(hero.weapon), outfit: hero.outfit, maxHp: hero.maxHp, maxFocus: hero.maxFocus });
      here.hp = Math.min(here.hp, here.maxHp);
      return null;
    }
    // Teleported to a crewmate: beside them, unless they have since got into a fight.
    const friend = action.near ? unitById(state, action.near) : undefined;
    const beside = friend && friend.side === "hero" && !inFight(state, friend.id) ? friend.pos : state.start;
    const pos = freeHexNear(state.map, beside, (p) => !!unitAt(state, p), (p) => tileAt(state.map, p));
    if (!pos) return "There is no room to arrive.";
    state.units.push(heroUnit(hero, pos));
    ctx.events.push({ t: "joined", id: hero.id });
    return null;
  }
  if (action.type === "timeout") {
    if (state.encounter) state.encounter.done = [...state.encounter.acting];
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
    const aim = { target: action.target, at: action.at, focus: !!action.focus };
    const wrong = checkAbility(state, unit, action.ability, aim);
    if (wrong) return wrong;
    if (budget && (unit.cooldowns[action.ability] ?? 0) > 0) return `${def.name} is not ready yet.`;
    if (aim.focus && unit.focus <= 0) return "You have no Focus left.";
    const cost = spend(budget, tactic.cost);
    if (cost) return cost;
    if (aim.focus) unit.focus -= 1;
    if (budget && tactic.cooldown) unit.cooldowns[action.ability] = tactic.cooldown + 1;
    // Something that takes a shape can catch a group that had not noticed anyone: it has now.
    const area = new Set(abilityArea(state, unit, action.ability, action.at).map(posKey));
    const struck = state.units.filter((u) => u.side === "enemy" && !u.down && (u.id === action.target || area.has(posKey(u.pos)))).map((u) => u.group!);
    resolveAbility(ctx, unit, action.ability, aim);
    engage(ctx, struck, unit);
    return null;
  }
  if (action.type === "common") {
    const aim = { target: action.target, at: action.at };
    const wrong = checkCommon(state, unit, action.what, aim, budget);
    if (wrong) return wrong;
    const cost = spend(budget, commonCost(action.what, unit.kind));
    if (cost) return cost;
    const shoved = action.what === "shove" ? unitById(state, action.target!)?.group : undefined;
    doCommon(ctx, unit, action.what, aim, budget);
    if (shoved) engage(ctx, [shoved], unit);
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
  // Throw.
  const wrong = checkThrow(state, unit, action.item, action.at);
  if (wrong) return wrong;
  const cost = spend(budget, "action");
  if (cost) return cost;
  const def = THROWABLES[action.item];
  const area = new Set(blast(state.map, action.at, def.radius).map(posKey));
  // A healing potion among enemies is a kindness; anything else is a declaration.
  const struck = def.heal ? [] : state.units.filter((u) => u.side === "enemy" && !u.down && area.has(posKey(u.pos))).map((u) => u.group!);
  throwItem(ctx, unit, action.item, action.at);
  engage(ctx, struck, unit);
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
  sweep(state);
  state.rng = ctx.rng.state();
  return { ok: true, state, events: ctx.events, effects: ctx.effects };
}
