// The zone reducer. stepZone(state, action) is pure and seeded: it returns
// the next state, what happened (for the client to show) and what the
// server must carry out.
//
// Out of a fight everyone walks freely, at once. A hero who comes within
// sight of an enemy group starts one: the group and every hero near it
// roll initiative, and from then on those in the fight take turns while
// everyone else keeps walking. Walk near the fight and you are in it.
//
// A turn is Action Points (AP): AP_TURN more at its start, on top of any saved
// from the last (AP_MAX at most), spent on anything in any order, movement too.
// And it is one fighter's alone: nobody shares a place in the order (two who
// roll the same initiative roll off for it). Enemy turns are played here,
// at once, so nothing waits on a client. A fight is heard: at the start of
// each round, any band near enough to hear it comes to join it.
//
// Nothing is put in anyone's pack for them. The fallen lie where they
// fell, chests stand open, and a cleared place's spoils are heaped on the
// ground, each to be walked up to and taken from (loot.ts).

import { STARTING_STATS, hexDistance, hexNeighbors, posKey, type HexPos } from "@gantt-quest/core";
import { classAbilitiesOf, poolFor, withClassAbilities } from "../classabilities";
import { ABILITIES, DRUID_REGEN, EFFECT_TICK, ENEMIES, HERO_CLASSES, WEAPONS, abilitiesFor } from "../content";
import { weaponItem } from "../gear";
import { tileAt } from "../map";
import type { HeroSheet } from "../hero";
import { addStats, maxFocusFor, maxHpFor } from "../progression";
import { makeRng, seedFromString } from "../rng";
import { enemyTurn } from "./ai";
import { abilityArea, checkAbility, checkCommon, checkDrink, checkLight, checkThrow, courseFor, doCommon, drinkItem, moveLeft, resolveAbility, throwItem, walk } from "./combat";
import { burnOf, has, heal, regrow, removeCondition, tick, unseen, type Ctx } from "./engine";
import { ALERT_RANGE, JOIN_RANGE, freeHexNear, generateZone } from "./gen";
import { generateDelve } from "./delve";
import { checkLoot, checkOpen, leaveBody, look, lootFor, openChest, payBounty, take } from "./loot";
import { isCrateId } from "./crates";
import { siteOpen } from "./sites";
import { FREE_WALK, blast, blockerAt, inFight, pathIn, sameHex, sees, solid, unitAt, unitById, zoneReach } from "./geometry";
import { AP_MAX, AP_TURN, SUMMON_AP_TURN, AURAS, ENEMY_MOVE_AP, FLEE_RANGE, ITEM_AP, SUMMONS, STARTING_ITEMS, THROWABLES, THROWABLE_KINDS, cleanItems, commonCost, enemyHp, enemyMove, tacticOf } from "./kit";
import { d20, heroMove, mod, rollDice, statOf } from "./rules";
import { hiddenEnemies, sentToClient } from "./light";
import { tickWeather, weatherAtTurn } from "./weather";
import { checkPickup, checkStow, clearSurfaces, lightTorch, pickUpTorch, placeSurface, stowTorch, standInSurface, tickLights, tickSurfaces } from "./surfaces";
import { exploreRound, passTime } from "./clock";
import { checkUnlock, dropKeys, heardBy, workDoor } from "./doors";
import { checkForage, forage } from "./forage";
import { dismiss } from "./summon";
import { drown, drowningAtStart, drowningOwed, holdBreath } from "./drowning";
import { shantyOf, songMove, windward } from "./song";
import { courseMarks } from "./stars";
import { modsOf } from "./mods";
import type { Budget, DevOp, Encounter, Throwable, Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneHero, ZoneOptions, ZoneState, ZoneStep, ZoneView } from "./types";

/** Rounds a surface painted from the dev toolbox lasts. */
const PAINT_ROUNDS = 6;

// ---------- making a zone ----------

function enemyUnit(state: ZoneState, kind: string, pos: HexPos, group: string): Unit {
  const hp = Math.round(enemyHp(kind, state.options.level, state.options.threat) * modsOf(state.options).hp);
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
  const state: ZoneState = { v: 1, code, seed, rng: seedFromString(`zone-run|${seed}`), options, map: plan.map, start: plan.start, units: [], groups: {}, surfaces: { ...(plan.surfaces ?? {}) }, encounter: null, seq: 0 };
  if (plan.keys && plan.keys.length > 0) state.keyHolders = [...plan.keys];
  if (plan.scene) state.scene = { ...plan.scene };
  for (const group of plan.groups) {
    const id = group.id ?? `g${++state.seq}`;
    state.groups[id] = { alerted: false };
    group.kinds.forEach((kind, i) => state.units.push(enemyUnit(state, kind, group.posts[i], id)));
  }
  ensureMouth(state);
  return state;
}

/**
 * What a client is sent. `hidden` is who the dark hides (light.ts hiddenEnemies): it is the same whoever is being
 * told, and in a cave it takes going over every tile, so a caller with one state to send to several works it out
 * once and hands it in each time.
 */
export function zoneView(state: ZoneState, you: string, hidden: readonly string[] = hiddenEnemies(state)): ZoneView {
  const { rng: _rng, seed: _seed, loot: _loot, ...rest } = state;
  // Of what there is to loot: what is everyone's (a body, a chest) as it stands, and of the spoils only the share of the one being told.
  const loot = lootFor(state, you);
  const mine = loot ? { loot } : {};
  if (hidden.length === 0) return { ...rest, ...mine, you };
  // What the dark hides is not sent at all, unless it is in a fight: then it keeps its place in the order, marked.
  const fighting = hidden.filter((id) => inFight(state, id));
  return { ...rest, ...mine, units: rest.units.filter(sentToClient(state, new Set(hidden))), you, ...(fighting.length > 0 ? { dark: fighting } : {}) };
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
    ...(hero.lantern ? { lantern: true } : {}),
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
    ...(sheet.lantern ? { lantern: true } : {}),
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
 * Two who rolled the same initiative do not share a place in the order: they roll off for it, a plain d20 each, and
 * again should those come up the same. `unit` has just rolled; whoever already holds its number and has not yet had
 * to roll off rolls now too. What each rolled is kept (Encounter.tie): the higher goes first.
 */
function rollOff(ctx: Ctx, enc: Encounter, unit: Unit): void {
  // (What a hero called has its caller's number, and no roll of its own: it goes where they go, below.)
  const same = Object.keys(enc.init).filter((id) => id !== unit.id && enc.init[id] === enc.init[unit.id] && !unitById(ctx.state, id)?.summon);
  if (same.length === 0) return;
  const tie = (enc.tie ??= {});
  const roll = (id: string) => {
    for (let tries = 0; tries < 30; tries++) {
      const r = d20(ctx.rng, { kind: "initiative", id, label: "Tie-break", bonus: 0, vs: 0, adv: 0 });
      ctx.events.push({ t: "roll", roll: r });
      // The same again as someone it is tied with: once more.
      if ([...same, unit.id].some((o) => o !== id && tie[o] === r.total)) continue;
      tie[id] = r.total;
      return;
    }
    tie[id] = 0;
  };
  for (const id of same) if (tie[id] === undefined) roll(id);
  roll(unit.id);
  // What a hero called stands just behind them still, whatever they rolled off.
  for (const u of ctx.state.units) {
    const caller = u.summon?.by;
    if (caller && enc.init[u.id] !== undefined && tie[caller] !== undefined) tie[u.id] = tie[caller] - 0.01 * (1 + ctx.state.units.filter((o) => o.summon?.by === caller).indexOf(u));
  }
}

/**
 * Roll a unit's initiative and slot it into the order: highest first, and on a tie whoever wins the roll-off
 * (rollOff). One coming back into a fight they fled has the place they had: no fresh roll, so no fresh turn out
 * of getting away and back.
 */
function enter(ctx: Ctx, enc: Encounter, unit: Unit): void {
  if (enc.order.includes(unit.id)) return;
  if (enc.init[unit.id] === undefined) {
    const bonus = unit.side === "hero" ? mod(statOf(unit, "agi")) : Math.round(((ENEMIES[unit.kind]?.speed ?? 50) - 50) / 15);
    const roll = d20(ctx.rng, { kind: "initiative", id: unit.id, label: "Initiative", bonus, vs: 0, adv: 0 });
    ctx.events.push({ t: "roll", roll });
    enc.init[unit.id] = roll.total;
    rollOff(ctx, enc, unit);
  }
  const before = (a: string, b: string) => enc.init[b] - enc.init[a] || (enc.tie?.[b] ?? 0) - (enc.tie?.[a] ?? 0) || a.localeCompare(b);
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
  if (enc.banked) delete enc.banked[unit.id];
  const acting = enc.acting.includes(unit.id);
  enc.acting = enc.acting.filter((id) => id !== unit.id);
  enc.done = enc.done.filter((id) => id !== unit.id);
  // The turn was theirs alone: the next goes to whoever came after them.
  if (acting && enc.acting.length === 0) enc.resume = enc.order[at] ?? null;
  enc.fled = [...(enc.fled ?? []), unit.id];
  enc.waits = [...(enc.waits ?? []), unit.id];
  endTurn(ctx, unit);
  ctx.events.push({ t: "fled", id: unit.id });
}

/**
 * Enemy groups have noticed someone: they are in a fight. One starts if none is on, and in the open that rouses the
 * rest of the place (rouse). `quiet`: they come as one crowd, and are not each announced.
 */
function engage(ctx: Ctx, groups: string[], by: Unit, quiet = false): void {
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
    if (!starting && !quiet) ctx.events.push({ t: "fight_join", id: u.id });
  }
  pullIn(ctx);
  if (starting) rouse(ctx);
}

/** How far a band will come to a fight it was roused to, in movement: further than any map is across, short of for ever. */
const ROUSE_REACH = 400;

/** Whether a fight here is everyone's business: an open-air place (zone/sites.ts), where a shout carries to all of it. */
const open = (state: ZoneState) => !!state.scene && siteOpen(state.scene.site);

/**
 * A fight in the open rouses the whole place: every band that has noticed nobody is in it from now on, and comes.
 * Two kinds stay where they are, because coming would make no sense: a band with no way to the fight on foot (shut
 * in behind a locked door, or on ground nothing joins to it), and a band with a boss in it, which keeps its den and
 * waits (it still comes if the fight is near enough to hear: reinforce). "A way" is a matter of the ground alone:
 * whoever is standing in a doorway or on a bridge just now does not make it no way. Under a roof, or under ground, nothing is
 * roused: walls keep the noise in, and only those near enough to hear come. Called when a fight starts and as each
 * round begins, so a band let out by an opened door comes then.
 */
function rouse(ctx: Ctx): void {
  const { state } = ctx;
  const enc = state.encounter;
  if (!enc || !open(state)) return;
  const fighters = state.units.filter((u) => enc.order.includes(u.id) && !u.down);
  const hero = fighters.find((u) => u.side === "hero");
  if (!hero) return;
  const bands = new Map<string, Unit[]>();
  for (const e of standing(state, "enemy")) {
    if (!e.group || state.groups[e.group]?.alerted) continue;
    bands.set(e.group, [...(bands.get(e.group) ?? []), e]);
  }
  // Where getting to counts as getting to the fight: the hex of anyone in it, or one beside.
  const near = new Set(fighters.flatMap((f) => [f.pos, ...hexNeighbors(f.pos, state.map.grid)]).map(posKey));
  const coming: string[] = [];
  for (const [group, members] of bands) {
    if (members.some((m) => ENEMIES[m.kind]?.boss)) continue;
    // One of them that can get to anyone in the fight is enough: the rest follow. Over the ground as it lies, with nobody standing on it.
    const ground = { ...state, units: [] };
    const way = members.some((m) => {
      // Whether any such hex is reached is all that is asked, so the flood stops at the first (zoneReach `enough`).
      const reach = zoneReach(ground, m, ROUSE_REACH, undefined, undefined, (r) => near.has(posKey(r.pos)));
      return fighters.some((f) => reach.has(posKey(f.pos)) || hexNeighbors(f.pos, state.map.grid).some((n) => reach.has(posKey(n))));
    });
    if (way) coming.push(group);
  }
  if (coming.length === 0) return;
  ctx.events.push({ t: "roused", groups: coming, units: coming.flatMap((g) => bands.get(g)!.map((u) => u.id)) });
  engage(ctx, coming, hero, true);
}

/** How near a fight a band has to be to hear it: at the start of each round, one that near comes to join it. */
export const HEAR_RANGE = 5;

/**
 * A fight is heard. Any band that has noticed nobody, with one of its own within HEAR_RANGE of someone still
 * standing in the fight, turns on the party: it is in the fight from now on. Called as each new round begins.
 */
function reinforce(ctx: Ctx): void {
  const { state } = ctx;
  const enc = state.encounter;
  if (!enc) return;
  rouse(ctx);
  const fighters = state.units.filter((u) => enc.order.includes(u.id) && !u.down);
  const hero = fighters.find((u) => u.side === "hero");
  if (!hero) return;
  const heard = new Set<string>();
  for (const e of standing(state, "enemy")) {
    if (!e.group || state.groups[e.group]?.alerted || heard.has(e.group)) continue;
    if (fighters.some((f) => hexDistance(f.pos, e.pos) <= HEAR_RANGE)) heard.add(e.group);
  }
  for (const group of heard) ctx.events.push({ t: "noise", group });
  if (heard.size > 0) engage(ctx, [...heard], hero);
}

/** The groups, not yet alerted, with someone who can see `unit` from close by. */
function noticedBy(state: ZoneState, unit: Unit): string[] {
  const out = new Set<string>();
  // Nobody notices the Unseen creeping past.
  if (unseen(unit)) return [];
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
  removeCondition(unit, "guarded");
  removeCondition(unit, "taunting");
  // A Lively Shanty's lift from those who joined it lasts until its Bard's turn comes round again.
  const song = shantyOf(unit);
  if (song) song.surge = 0;
  for (const kind of ["bleeding", "burning"] as const) if (has(unit, kind)) tick(ctx, unit, kind, kind === "burning" ? burnOf(unit) : (EFFECT_TICK[kind] ?? 0));
  if (unit.down) return false;
  // A Druid mends a little every turn.
  if (unit.kind === "backend_druid" && unit.hp < unit.maxHp) heal(ctx, unit, DRUID_REGEN, { actor: unit.id, what: "regen" });
  // A Healing Aura mends the bearer and everyone of theirs standing beside them.
  if (has(unit, "mending")) {
    for (const u of ctx.state.units) {
      if (u.side === unit.side && !u.down && u.hp < u.maxHp && hexDistance(u.pos, unit.pos) <= AURAS.range) heal(ctx, u, rollDice(ctx.rng, AURAS.heal), { actor: unit.id, what: "healing_aura" });
    }
  }
  // Aqueous Regeneration comes again.
  regrow(ctx, unit);
  // A troll's wounds close at the start of each of its turns, unless it is on fire.
  const grows = unit.side === "enemy" ? ENEMIES[unit.kind]?.regen : undefined;
  if (grows && unit.hp < unit.maxHp && !has(unit, grows.unless)) heal(ctx, unit, grows.amount, { actor: unit.id, what: grows.name });
  standInSurface(ctx, unit);
  // Drowning takes its toll (the Curse of Drowning first, for a turn started in water).
  drowningAtStart(ctx, unit);
  if (unit.down) return false;
  if (has(unit, "stunned")) {
    removeCondition(unit, "stunned");
    ctx.events.push({ t: "skip", id: unit.id, kind: "stunned" });
    return false;
  }
  // What 1 AP of movement buys it.
  const base = unit.summon ? (SUMMONS[unit.kind]?.move ?? 1) : unit.side === "hero" && unit.stats ? heroMove(unit.stats) : enemyMove(unit.kind, modsOf(ctx.state.options).move);
  // A Wind-god's Shanty: further, and no Slowing.
  const sung = base > 0 ? songMove(ctx.state, unit) : 0;
  // A Tailwind given since its last turn: the wind at its back.
  let stride = base > 0 ? base + sung + (unit.conditions.find((c) => c.kind === "tailwind")?.amount ?? 0) : 0;
  if (has(unit, "slowed") && windward(ctx.state, unit)) removeCondition(unit, "slowed");
  if (has(unit, "slowed") && stride > 0) stride = Math.max(1, Math.floor(stride / 2));
  if (has(unit, "hasted")) stride *= 2;
  // Fresh AP on top of what was saved from its last turn.
  let ap = Math.min(AP_MAX, (enc.banked?.[unit.id] ?? 0) + (unit.summon ? SUMMON_AP_TURN : AP_TURN));
  if (enc.banked) delete enc.banked[unit.id];
  // Getting up off the ground takes an AP.
  if (has(unit, "prone")) {
    removeCondition(unit, "prone");
    ap -= 1;
  }
  enc.budgets[unit.id] = { ap, move: 0, stride, disengaged: false, ...(sung > 0 ? { song: sung } : {}) };
  // An enemy puts only so much of a turn into getting about.
  if (unit.side === "enemy" && !unit.summon) enc.budgets[unit.id].walk = ENEMY_MOVE_AP;
  // A course charted by one of its side: further, on the steps that bring it nearer the mark.
  if (courseMarks(ctx.state, unit).length > 0) enc.budgets[unit.id].course = 0;
  // Weather it stands in acts now its turn is underway, with a budget for the winds to change.
  weatherAtTurn(ctx, unit);
  // Drowning: hold its breath, or lose some of its AP.
  holdBreath(ctx, unit, enc.budgets[unit.id]);
  return !unit.down;
}

/**
 * End a unit's turn: each cooldown and each condition has one turn less to run, bar conditions put on during this very turn.
 * Then the stacks of Drowning it is owed for how it ended the turn (drowning.ts), each running its full count.
 */
function endTurn(ctx: Ctx, unit: Unit): void {
  for (const key of Object.keys(unit.cooldowns)) {
    unit.cooldowns[key] -= 1;
    if (unit.cooldowns[key] <= 0) delete unit.cooldowns[key];
  }
  const owed = drowningOwed(ctx.state, unit);
  for (const c of unit.conditions) {
    if (c.fresh) c.fresh = false;
    else c.rounds -= 1;
  }
  unit.conditions = unit.conditions.filter((c) => c.rounds > 0);
  drown(ctx, unit, owed);
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
  // A creature called into the fight is no hero: it neither holds a lost fight off nor keeps a fled one going.
  const heroes = fighters.filter((u) => u.side === "hero" && !u.summon);
  const foes = fighters.filter((u) => u.side === "enemy");
  const won = foes.every((u) => u.down);
  const lost = !won && heroes.length > 0 && heroes.every((u) => u.down);
  const fled = !won && heroes.length === 0;
  if (!won && !lost && !fled) return false;
  ctx.events.push({ t: "fight_end", outcome: won ? "victory" : lost ? "defeat" : "fled" });
  // What was called into it goes with it.
  for (const u of state.units.filter((x) => x.summon)) dismiss(ctx, u);
  state.encounter = null;
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
    // Every hero who fought takes the whole XP. A stand-in takes nothing. What the fallen had on them stays on
    // them: they lie where they fell, to be searched (loot.ts).
    // On a map the atlas made, the fallen are worth more the higher their level, as they took more killing.
    const worth = (f: Unit) => (ENEMIES[f.kind]?.xp ?? 0) * (state.options.tier ? 1 + 0.15 * Math.max(0, f.level - 1) : 1);
    const xp = Math.round(foes.reduce((sum, f) => sum + worth(f), 0));
    for (const h of heroes) {
      if (h.controller) continue;
      ctx.effects.push({ type: "grant", heroId: h.id, xp, resources: {} });
      ctx.events.push({ t: "spoils", id: h.id, xp, resources: {} });
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
    // (Not one lost to a pit: it is gone for good, win or lose.)
    const band = state.units.filter((u) => u.side === "enemy" && groups.has(u.group) && !u.lost);
    const was = new Map(band.map((f) => [f.id, f.pos]));
    // Off the board for a moment: the enemy, so each finds its own post, or the nearest free hex if someone
    // not in the fight stands on it (a body takes up no room, so its post may have been walked onto); and
    // the heroes, so each finds its own free hex by the start.
    for (const f of band) {
      f.down = false;
      f.hp = f.maxHp;
      f.conditions = [];
      f.pos = { q: -99, r: -99 };
    }
    for (const h of heroes) {
      h.hp = 1;
      h.pos = { q: -99, r: -99 };
    }
    for (const f of band) {
      const post = f.home ?? was.get(f.id)!;
      f.pos = freeHexNear(state.map, post, (p) => !!unitAt(state, p) || blockerAt(state, p), (p) => tileAt(state.map, p)) ?? post;
    }
    for (const h of heroes) h.pos = freeHexNear(state.map, state.start, (p) => !!unitAt(state, p) || blockerAt(state, p), (p) => tileAt(state.map, p)) ?? state.start;
  }
  sweep(state);
  if (won && !state.units.some((u) => u.side === "enemy")) {
    ctx.events.push({ t: "cleared" });
    payBounty(ctx, heroes.find((h) => !h.controller && !h.down) ?? heroes[0]);
  }
  return true;
}

/**
 * Clear away enemies that have fallen and are in no fight, and the groups with nobody left. Each lies where it
 * fell from then on, as a body to be searched (loot.ts leaveBody).
 */
function sweep(state: ZoneState): void {
  const stays = (u: Unit) => u.side === "hero" || !u.down || inFight(state, u.id);
  for (const u of state.units) if (!stays(u)) leaveBody(state, u);
  state.units = state.units.filter(stays);
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
      if (u) endTurn(ctx, u);
      // What AP it has not spent it keeps for its next turn (the movement it bought and did not walk is lost).
      const left = enc.budgets[id]?.ap ?? 0;
      if (left > 0 && u && !u.down) enc.banked = { ...enc.banked, [id]: Math.min(AP_MAX, left) };
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
        // The noise carries: whoever is near enough to hear the fight comes to it.
        reinforce(ctx);
      }
      // One back in after fleeing on their turn this round waits for the next.
      const waiting = (u: Unit | undefined) => !u || u.down || !!enc.waits?.includes(u.id);
      const u = unitById(state, enc.order[i]);
      if (waiting(u)) continue;
      // A turn is one fighter's alone.
      next.push(u!);
      // (Unless the tests' switch is on: then heroes one after another in the order take their turns together.)
      while (state.shareTurns && u!.side === "hero" && i + 1 < enc.order.length && unitById(state, enc.order[i + 1])?.side !== "enemy") {
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

/**
 * Spent out: no AP left, and no movement bought with it still to walk. A unit's turn ends on its own once it is, after
 * whatever it did has played out in full (stepZone), so nobody has to press End turn with nothing left to do.
 */
export const spentOut = (budget: Budget): boolean => budget.ap <= 0 && budget.move < 1 && (budget.course ?? 0) < 1;

/** Take `cost` AP from the budget, if there is one (out of a fight everything is free), or say why not. */
function spend(budget: Budget | null, cost: number): string | null {
  if (!budget) return null;
  if (budget.ap < cost) return `That takes ${cost} AP, and you have ${budget.ap} left.`;
  budget.ap -= cost;
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
    if (!u || u.side !== "hero" || u.summon || (u.id !== by && u.controller !== by)) return "That is not one of your heroes.";
    const weapon = WEAPONS[op.weapon];
    if (!weapon || (weapon.classId && weapon.classId !== op.classId)) return "That is not a weapon of that class.";
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
      Object.assign(here, { name: hero.name, kind: hero.classId, level: hero.level, stats: hero.stats, armor: hero.armor, power: hero.weaponPower, outfit: hero.outfit, lantern: hero.lantern, maxHp: hero.maxHp, maxFocus: hero.maxFocus });
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
    // Only the hex asked for and the way to it are read, so the flood stops at it (zoneReach `enough`).
    const reach = zoneReach(state, unit, budget ? moveLeft(budget) : FREE_WALK, undefined, courseFor(state, unit, budget), (r) => sameHex(r.pos, action.to));
    const end = reach.get(posKey(action.to));
    if (!end) return budget ? "You cannot get there with the AP you have left." : "You cannot get there.";
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
    // Something that takes a shape can catch a group that had not noticed anyone: it has now. A mark on the map touches nobody.
    const area = new Set(tactic.chart ? [] : abilityArea(state, unit, action.ability, action.at, action.target).map(posKey));
    const touched = state.units.filter((u) => u.id === action.target || area.has(posKey(u.pos)));
    const back = reachBack(state, unit, touched);
    if (back) return back;
    if (budget && (unit.cooldowns[action.ability] ?? 0) > 0) return `${def.name} is not ready yet.`;
    if (aim.focus && unit.focus <= 0) return "You have no Focus left.";
    const cost = spend(budget, tactic.cost);
    if (cost) return cost;
    if (aim.focus) unit.focus -= 1;
    if (budget && tactic.cooldown) unit.cooldowns[action.ability] = tactic.cooldown;
    // A heal splashed among enemies is a kindness, as a healing potion thrown is: it starts nothing.
    const struck = tactic.splash ? [] : touched.filter((u) => u.side === "enemy" && !u.down).map((u) => u.group!);
    resolveAbility(ctx, unit, action.ability, aim);
    engage(ctx, struck, unit);
    reachIn(ctx, unit, touched);
    // Cast out of a fight, one with a wait on it that draws the caster into a fight goes in waiting, as if spent on their first turn (their AP are whole).
    if (!budget && tactic.cooldown && state.encounter?.order.includes(unit.id)) unit.cooldowns[action.ability] = tactic.cooldown;
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
    const cost = spend(budget, ITEM_AP.drink);
    if (cost) return cost;
    drinkItem(ctx, unit, action.item);
    return null;
  }
  if (action.type === "pickup") {
    const wrong = checkPickup(state, unit, action.at);
    if (wrong) return wrong;
    // Out of a fight it is free; in one, it takes AP, like lighting one.
    const cost = spend(budget, ITEM_AP.pickup);
    if (cost) return cost;
    pickUpTorch(ctx, unit, action.at);
    return null;
  }
  if (action.type === "open") {
    const chest = state.map.pois.find((p) => p.id === action.poi && p.kind === "cache");
    const wrong = checkOpen(state, unit, chest);
    if (wrong) return wrong;
    const cost = spend(budget, ITEM_AP.open);
    if (cost) return cost;
    openChest(ctx, unit, chest!);
    // Out of a fight, whoever opened it is looking into it.
    const spot = state.loot?.find((s) => s.id === chest!.id);
    if (spot && !checkLoot(state, unit, spot)) {
      look(ctx, unit, spot);
      ctx.events.push({ t: "looked", id: unit.id, spot: spot.id });
    }
    return null;
  }
  if (action.type === "loot" || action.type === "take") {
    const spot = state.loot?.find((s) => s.id === action.spot);
    const wrong = checkLoot(state, unit, spot);
    if (wrong) return wrong;
    if (action.type === "take") return take(ctx, unit, spot!, { index: action.index, uid: action.uid });
    look(ctx, unit, spot!);
    ctx.events.push({ t: "looked", id: unit.id, spot: spot!.id });
    return null;
  }
  if (action.type === "forage") {
    const patch = state.map.pois.find((p) => p.id === action.poi && p.kind === "glowcap");
    const wrong = checkForage(state, unit, patch);
    if (wrong) return wrong;
    const cost = spend(budget, ITEM_AP.forage);
    if (cost) return cost;
    forage(ctx, unit, patch!);
    return null;
  }
  if (action.type === "unlock") {
    const door = state.map.pois.find((p) => p.id === action.poi && p.kind === "gate");
    const wrong = checkUnlock(state, unit, door);
    if (wrong) return wrong;
    const cost = spend(budget, ITEM_AP.unlock);
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
    const cost = spend(budget, ITEM_AP.light);
    if (cost) return cost;
    lightTorch(ctx, unit, action.hand);
    return null;
  }
  if (action.type === "stow") {
    const wrong = checkStow(unit);
    if (wrong) return wrong;
    // Like lighting one: free out of a fight, AP in one.
    const cost = spend(budget, ITEM_AP.stow);
    if (cost) return cost;
    stowTorch(ctx, unit);
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
  const cost = spend(budget, ITEM_AP.throw);
  if (cost) return cost;
  // A healing potion among enemies is a kindness; anything else is a declaration.
  const struck = def.heal ? [] : touched.filter((u) => u.side === "enemy" && !u.down).map((u) => u.group!);
  throwItem(ctx, unit, action.item, action.at);
  engage(ctx, struck, unit);
  reachIn(ctx, unit, touched);
  return null;
}

export function stepZone(prev: ZoneState, action: ZoneAction): ZoneStep {
  // Everything is copied but the map's tiles, which are most of a state's weight: no step changes a tile where it
  // lies (a door that opens is given a new array with a new tile in it: doors.ts), so the next state can share them,
  // and what is reckoned once from them (map.ts tilesByKey, geometry.ts sightBlockers) is kept from step to step.
  const state: ZoneState = structuredClone({ ...prev, map: { ...prev.map, tiles: [] } });
  state.map.tiles = prev.map.tiles;
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
    // Its last AP spent, the unit that acted has had its turn.
    const id = "unit" in action ? action.unit : undefined;
    const left = id ? enc.budgets[id] : undefined;
    if (id && left && enc.acting.includes(id) && !enc.done.includes(id) && spentOut(left)) enc.done.push(id);
    const waiting = enc.acting.some((id) => !enc.done.includes(id) && !unitById(state, id)?.down);
    if (!waiting) advance(ctx);
  }
  // A called creature that has fallen is gone.
  for (const u of state.units.filter((x) => x.summon && x.down)) dismiss(ctx, u);
  // A band beaten that carried a key: it goes on the ring.
  dropKeys(ctx);
  sweep(state);
  state.rng = ctx.rng.state();
  return { ok: true, state, events: ctx.events, effects: ctx.effects };
}
