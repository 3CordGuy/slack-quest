// What units do: walk (and get struck at as they leave an enemy's reach),
// use an ability, take one of the common actions, throw something, and,
// for an enemy, make one of its attacks. Each has a check, which says in
// words why it cannot be done, and the doing. Costs and turns are the
// reducer's business (zone.ts); nothing here spends an Action. A hero's
// blows, blasts and bombs reach crates too (crates.ts).

import { hexDistance, hexNeighbors, hexSegment, posKey, type HexPos } from "@gantt-quest/core";
import { ABILITIES, ARMOR_DAMAGE_DIVISOR, BARD_AURA, WARLOCK_BLEED_TURNS, type AbilityDef, type EffectKind } from "../content";
import { tileAt, type Poi } from "../map";
import { DEBUFFS, addCondition, addShield, attackContext, attackRoll, damage, defenceOf, giveAway, has, heal, inWater, kindle, removeCondition, saveBonus, saveRoll, shieldOf, shieldUnit, unseen, type Ctx } from "./engine";
import { cratesOn, crateById, hurtCrate, isCrateId } from "./crates";
import { HEX_DIRS, adjacent, blast, blockerAt, courseShare, directionToward, elevOf, inFight, lineFrom, pathIn, sameHex, sees, seesFor, solid, stepCost, unitAt, unitById, zoneReach, type Course } from "./geometry";
import { CHART, COMMON_ACTIONS, CORAL_ARMOR, SHANTY, SUMMON_CALLS, ENEMY_BURST, FLEE_RANGE, JUMP_MOVE_COST, POTION_EDGE, SAVE_STAT, SMUGGLED, THROWABLES, TORCH_GROUND_ROUNDS, abilityDice, enemyStrikes, healDice, jumpRange, reactionStrike, tacticOf, throwRange, type EnemyStrike, type Tactic } from "./kit";
import { d20, diceFor, hitChance, mod, proficiency, rollDice, statOf } from "./rules";
import { seenByHeroes } from "./light";
import { HINDERING, chill, clearSurfaces, dropTorch, enterSurface, ignite, letGoTorch, placeSurface } from "./surfaces";
import type { Budget, CommonAction, Throwable, Unit, ZoneState } from "./types";
import { clusterHexes, enterWeather, makeWeather, rainHexes, wallHexes } from "./weather";
import { summonCall, summonSpots } from "./summon";
import { layCurse } from "./drowning";
import { SHANTIES, joinable, shantyOf, songDamage, songMove, windward } from "./song";
import { constellationHexes, constellationLinks, courseMarks, litFoes } from "./stars";

/** How near a Bard has to be for their tune to help. */
export const BARD_AURA_RANGE = 3;
/** What a thrown bomb's blast is saved against. */
const THROW_SAVE = 12;

export interface Aim {
  target?: string;
  at?: HexPos;
}

// ---------- walking ----------

/**
 * Enemies beside `unit` that it is about to step out of reach of strike at it, if they still have
 * their reaction. Disengaged, it slips away untouched.
 */
function provoke(ctx: Ctx, unit: Unit, next: HexPos, budget: Budget | null, flush: () => void): void {
  const enc = ctx.state.encounter;
  // Nobody strikes at what they cannot see.
  if (!enc || !inFight(ctx.state, unit.id) || budget?.disengaged || unseen(unit)) return;
  for (const foe of ctx.state.units) {
    if (unit.down) return;
    if (foe.side === unit.side || foe.down || !inFight(ctx.state, foe.id)) continue;
    if (!adjacent(foe.pos, unit.pos) || adjacent(foe.pos, next) || sameHex(foe.pos, next)) continue;
    if (enc.reacted.includes(foe.id) || has(foe, "stunned") || has(foe, "prone")) continue;
    const blow = foe.side === "enemy" ? enemyStrikes(foe.kind, foe.level, ctx.state.options.threat).find((s) => s.range === 1 && !s.burst) : undefined;
    if (foe.side === "enemy" && !blow) continue;
    flush();
    enc.reacted.push(foe.id);
    ctx.events.push({ t: "reaction", id: foe.id, target: unit.id });
    if (blow) enemyAct(ctx, foe, blow, unit);
    else {
      const ability = reactionStrike(foe.abilities);
      strike(ctx, foe, ABILITIES[ability], tacticOf(ability), unit, {});
    }
  }
}

/** If someone else is on a unit's hex (it was stopped part-way past an ally), it shuffles to the nearest free one. */
function standClear(ctx: Ctx, unit: Unit): void {
  if (!ctx.state.units.some((u) => u.id !== unit.id && sameHex(u.pos, unit.pos))) return;
  const seen = new Set([posKey(unit.pos)]);
  const queue = [unit.pos];
  for (let i = 0; i < queue.length && i < 60; i++) {
    for (const n of hexNeighbors(queue[i], ctx.state.map.grid)) {
      if (seen.has(posKey(n))) continue;
      seen.add(posKey(n));
      if (solid(tileAt(ctx.state.map, n)) || blockerAt(ctx.state, n)) continue;
      if (!unitAt(ctx.state, n)) {
        unit.pos = n;
        ctx.events.push({ t: "moved", id: unit.id, path: [n] });
        return;
      }
      queue.push(n);
    }
  }
}

/**
 * Walk a unit along a path, a step at a time. Each step may draw an opportunity attack, costs
 * movement (when there is a budget), and lands the unit on whatever the ground holds. The walk
 * stops when the unit falls, slips, runs out of movement, or walks into a fight.
 */
export function walk(ctx: Ctx, unit: Unit, path: HexPos[], budget: Budget | null): void {
  let taken: HexPos[] = [];
  // A course charted: steps nearer a mark spend its movement first.
  const course = courseFor(ctx.state, unit, budget);
  const flush = () => {
    if (taken.length > 0) ctx.events.push({ t: "moved", id: unit.id, path: taken });
    taken = [];
  };
  for (const next of path) {
    if (unit.down) break;
    const step = stepCost(ctx.state, unit, unit.pos, next);
    const share = course ? courseShare(course, unit.pos, next, step.cost) : 0;
    if (!Number.isFinite(step.cost) || (budget && step.cost - share > budget.move)) break;
    provoke(ctx, unit, next, budget, flush);
    if (unit.down) break;
    unit.pos = next;
    if (budget) budget.move -= step.cost - share;
    if (course && share > 0) course.left = budget!.course = course.left - share;
    taken.push(next);
    if (enterSurface(ctx, unit, flush) || unit.down) break;
    enterWeather(ctx, unit);
    if (ctx.onStep?.(unit, flush)) break;
  }
  flush();
  standClear(ctx, unit);
}

/** The course charted for `unit` to walk this turn, if one is and it has some of its movement left: zoneReach and walk spend it. */
export function courseFor(state: ZoneState, unit: Unit, budget: Budget | null | undefined): Course | undefined {
  if (!budget?.course) return undefined;
  const marks = courseMarks(state, unit);
  return marks.length > 0 ? { marks, left: budget.course } : undefined;
}

/** Knock `target` one hex directly away from `from`. Against a wall, a cliff or another body it takes a knock and falls Prone instead. */
export function push(ctx: Ctx, from: HexPos, target: Unit, by: string): void {
  const dir = directionToward(from, target.pos);
  const dest = { q: target.pos.q + dir.q, r: target.pos.r + dir.r };
  const open = openFor(ctx.state, target.pos, dest);
  const was = target.pos;
  if (!open) {
    ctx.events.push({ t: "shoved", id: by, target: target.id, from: was, to: null });
    damage(ctx, target, ctx.rng.int(1, 4), { actor: by, what: "shove" });
    addCondition(ctx, target, "prone", 1);
    return;
  }
  target.pos = dest;
  ctx.events.push({ t: "shoved", id: by, target: target.id, from: was, to: dest });
  enterSurface(ctx, target);
  enterWeather(ctx, target);
}

/**
 * Overwhelm: Strength against the target's footing (as a Shove). Won, it is driven straight back from the user, a hex at a time,
 * up to `hexes`. Driven into what nobody can pass (rock, a wall, a chest, a cliff, the map's edge) it is Stunned; into somebody
 * else, it just stops. Returns whether the contest was won.
 */
function overwhelm(ctx: Ctx, unit: Unit, def: AbilityDef, target: Unit, opts: { hexes: number; stun: number }): boolean {
  const { state } = ctx;
  const roll = d20(ctx.rng, { kind: "shove", id: unit.id, target: target.id, label: def.name, bonus: proficiency(unit.level) + mod(statOf(unit, "str")), vs: 10 + Math.max(saveBonus(target, "str"), saveBonus(target, "agi")), adv: unseen(unit) ? 1 : 0 });
  ctx.events.push({ t: "roll", roll });
  if (!roll.ok) {
    ctx.events.push({ t: "miss", actor: unit.id, target: target.id, what: def.id });
    return false;
  }
  const dir = directionToward(unit.pos, target.pos);
  for (let i = 0; i < opts.hexes && !target.down; i++) {
    const dest = { q: target.pos.q + dir.q, r: target.pos.r + dir.r };
    const tile = tileAt(state.map, dest);
    if (!tile || solid(tile) || blockerAt(state, dest) || Math.abs(elevOf(state.map, dest) - elevOf(state.map, target.pos)) >= 2) {
      ctx.events.push({ t: "shoved", id: unit.id, target: target.id, from: target.pos, to: null });
      addCondition(ctx, target, "stunned", opts.stun);
      return true;
    }
    if (unitAt(state, dest)) {
      if (i === 0) ctx.events.push({ t: "shoved", id: unit.id, target: target.id, from: target.pos, to: null });
      return true;
    }
    const was = target.pos;
    target.pos = dest;
    ctx.events.push({ t: "shoved", id: unit.id, target: target.id, from: was, to: dest });
    // Ground that trips it (ice) ends the drive there.
    if (enterSurface(ctx, target) || target.down) return true;
    enterWeather(ctx, target);
  }
  return true;
}

/** Can a unit be moved from one hex onto the next by force: open ground, nobody on it, no cliff between. */
/** Drag `target` up to `hexes` straight toward `unit`, stopping beside them or at anything in the way (Throw Pike). */
function pull(ctx: Ctx, unit: Unit, target: Unit, hexes: number): void {
  const dir = directionToward(target.pos, unit.pos);
  for (let i = 0; i < hexes && !target.down; i++) {
    const dest = { q: target.pos.q + dir.q, r: target.pos.r + dir.r };
    if (sameHex(dest, unit.pos) || !openFor(ctx.state, target.pos, dest)) return;
    const was = target.pos;
    target.pos = dest;
    ctx.events.push({ t: "shoved", id: unit.id, target: target.id, from: was, to: dest });
    // Ground that trips it (ice) ends the drag there.
    if (enterSurface(ctx, target) || target.down) return;
    enterWeather(ctx, target);
  }
}

function openFor(state: ZoneState, from: HexPos, to: HexPos): boolean {
  return !solid(tileAt(state.map, to)) && !blockerAt(state, to) && Math.abs(elevOf(state.map, to) - elevOf(state.map, from)) < 2 && !unitAt(state, to);
}

/** Carry a unit along `line` from where it stands toward the far end, as far as the way is open. */
function sweepAlong(ctx: Ctx, target: Unit, line: HexPos[], by: string): void {
  const from = line.findIndex((p) => sameHex(p, target.pos));
  let dest = target.pos;
  for (let j = from + 1; j < line.length && openFor(ctx.state, dest, line[j]); j++) dest = line[j];
  if (sameHex(dest, target.pos)) return;
  const was = target.pos;
  target.pos = dest;
  ctx.events.push({ t: "shoved", id: by, target: target.id, from: was, to: dest });
  enterSurface(ctx, target);
  enterWeather(ctx, target);
}

/** Open ground a unit could be put down on: a floor, nothing built on it, nobody on it. */
const standable = (state: ZoneState, pos: HexPos): boolean => !!tileAt(state.map, pos) && !solid(tileAt(state.map, pos)) && !blockerAt(state, pos) && !unitAt(state, pos);

/** Why `unit` cannot blink (Smuggler's Route, Tactical Retreat) to `at`, `range` hexes at most, or null if it can. Nothing between counts. */
function blinkWrong(state: ZoneState, unit: Unit, at: HexPos | undefined, range: number): string | null {
  if (!at || sameHex(at, unit.pos) || !tileAt(state.map, at)) return "Pick a hex to go to.";
  if (hexDistance(unit.pos, at) > range) return "Too far.";
  return standable(state, at) ? null : "There is nowhere to stand there.";
}

/**
 * Where an ally beside `unit` arrives when it is taken along to `dest`: beside it, on the same side of it as they
 * stood of `unit` if that is open, else the open hex nearest that. The hexes the two of them are leaving count as
 * open. Null if there is no room beside `dest`.
 */
export function carrySpot(state: ZoneState, unit: Unit, ally: Unit, dest: HexPos): HexPos | null {
  const want = { q: dest.q + ally.pos.q - unit.pos.q, r: dest.r + ally.pos.r - unit.pos.r };
  const leaving = (p: HexPos) => sameHex(p, unit.pos) || sameHex(p, ally.pos);
  const open = hexNeighbors(dest, state.map.grid).filter((p) => leaving(p) ? !solid(tileAt(state.map, p)) : standable(state, p));
  return open.sort((a, b) => hexDistance(a, want) - hexDistance(b, want) || a.q - b.q || a.r - b.r)[0] ?? null;
}

/** Put a unit on another hex at once, crossing nothing: no blows drawn on the way, only the ground where it lands. */
function blinkTo(ctx: Ctx, unit: Unit, to: HexPos): void {
  if (sameHex(unit.pos, to)) return;
  const from = unit.pos;
  unit.pos = to;
  ctx.events.push({ t: "blinked", id: unit.id, from, to });
  if (!enterSurface(ctx, unit) && !unit.down) enterWeather(ctx, unit);
}

/** Lead by Example: the user's ally nearest the target (not the user) is Inspired, with advantage on their next roll to hit. */
function inspireNearest(ctx: Ctx, unit: Unit, target: Unit): void {
  const ally = ctx.state.units
    .filter((u) => u.side === unit.side && u.id !== unit.id && !u.down)
    .sort((a, b) => hexDistance(a.pos, target.pos) - hexDistance(b.pos, target.pos) || a.id.localeCompare(b.id))[0];
  if (ally) addCondition(ctx, ally, "inspired", 2);
}

/** Pickpocket: gold equal to the user's level, from an enemy whose pockets are not picked yet. A stand-in shows it but banks none. */
function pocket(ctx: Ctx, unit: Unit, target: Unit): void {
  if (target.picked || target.side !== "enemy") return;
  target.picked = true;
  const gold = Math.max(1, unit.level);
  if (!unit.controller) ctx.effects.push({ type: "grant", heroId: unit.id, xp: 0, resources: {}, gold });
  ctx.events.push({ t: "spoils", id: unit.id, xp: 0, resources: {}, gold });
}

// ---------- a hero's abilities ----------

/**
 * The hexes an ability covers, for one that takes a shape: what is lit up before it is used, and what it then hits.
 * `target`: the ally an ability that reaches round an ally (North Star) is used on.
 */
export function abilityArea(state: ZoneState, unit: Unit, ability: string, at?: HexPos, target?: string): HexPos[] {
  const tactic = tacticOf(ability);
  if (tactic.constellation) return constellationHexes(state, unit);
  if (tactic.newMoon) return litFoes(state, unit).map((u) => u.pos);
  if (tactic.northStar) {
    const ally = target ? unitById(state, target) : unit;
    return ally ? hexNeighbors(ally.pos, state.map.grid) : [];
  }
  if (tactic.weather === "rain") return at ? rainHexes(state, unit.pos, at) : [];
  if (tactic.fortify) return at && !sameHex(at, unit.pos) ? wallHexes(state, unit.pos, at) : [];
  if (tactic.splash) return at ? clusterHexes(state, unit.pos, at, tactic.splash.hexes) : [];
  if (tactic.cluster) return at ? clusterHexes(state, unit.pos, at, tactic.cluster) : [];
  if (tactic.shape === "blast") return at ? blast(state.map, at, tactic.radius ?? 1) : [];
  if (tactic.shape === "burst") return blast(state.map, unit.pos, tactic.radius ?? 1).filter((p) => !sameHex(p, unit.pos));
  if (tactic.shape === "line") return at ? lineFrom(state.map, unit.pos, at, tactic.length ?? 3) : [];
  if (tactic.shape === "adjacent") return hexNeighbors(unit.pos, state.map.grid);
  if (tactic.shape === "arc") return at && !sameHex(at, unit.pos) ? arcHexes(state, unit.pos, at) : [];
  if (tactic.shape === "cone") return at && !sameHex(at, unit.pos) ? coneHexes(state, unit.pos, at, tactic.length ?? 3) : [];
  return [];
}

/** Adds `more` to a unit's movement if it is in the middle of its turn in a fight. Says whether it was. */
function moveMore(state: ZoneState, unit: Unit, more: number): boolean {
  const enc = state.encounter;
  const budget = enc && enc.acting.includes(unit.id) && !enc.done.includes(unit.id) ? enc.budgets[unit.id] : undefined;
  if (!budget) return false;
  budget.move += more;
  return true;
}

/**
 * A cone's hexes: 1 hex ahead of `from`, then 2 behind it, then 3, as far as `length` rows. It fans out toward the side
 * of the straight line that `toward` leans to, and leaves out what a wall or a corner hides from `from`.
 */
export function coneHexes(state: ZoneState, from: HexPos, toward: HexPos, length: number): HexPos[] {
  const dir = directionToward(from, toward);
  const at = HEX_DIRS.findIndex((h) => h.q === dir.q && h.r === dir.r);
  // Which of the two directions beside the straight one the aim leans to, by which side of the line it falls.
  const flat = (p: HexPos) => ({ x: Math.sqrt(3) * (p.q + p.r / 2), y: 1.5 * p.r });
  const a = flat({ q: toward.q - from.q, r: toward.r - from.r });
  const d = flat(dir);
  const lean = HEX_DIRS[(at + (d.x * a.y - d.y * a.x < 0 ? 5 : 1)) % 6];
  const out: HexPos[] = [];
  for (let row = 1; row <= length; row++) {
    for (let j = 0; j < row; j++) {
      const p = { q: from.q + (row - j) * dir.q + j * lean.q, r: from.r + (row - j) * dir.r + j * lean.r };
      if (tileAt(state.map, p) && !solid(tileAt(state.map, p)) && sees(state.map, from, p)) out.push(p);
    }
  }
  return out;
}

/** A swing's three hexes: the one beside `from` toward `toward`, and the two beside both it and `from`. */
export function arcHexes(state: ZoneState, from: HexPos, toward: HexPos): HexPos[] {
  const dir = directionToward(from, toward);
  const middle = { q: from.q + dir.q, r: from.r + dir.r };
  return hexNeighbors(from, state.map.grid).filter((p) => hexDistance(p, middle) <= 1);
}

/** Why `unit` cannot use this ability on this aim, in words, or null if it can. */
export function checkAbility(state: ZoneState, unit: Unit, ability: string, aim: Aim): string | null {
  const def = ABILITIES[ability];
  if (!def || !unit.abilities.includes(ability)) return "You do not have that ability.";
  const tactic = tacticOf(ability);
  const inReach = (pos: HexPos): string | null => {
    const dist = hexDistance(unit.pos, pos);
    if (tactic.reach === "melee") return dist === 1 ? null : "Too far: you have to be next to it.";
    if (dist > tactic.range) return "Out of range.";
    return sees(state.map, unit.pos, pos) ? null : "There is no clear line to it.";
  };
  if (tactic.shape === "single" || tactic.shape === "chain") {
    // A crate: a hero can break it with anything that does damage. It is in plain view, lit or not.
    if (isCrateId(state, aim.target)) {
      const crate = crateById(state, aim.target);
      if (!crate) return "It is broken already.";
      if (unit.side !== "hero") return "Pick an enemy.";
      if (!def.damage) return "That does no harm to a crate.";
      return inReach(crate.pos);
    }
    const target = aim.target ? unitById(state, aim.target) : undefined;
    if (!target || target.down || target.side === unit.side) return "Pick an enemy.";
    if (unit.side === "hero" && !seenByHeroes(state, target)) return "It is too dark to make it out: bring a light, or get beside it.";
    // A blow and then away: where to is checked now, and nothing about the blow can take the hex.
    return inReach(target.pos) ?? (tactic.blink && aim.at ? blinkWrong(state, unit, aim.at, tactic.blink.range) : null);
  }
  if (tactic.shape === "arc") {
    if (!aim.at || sameHex(aim.at, unit.pos)) return "Pick which way to swing.";
    const keys = new Set(arcHexes(state, unit.pos, aim.at).map(posKey));
    if (state.units.some((u) => u.side !== unit.side && !u.down && keys.has(posKey(u.pos)))) return null;
    return unit.side === "hero" && def.damage && cratesBeside(state, unit).some((c) => keys.has(posKey(c.pos))) ? null : "No enemy is in that swing.";
  }
  if (tactic.shape === "adjacent") {
    if (state.units.some((u) => u.side !== unit.side && !u.down && adjacent(u.pos, unit.pos))) return null;
    return unit.side === "hero" && def.damage && cratesBeside(state, unit).length > 0 ? null : "No enemy is next to you.";
  }
  // A course is charted by the stars, not by sight: any hex in range will do, seen or not.
  if (tactic.chart) {
    if (!aim.at || !tileAt(state.map, aim.at)) return "Pick a hex to mark.";
    return hexDistance(unit.pos, aim.at) > tactic.range ? "Out of range." : null;
  }
  if (tactic.shape === "blast") {
    if (!aim.at || !tileAt(state.map, aim.at)) return "Pick a hex.";
    // A wall goes up on open ground: the hex aimed at has to be one somebody could stand on.
    if (tactic.fortify && (sameHex(aim.at, unit.pos) || !standable(state, aim.at))) return "There is no room to raise a wall there.";
    return inReach(aim.at);
  }
  if (tactic.shape === "line" || tactic.shape === "cone") return aim.at && !sameHex(aim.at, unit.pos) ? null : "Pick a direction.";
  if (tactic.shape === "ally") {
    const target = aim.target ? unitById(state, aim.target) : unit;
    if (!target || target.side !== unit.side) return "Pick an ally.";
    return target.id === unit.id ? null : inReach(target.pos);
  }
  if (tactic.constellation) return constellationLinks(state, unit).length > 0 ? null : `No ally of yours is within ${tactic.constellation.link} hexes, in clear sight, to link to.`;
  if (tactic.newMoon) return litFoes(state, unit).length > 0 ? null : "No enemy is lit by Guiding Light.";
  if (tactic.taunt) return foesWithin(state, unit, tactic.taunt.range).length > 0 ? null : tactic.taunt.range === 1 ? "No enemy in the fight is beside you." : `No enemy in the fight is within ${tactic.taunt.range} hexes of you.`;
  if (tactic.summon) {
    if (!state.encounter || !inFight(state, unit.id)) return "That is for a fight.";
    if (!aim.at || sameHex(aim.at, unit.pos) || !tileAt(state.map, aim.at)) return "Pick a hex to call it to.";
    const many = SUMMON_CALLS[tactic.summon].length > 1;
    return inReach(aim.at) ?? (summonSpots(state, unit, tactic.summon, aim.at) ? null : many ? "There is no room for them all there." : "There is nowhere for it to stand there.");
  }
  if (tactic.blink) {
    const wrong = blinkWrong(state, unit, aim.at, tactic.blink.range);
    if (wrong || !aim.target || aim.target === unit.id) return wrong;
    const ally = unitById(state, aim.target);
    if (!tactic.blink.carry || !ally || ally.side !== unit.side) return "Pick an ally beside you to take along.";
    if (!adjacent(ally.pos, unit.pos)) return `${ally.name} has to be beside you to come along.`;
    return carrySpot(state, unit, ally, aim.at!) ? null : `There is no room there for ${ally.name} to arrive.`;
  }
  return null;
}

/** How far afield Show the Way looks for a way to walk to the ally, in steps of open ground. */
const WAY_SEARCH = 30;

/**
 * The hexes `unit` would walk to get to `to`, both ends included: the way the walk itself takes, but over the
 * ground as it would be with nothing lying on it (oil and slime slow the walk, so it would steer round the very
 * stuff Show the Way is to clear). With no way on foot (a cliff, say), the straight line between.
 */
export function wayBetween(state: ZoneState, unit: Unit, to: HexPos): HexPos[] {
  const path = pathIn(zoneReach({ ...state, surfaces: {} }, unit, WAY_SEARCH), to);
  return path ? [unit.pos, ...path] : hexSegment(unit.pos, to);
}

/** What a hero adds to an ability's damage: their stat, their weapon, half their level, and a Bard's tune if one is near. */
function damageBonus(state: ZoneState, unit: Unit, def: AbilityDef): number {
  const tune = state.units.some((u) => u.id !== unit.id && u.side === unit.side && u.kind === "frontend_bard" && !u.down && hexDistance(u.pos, unit.pos) <= BARD_AURA_RANGE) ? BARD_AURA : 0;
  // A torch swung in the hand hits with the torch, not the weapon put away for it.
  return mod(statOf(unit, def.stat)) + (def.id === "torch_swing" ? 0 : unit.power) + Math.floor(unit.level / 2) + tune + songDamage(state, unit);
}

const saveDc = (unit: Unit, def: AbilityDef): number => 8 + proficiency(unit.level) + mod(statOf(unit, def.stat));

/** The conditions an ability leaves on a target it has got through to. */
function afflict(ctx: Ctx, unit: Unit, def: AbilityDef, target: Unit, save: boolean): void {
  if (target.down) return;
  if (def.perfect) {
    const effect = def.perfect.effect;
    if (!save || !saveRoll(ctx, target, SAVE_STAT[effect], saveDc(unit, def), `Resist ${def.name}`).ok) give(ctx, unit, target, effect, def.perfect.turns);
  }
  if (def.targetEffect && !target.down) give(ctx, unit, target, def.targetEffect.effect, def.targetEffect.turns);
}

/** An ability's condition on a target: Burning is set by the user's hand, a stack more under North Star. */
function give(ctx: Ctx, unit: Unit, target: Unit, effect: EffectKind, turns: number): void {
  if (effect === "burning") kindle(ctx, unit, target, turns);
  else addCondition(ctx, target, effect, turns);
}

/** One attack roll with an ability against one target. Returns whether it landed. */
function strike(ctx: Ctx, unit: Unit, def: AbilityDef, tactic: Tactic, target: Unit, opts: { focus?: boolean }): boolean {
  const melee = tactic.reach === "melee";
  const roll = attackRoll(ctx, unit, target, { label: def.name, bonus: proficiency(unit.level) + mod(statOf(unit, def.stat)) + (tactic.toHit ?? 0), melee, focus: opts.focus });
  if (!roll.ok) {
    ctx.events.push({ t: "miss", actor: unit.id, target: target.id, what: def.id });
    return false;
  }
  let amount = rollDice(ctx.rng, abilityDice(def), roll.crit) + damageBonus(ctx.state, unit, def);
  if (def.armorDamage) amount += Math.floor(unit.armor / ARMOR_DAMAGE_DIVISOR);
  if (def.maxHpDamage) amount += Math.round(target.maxHp * def.maxHpDamage);
  if (def.perDebuffDamage) amount += def.perDebuffDamage * DEBUFFS.filter((k) => has(target, k)).length;
  if (def.vsEffect && has(target, def.vsEffect.effect)) amount += def.vsEffect.bonus;
  if (tactic.vsWet && has(target, "wet")) amount += tactic.vsWet;
  if (tactic.edge && roll.adv === 1) amount += tactic.edge;
  if (tactic.wading && inWater(ctx.state, unit)) amount += tactic.wading;
  if (tactic.bulwark) amount += Math.floor(shieldOf(unit) * tactic.bulwark.perShield);
  if (def.bleedPayoff) {
    amount += def.bleedPayoff * (target.conditions.find((c) => c.kind === "bleeding")?.rounds ?? 0);
    removeCondition(target, "bleeding");
  }
  if (def.finisher && target.hp < target.maxHp / 4) amount *= def.finisher;
  const dealt = damage(ctx, target, amount, { actor: unit.id, what: def.id, crit: roll.crit, ignoreGuard: def.ignoreGuard });
  if (def.drain && dealt > 0 && !unit.down) heal(ctx, unit, Math.max(1, Math.round(dealt * def.drain)), { actor: unit.id, what: def.id });
  // A Warlock's critical hits open a wound.
  if (roll.crit && unit.kind === "data_warlock") addCondition(ctx, target, "bleeding", WARLOCK_BLEED_TURNS);
  afflict(ctx, unit, def, target, true);
  if (tactic.guide && !target.down && (!tactic.guideSave || !saveRoll(ctx, target, SAVE_STAT.guiding_light, saveDc(unit, def), `Resist ${def.name}`).ok)) addCondition(ctx, target, "guiding_light", tactic.guide);
  if (tactic.goad && !target.down && !saveRoll(ctx, target, SAVE_STAT.taunted, saveDc(unit, def), `Resist ${def.name}`).ok) {
    // Taunted afresh, by whoever did it last.
    removeCondition(target, "taunted");
    addCondition(ctx, target, "taunted", tactic.goad);
    const c = target.conditions.find((x) => x.kind === "taunted");
    if (c) c.by = unit.id;
  }
  if (tactic.kindleLit && !target.down && has(target, "guiding_light")) kindle(ctx, unit, target, tactic.kindleLit);
  // Water Burst: the drench reaches whoever stands beside the target, no roll to hit.
  if (tactic.spray) {
    for (const foe of ctx.state.units.filter((u) => u.id !== target.id && u.side !== unit.side && !u.down && adjacent(u.pos, target.pos))) {
      damage(ctx, foe, rollDice(ctx.rng, diceFor(Math.max(2, tactic.spray - 2))) + damageBonus(ctx.state, unit, def), { actor: unit.id, what: def.id, ignoreGuard: def.ignoreGuard });
    }
  }
  if (melee) thorns(ctx, unit, target);
  if (tactic.ignites) ignite(ctx, target.pos, unit.id);
  if (tactic.surface) placeSurface(ctx, tactic.surface.self ? [target.pos, unit.pos] : [target.pos], tactic.surface.kind, tactic.surface.rounds, unit.id);
  return true;
}

/** Binding Kelp: no blow and no roll to hit, but the enemy saves or is held: Slowed, or Stunned if it stands in water. */
function bind(ctx: Ctx, unit: Unit, def: AbilityDef, target: Unit, turns: { slowed: number; stunned: number }): boolean {
  const effect = inWater(ctx.state, target) ? "stunned" : "slowed";
  if (!saveRoll(ctx, target, SAVE_STAT[effect], saveDc(unit, def), `Resist ${def.name}`).ok) addCondition(ctx, target, effect, turns[effect]);
  return true;
}

/** Coral Armor: whoever lands a blow up close on one wearing it is cut by it. */
function thorns(ctx: Ctx, attacker: Unit, target: Unit): void {
  if (attacker.down || !has(target, "coral_armor")) return;
  damage(ctx, attacker, rollDice(ctx.rng, CORAL_ARMOR.thorns), { actor: target.id, what: "coral_armor" });
}

/** The crates beside a unit. */
const cratesBeside = (state: ZoneState, unit: Unit) => cratesOn(state, hexNeighbors(unit.pos, state.map.grid));

/**
 * A hero's ability at a crate. It cannot dodge, so there is no roll: the damage lands, never as a
 * critical hit. Fire lights what will catch under it, and what an ability leaves on the ground is left there.
 */
function smash(ctx: Ctx, unit: Unit, def: AbilityDef, tactic: Tactic, crate: Poi): void {
  hurtCrate(ctx, crate, rollDice(ctx.rng, abilityDice(def)) + damageBonus(ctx.state, unit, def), { actor: unit.id, what: def.id });
  if (tactic.ignites) ignite(ctx, crate.pos, unit.id);
  if (tactic.surface) placeSurface(ctx, [crate.pos], tactic.surface.kind, tactic.surface.rounds, unit.id);
}

/**
 * What a hero breaks a crate with when it is simply clicked: the first of their abilities that does damage
 * to one target for an Action, is ready, and reaches it from where they stand, a blow by hand before a shot
 * or a spell. Null if nothing they have reaches it.
 */
export function crateBlow(state: ZoneState, unit: Unit, crateId: string): string | null {
  const fits = unit.abilities.filter((a) => {
    const t = tacticOf(a);
    return ABILITIES[a]?.damage && t.shape === "single" && t.cost === "action" && !(unit.cooldowns[a] > 0) && !checkAbility(state, unit, a, { target: crateId });
  });
  return fits.find((a) => tacticOf(a).reach === "melee") ?? fits[0] ?? null;
}

/**
 * What an attack with this ability on this target would be rolled with, before it is made: the chance
 * to hit and why. Null for abilities that are saved against, or that land without a roll, rather than rolled to hit.
 */
export function previewAttack(state: ZoneState, unit: Unit, ability: string, target: Unit): { chance: number; bonus: number; vs: number; adv: -1 | 0 | 1; notes: string[] } | null {
  const def = ABILITIES[ability];
  const tactic = tacticOf(ability);
  if (!def || !["single", "chain", "adjacent", "arc"].includes(tactic.shape) || tactic.overwhelm || tactic.sure || tactic.bind) return null;
  const c = attackContext(state, unit, target, { melee: tactic.reach === "melee" });
  const bonus = proficiency(unit.level) + mod(statOf(unit, def.stat)) + (tactic.toHit ?? 0) + c.mods;
  const vs = defenceOf(target, state);
  return { chance: hitChance(bonus, vs, c.adv), bonus, vs, adv: c.adv, notes: c.notes };
}

/** Use an ability that has passed its check. Says what was used, then rolls and applies it. */
export function resolveAbility(ctx: Ctx, unit: Unit, ability: string, aim: Aim & { focus?: boolean }): void {
  const def = ABILITIES[ability];
  const tactic = tacticOf(ability);
  const { state } = ctx;
  ctx.events.push({ t: "used", id: unit.id, what: ability, name: def.name, target: aim.target, at: aim.at });
  const foes = () => state.units.filter((u) => u.side !== unit.side && !u.down);
  // Unseen, any ability gives the user away once it is done (bar going Unseen again, or a pocket picked unseen).
  const wasUnseen = unseen(unit);
  let landed = false;
  const crate = tactic.shape === "single" || tactic.shape === "chain" ? crateById(state, aim.target) : undefined;
  if (crate) {
    if (tactic.bulwark) addShield(ctx, unit, tactic.bulwark.shield + unit.level, tactic.bulwark.rounds);
    if (tactic.ward) addShield(ctx, unit, tactic.ward.shield + unit.level, tactic.ward.rounds);
    // Aimed at a crate, a chain goes no further: there is nothing in a crate for it to jump from.
    smash(ctx, unit, def, tactic, crate);
    landed = true;
  } else if (tactic.weather) {
    makeWeather(ctx, tactic.weather, abilityArea(state, unit, ability, aim.at), unit);
    landed = true;
  } else if (tactic.splash) {
    // Healing for the caster's side alone, the fallen got up with it; then the water, which soaks whoever is there.
    const area = abilityArea(state, unit, ability, aim.at);
    const keys = new Set(area.map(posKey));
    const amount = rollDice(ctx.rng, healDice(def)) + Math.max(0, mod(statOf(unit, def.stat))) + Math.floor(unit.level / 2);
    for (const u of state.units.filter((x) => x.side === unit.side && keys.has(posKey(x.pos)))) heal(ctx, u, amount, { actor: unit.id, what: def.id });
    placeSurface(ctx, area, "water", tactic.splash.water, unit.id);
    landed = true;
  } else if (tactic.summon) {
    for (const called of summonCall(ctx, unit, tactic.summon, aim.at!)) if (!called.down) ctx.onStep?.(called, () => {});
    landed = true;
  } else if (tactic.chart) {
    // One mark at a time: the new one takes the old one's place.
    removeCondition(unit, "charted");
    addCondition(ctx, unit, "charted", tactic.chart.rounds);
    const mark = unit.conditions.find((c) => c.kind === "charted");
    if (mark) mark.at = { q: aim.at!.q, r: aim.at!.r };
    chartCourse(ctx, unit);
    landed = true;
  } else if (tactic.constellation) {
    // The links pass harmlessly over the user's side; every enemy on one is struck once and lit, however many cross it.
    const keys = new Set(abilityArea(state, unit, ability).map(posKey));
    const rolled = rollDice(ctx.rng, abilityDice(def)) + damageBonus(state, unit, def);
    for (const victim of foes().filter((u) => keys.has(posKey(u.pos)))) {
      damage(ctx, victim, rolled, { actor: unit.id, what: def.id, ignoreGuard: def.ignoreGuard });
      if (!victim.down) addCondition(ctx, victim, "guiding_light", tactic.guide ?? 0);
    }
    landed = true;
  } else if (tactic.newMoon) {
    // Every light put out at once, each for a blow that cannot be dodged.
    const lit = litFoes(state, unit);
    const rolled = rollDice(ctx.rng, abilityDice(def)) + damageBonus(state, unit, def);
    for (const victim of lit) removeCondition(victim, "guiding_light");
    for (const victim of lit) damage(ctx, victim, rolled, { actor: unit.id, what: def.id, ignoreGuard: def.ignoreGuard });
    landed = true;
  } else if (tactic.redSky) {
    // An omen, not a blow: no roll and no save, and only the other side reads it.
    const keys = new Set(abilityArea(state, unit, ability, aim.at).map(posKey));
    for (const foe of foes().filter((u) => keys.has(posKey(u.pos)))) addCondition(ctx, foe, "red_sky", tactic.redSky.rounds);
    landed = true;
  } else if (tactic.unholy) {
    // Water over it all, bar where an enemy stands: that hex comes up burning, whatever water or ice was on it gone first.
    // (Oil or poison under an enemy goes up with it, and takes the rest of its spill along.)
    const area = abilityArea(state, unit, ability, aim.at);
    const held = new Set(foes().map((u) => posKey(u.pos)));
    const burning = area.filter((p) => held.has(posKey(p)));
    placeSurface(ctx, area.filter((p) => !held.has(posKey(p))), "water", tactic.unholy.water, unit.id);
    clearSurfaces(ctx, burning.filter((p) => ["water", "ice"].includes(state.surfaces[posKey(p)]?.kind ?? "")));
    placeSurface(ctx, burning, "fire", tactic.unholy.fire, unit.id);
    landed = true;
  } else if (tactic.shape === "single") {
    const target = unitById(state, aim.target!)!;
    // The shield is set before the swing, and counts toward it.
    if (tactic.bulwark) addShield(ctx, unit, tactic.bulwark.shield + unit.level, tactic.bulwark.rounds);
    if (tactic.ward) addShield(ctx, unit, tactic.ward.shield + unit.level, tactic.ward.rounds);
    // A pocket picked unseen is no blow, just a quick hand.
    if (tactic.steal && wasUnseen) landed = true;
    else if (tactic.overwhelm) landed = overwhelm(ctx, unit, def, target, tactic.overwhelm);
    else if (tactic.bind) landed = bind(ctx, unit, def, target, tactic.bind);
    else if (tactic.sure) {
      if (def.damage) damage(ctx, target, rollDice(ctx.rng, abilityDice(def)) + damageBonus(state, unit, def), { actor: unit.id, what: def.id, ignoreGuard: def.ignoreGuard });
      afflict(ctx, unit, def, target, false);
      landed = true;
    } else landed = strike(ctx, unit, def, tactic, target, aim);
    // Knocked back unless it saves (Peal), or at once (Roar of Thunder).
    let shoved = landed && !!tactic.knockback && !target.down;
    if (shoved && tactic.knockSave) shoved = !saveRoll(ctx, target, "str", saveDc(unit, def), `Resist ${def.name}`).ok;
    for (let k = 0; shoved && k < (tactic.knockback ?? 0) && !target.down; k++) push(ctx, unit.pos, target, unit.id);
    if (landed && tactic.pull && !target.down) pull(ctx, unit, target, tactic.pull);
    if (tactic.steal && landed) pocket(ctx, unit, target);
    if (tactic.inspire && landed) inspireNearest(ctx, unit, target);
    if (tactic.curse && landed) layCurse(ctx, unit, target, "drowning_curse", tactic.curse.rounds);
    if (tactic.blackSpot && landed) layCurse(ctx, unit, target, "black_spot", tactic.blackSpot.rounds);
    // Then away, hit or miss, if a hex was picked.
    if (tactic.blink && aim.at && !unit.down && standable(state, aim.at)) {
      blinkTo(ctx, unit, aim.at);
      if (!unit.down) ctx.onStep?.(unit, () => {});
    }
  } else if (tactic.sweep) {
    // A wave: the far ones are swept first, so the near ones have somewhere to go.
    const line = abilityArea(state, unit, ability, aim.at);
    const along = (u: Unit) => line.findIndex((p) => sameHex(p, u.pos));
    const caught = foes().filter((u) => along(u) >= 0).sort((a, b) => along(b) - along(a));
    const rolled = rollDice(ctx.rng, abilityDice(def)) + damageBonus(state, unit, def);
    for (const victim of caught) {
      const saved = saveRoll(ctx, victim, "agi", saveDc(unit, def), def.name, aim.focus).ok;
      let amount = rolled;
      if (tactic.vsWet && has(victim, "wet")) amount += tactic.vsWet;
      damage(ctx, victim, saved ? Math.floor(amount / 2) : amount, { actor: unit.id, what: def.id, ignoreGuard: def.ignoreGuard });
      if (!saved && !victim.down) sweepAlong(ctx, victim, line, unit.id);
    }
    if (unit.side === "hero" && def.damage) for (const box of cratesOn(state, line)) hurtCrate(ctx, box, rolled, { actor: unit.id, what: def.id });
    // It leaves the line awash: whoever ends up on it is soaked.
    if (tactic.surface) placeSurface(ctx, line, tactic.surface.kind, tactic.surface.rounds, unit.id);
    landed = true;
  } else if (tactic.shape === "adjacent") {
    for (const foe of foes().filter((u) => adjacent(u.pos, unit.pos))) landed = strike(ctx, unit, def, tactic, foe, aim) || landed;
    if (unit.side === "hero" && def.damage) {
      for (const box of cratesBeside(state, unit)) {
        smash(ctx, unit, def, tactic, box);
        landed = true;
      }
    }
  } else if (tactic.shape === "arc") {
    const keys = new Set(arcHexes(state, unit.pos, aim.at!).map(posKey));
    for (const foe of foes().filter((u) => keys.has(posKey(u.pos)))) landed = strike(ctx, unit, def, tactic, foe, aim) || landed;
    if (unit.side === "hero" && def.damage) {
      for (const box of cratesBeside(state, unit).filter((c) => keys.has(posKey(c.pos)))) {
        smash(ctx, unit, def, tactic, box);
        landed = true;
      }
    }
  } else if (tactic.shape === "chain") {
    const chain = [unitById(state, aim.target!)!];
    for (let i = 0; i < (tactic.jumps ?? 0); i++) {
      const last = chain[chain.length - 1];
      const next = foes()
        .filter((u) => !chain.includes(u) && hexDistance(u.pos, last.pos) <= 2 && sees(state.map, last.pos, u.pos))
        .sort((a, b) => hexDistance(a.pos, last.pos) - hexDistance(b.pos, last.pos) || a.id.localeCompare(b.id))[0];
      if (!next) break;
      chain.push(next);
    }
    for (const foe of chain) if (!foe.down) landed = strike(ctx, unit, def, tactic, foe, aim) || landed;
  } else if (tactic.shape === "blast" || tactic.shape === "burst" || tactic.shape === "line" || tactic.shape === "cone") {
    const area = abilityArea(state, unit, ability, aim.at);
    const keys = new Set(area.map(posKey));
    // A burst is thrown at the enemy, and so is a chorus; a blast or a line catches whoever is standing in it.
    const caught = state.units.filter((u) => !u.down && keys.has(posKey(u.pos)) && ((tactic.shape !== "burst" && tactic.shape !== "cone" && !tactic.chorus && !tactic.foesOnly) || u.side !== unit.side));
    // A chorus swells with every voice of the user's side caught up in it (the user's own aside).
    const voices = tactic.chorus ? state.units.filter((u) => u.side === unit.side && u.id !== unit.id && !u.down && keys.has(posKey(u.pos))).length : 0;
    const rolled = rollDice(ctx.rng, abilityDice(def)) + damageBonus(state, unit, def) + (tactic.chorus ?? 0) * voices;
    for (const victim of caught) {
      const saved = saveRoll(ctx, victim, "agi", saveDc(unit, def), def.name, aim.focus).ok;
      let amount = rolled;
      if (def.vsEffect && has(victim, def.vsEffect.effect)) amount += def.vsEffect.bonus;
      if (tactic.vsWet && has(victim, "wet")) amount += tactic.vsWet;
      damage(ctx, victim, saved ? Math.floor(amount / 2) : amount, { actor: unit.id, what: def.id, ignoreGuard: def.ignoreGuard });
      if (!saved) afflict(ctx, unit, def, victim, false);
      // Moonlight: whoever fails to brace is lit.
      if (!saved && tactic.guide && !victim.down) addCondition(ctx, victim, "guiding_light", tactic.guide);
    }
    // A crate in it takes the lot: it cannot get out of the way.
    if (unit.side === "hero" && def.damage) for (const box of cratesOn(state, area)) hurtCrate(ctx, box, rolled, { actor: unit.id, what: def.id });
    landed = true;
    if (tactic.ignites) for (const pos of area) ignite(ctx, pos, unit.id);
    if (tactic.surface) placeSurface(ctx, area, tactic.surface.kind, tactic.surface.rounds, unit.id);
  } else if (tactic.blink) {
    // Smuggler's Route: the ally's place beside the far end is settled before either of them goes.
    const ally = aim.target && aim.target !== unit.id ? unitById(state, aim.target) : undefined;
    const spot = ally ? carrySpot(state, unit, ally, aim.at!) : null;
    blinkTo(ctx, unit, aim.at!);
    if (ally && spot) blinkTo(ctx, ally, spot);
    for (const u of [unit, ...(ally && spot ? [ally] : [])]) if (!u.down) ctx.onStep?.(u, () => {});
    landed = true;
  } else {
    const target = tactic.shape === "ally" && aim.target ? unitById(state, aim.target)! : unit;
    const soaked = tactic.regen && inWater(state, target) ? tactic.regen.water : 0;
    if (def.heal && !tactic.soothe) heal(ctx, target, rollDice(ctx.rng, healDice(def)) + Math.max(0, mod(statOf(unit, def.stat))) + Math.floor(unit.level / 2) + soaked, { actor: unit.id, what: def.id });
    // A heal that spreads: to every ally beside the one it is aimed at (Clarion Call), or round the user (Soothing Tone).
    const healed = (u: Unit, base: number) => heal(ctx, u, rollDice(ctx.rng, diceFor(Math.max(2, base - 1))) + Math.max(0, mod(statOf(unit, def.stat))) + Math.floor(unit.level / 2), { actor: unit.id, what: def.id });
    if (tactic.ripple) for (const u of state.units) if (u.side === unit.side && !u.down && u.id !== target.id && adjacent(u.pos, target.pos)) healed(u, tactic.ripple);
    if (tactic.soothe) for (const u of state.units) if (u.side === unit.side && !u.down && hexDistance(u.pos, unit.pos) <= tactic.soothe.range) healed(u, def.heal ?? 0);
    if (tactic.northStar) {
      // The blow round the ally first, then the star: what it strikes now is not set alight by it.
      const rolled = rollDice(ctx.rng, abilityDice(def)) + damageBonus(state, unit, def);
      for (const foe of foes().filter((u) => adjacent(u.pos, target.pos))) {
        damage(ctx, foe, rolled, { actor: unit.id, what: def.id, ignoreGuard: def.ignoreGuard });
        if (!foe.down) addCondition(ctx, foe, "guiding_light", tactic.guide ?? 0);
      }
      addCondition(ctx, target, "north_star", tactic.northStar.rounds);
    }
    if (tactic.regen) addCondition(ctx, target, "regenerating", tactic.regen.rounds);
    if (tactic.starlit) addCondition(ctx, target, "north_star", tactic.starlit);
    if (tactic.standStrong) {
      const { shield, perFoe, rounds } = tactic.standStrong;
      addShield(ctx, unit, shield + unit.level + perFoe * foes().filter((u) => adjacent(u.pos, unit.pos)).length, rounds);
    }
    if (tactic.armor) addCondition(ctx, target, "coral_armor", tactic.armor.rounds);
    if (tactic.shanty) {
      // One shanty at a time: the new one starts afresh, nobody joined yet.
      for (const kind of SHANTIES) removeCondition(unit, kind);
      addCondition(ctx, unit, tactic.shanty, SHANTY.rounds);
      Object.assign(shantyOf(unit)!, { joined: [], surge: 0 });
      retune(ctx);
    }
    if (def.targetEffect) addCondition(ctx, target, def.targetEffect.effect, def.targetEffect.turns);
    // "Takes the very next turn" has no meaning in an initiative order: the ally is Hasted instead.
    if (def.actNext && target.id !== unit.id) addCondition(ctx, target, "hasted", 2);
    if (tactic.aura) addCondition(ctx, unit, tactic.aura.kind, tactic.aura.rounds);
    if (tactic.steady) addCondition(ctx, target, "inspired", tactic.steady);
    // Wind's Blessing: more movement now for one in the middle of their turn, else on their next.
    if (tactic.tailwind && !moveMore(state, target, tactic.tailwind)) {
      addCondition(ctx, target, "tailwind", 1, tactic.tailwind);
      // An ally done with their turn in this same phase has it ended again as the phase does: it must outlast that.
      const blessing = target.conditions.find((c) => c.kind === "tailwind");
      if (blessing && state.encounter?.acting.includes(target.id)) blessing.fresh = true;
    }
    if (tactic.shield) {
      const { range, shield, rounds, water } = tactic.shield;
      for (const u of state.units) if (u.side === unit.side && !u.down && hexDistance(u.pos, unit.pos) <= range) shieldUnit(ctx, u, shield + unit.level + (water && inWater(state, u) ? water : 0), rounds);
    }
    if (tactic.cleanse) for (const kind of DEBUFFS) removeCondition(target, kind);
    if (tactic.clearWay) {
      for (const kind of DEBUFFS) removeCondition(target, kind);
      clearSurfaces(ctx, wayBetween(state, unit, target.pos).filter((p) => { const s = state.surfaces[posKey(p)]; return !!s && HINDERING.has(s.kind); }));
    }
    if (tactic.taunt) {
      for (const foe of foesWithin(state, unit, tactic.taunt.range)) {
        // Taunted afresh, by whoever did it last.
        removeCondition(foe, "taunted");
        addCondition(ctx, foe, "taunted", tactic.taunt.rounds);
        const c = foe.conditions.find((x) => x.kind === "taunted");
        if (c) c.by = unit.id;
      }
    }
    if (tactic.hide) {
      const { range, rounds } = tactic.hide;
      for (const u of state.units) if (u.side === unit.side && !u.down && hexDistance(u.pos, unit.pos) <= range) addCondition(ctx, u, "invisible", rounds);
    }
    // One each for the user and an ally; used on yourself, both are yours.
    if (tactic.smuggle) {
      if (target.id === unit.id) addCondition(ctx, unit, "contraband", tactic.smuggle.rounds, 2);
      else for (const u of [unit, target]) addCondition(ctx, u, "contraband", tactic.smuggle.rounds, 1);
    }
    landed = true;
  }
  if (landed && def.selfEffect && !unit.down) addCondition(ctx, unit, def.selfEffect.effect, def.selfEffect.turns);
  if (tactic.stride && !unit.down) moveMore(state, unit, tactic.stride);
  if (wasUnseen && !tactic.hide && !tactic.steal) giveAway(ctx, unit);
}

/**
 * After a course is charted: everyone of the user's side whose turn is underway, and who has had no course this turn,
 * gets its movement now. One who has had theirs (even spent) gets no more for a mark moved.
 */
export function chartCourse(ctx: Ctx, unit: Unit): void {
  const enc = ctx.state.encounter;
  if (!enc) return;
  for (const u of ctx.state.units) {
    const budget = u.side === unit.side && !u.down && enc.acting.includes(u.id) && !enc.done.includes(u.id) ? enc.budgets[u.id] : undefined;
    if (budget && budget.course === undefined) budget.course = CHART.speed;
  }
}

/**
 * After a shanty is struck up or widened: whoever it now reaches is no longer Slowed under a Wind-god's Shanty, and
 * whoever is mid-turn gets whatever movement it now owes them (Budget.song is what it has given this turn).
 */
export function retune(ctx: Ctx): void {
  const enc = ctx.state.encounter;
  for (const u of ctx.state.units) {
    if (u.down) continue;
    if (has(u, "slowed") && windward(ctx.state, u)) removeCondition(u, "slowed");
    const budget = enc && enc.acting.includes(u.id) && !enc.done.includes(u.id) ? enc.budgets[u.id] : undefined;
    if (!budget) continue;
    const owed = songMove(ctx.state, u) - (budget.song ?? 0);
    if (owed > 0) {
      budget.move += owed;
      budget.song = (budget.song ?? 0) + owed;
    }
  }
}

// ---------- an enemy's attacks ----------

/** One of an enemy's attacks: a blow or a shot at `target`, or (an attack on every hero) a burst around itself. */
export function enemyAct(ctx: Ctx, enemy: Unit, attack: EnemyStrike, target: Unit | null): void {
  const { state } = ctx;
  const dc = 8 + attack.bonus;
  ctx.events.push({ t: "used", id: enemy.id, what: "attack", name: attack.name, target: target?.id });
  const leave = (victim: Unit, save: boolean) => {
    if (victim.down || !attack.perfect) return;
    const effect = attack.perfect.effect;
    if (!save || !saveRoll(ctx, victim, SAVE_STAT[effect], dc, `Resist ${attack.name}`).ok) addCondition(ctx, victim, effect, attack.perfect.turns);
  };
  if (attack.burst) {
    const rolled = rollDice(ctx.rng, attack.dice);
    // A fight's blows are for those in it: a hero standing near who is not (their player away) is passed over.
    for (const victim of state.units.filter((u) => u.side !== enemy.side && !u.down && !unseen(u) && inFight(state, u.id) && hexDistance(u.pos, enemy.pos) <= ENEMY_BURST && seesFor(state, enemy.side, enemy.pos, u.pos))) {
      const saved = saveRoll(ctx, victim, "agi", dc, attack.name).ok;
      damage(ctx, victim, saved ? Math.floor(rolled / 2) : rolled, { actor: enemy.id, what: attack.name });
      if (!saved) leave(victim, false);
    }
    return;
  }
  if (!target) return;
  const roll = attackRoll(ctx, enemy, target, { label: attack.name, bonus: attack.bonus, melee: attack.range === 1 });
  if (!roll.ok) {
    ctx.events.push({ t: "miss", actor: enemy.id, target: target.id, what: attack.name });
    return;
  }
  damage(ctx, target, rollDice(ctx.rng, attack.dice, roll.crit), { actor: enemy.id, what: attack.name, crit: roll.crit });
  if (attack.range === 1) thorns(ctx, enemy, target);
  leave(target, true);
  if (attack.kit.surface) placeSurface(ctx, [target.pos], attack.kit.surface.kind, attack.kit.surface.rounds, enemy.id);
  if (attack.kit.chills) chill(ctx, target.pos, enemy.id);
  if (attack.kit.push && !target.down) push(ctx, enemy.pos, target, enemy.id);
}

// ---------- common actions ----------

/** The enemies in the fight, still standing, within `range` of `unit`: the dark hides none of them from this. */
export const foesWithin = (state: ZoneState, unit: Unit, range: number): Unit[] =>
  state.units.filter((u) => u.side !== unit.side && !u.down && inFight(state, u.id) && hexDistance(u.pos, unit.pos) <= range);

/** Why `unit` cannot take this common action, in words, or null if it can. `budget` is null out of a fight. */
export function checkCommon(state: ZoneState, unit: Unit, what: CommonAction, aim: Aim, budget: Budget | null): string | null {
  if (!COMMON_ACTIONS[what]) return "No such action.";
  if (what === "dash" || what === "disengage") return budget ? null : "That is for a fight.";
  if (what === "flee") {
    if (!budget) return "That is for a fight.";
    if (unit.summon) return "It was called to this fight, and stays in it.";
    return foesWithin(state, unit, FLEE_RANGE).length > 0 ? `An enemy is too close to get away: get more than ${FLEE_RANGE} hexes from every one in the fight first.` : null;
  }
  if (what === "join") {
    if (!budget) return "That is for a fight.";
    const songs = joinable(state, unit).filter((s) => !aim.target || s.bard.id === aim.target);
    if (songs.length > 0) return null;
    if (shantyOf(unit) && !aim.target) return "You cannot join your own shanty.";
    return "There is no shanty here you have not joined: stand within one an ally is singing.";
  }
  if (what === "help") {
    const target = aim.target ? unitById(state, aim.target) : undefined;
    if (!target || target.side !== unit.side || !target.down) return "Pick a fallen ally.";
    return adjacent(target.pos, unit.pos) ? null : "You have to be next to them.";
  }
  if (what === "shove") {
    const target = aim.target ? unitById(state, aim.target) : undefined;
    if (!target || target.side === unit.side || target.down) return "Pick an enemy.";
    return adjacent(target.pos, unit.pos) ? null : "You have to be next to it.";
  }
  // Jump.
  if (!aim.at || sameHex(aim.at, unit.pos)) return "Pick a hex to jump to.";
  if (hexDistance(unit.pos, aim.at) > jumpRange(mod(statOf(unit, "str")))) return "Too far to jump.";
  if (solid(tileAt(state.map, aim.at)) || blockerAt(state, aim.at) || unitAt(state, aim.at)) return "There is nowhere to land.";
  if (elevOf(state.map, aim.at) - elevOf(state.map, unit.pos) > 1) return "Too high to jump up to.";
  if (!sees(state.map, unit.pos, aim.at)) return "Something is in the way.";
  if (budget && budget.move < JUMP_MOVE_COST) return "Not enough movement left to jump.";
  return null;
}

/** Take a common action that has passed its check. */
export function doCommon(ctx: Ctx, unit: Unit, what: CommonAction, aim: Aim, budget: Budget | null): void {
  ctx.events.push({ t: "used", id: unit.id, what, name: COMMON_ACTIONS[what].name, target: aim.target, at: aim.at });
  if (what === "join") joinSong(ctx, unit, aim, budget);
  else if (what === "dash" && budget) budget.move += budget.moveMax;
  else if (what === "disengage" && budget) budget.disengaged = true;
  else if (what === "help") {
    const target = unitById(ctx.state, aim.target!)!;
    target.down = false;
    target.hp = 0;
    ctx.events.push({ t: "up", id: target.id });
    heal(ctx, target, 1, { actor: unit.id, what: "help" });
  } else if (what === "shove") {
    const target = unitById(ctx.state, aim.target!)!;
    const roll = d20(ctx.rng, { kind: "shove", id: unit.id, target: target.id, label: "Shove", bonus: mod(statOf(unit, "str")), vs: 10 + Math.max(saveBonus(target, "str"), saveBonus(target, "agi")), adv: unseen(unit) ? 1 : 0 });
    ctx.events.push({ t: "roll", roll });
    giveAway(ctx, unit);
    if (roll.ok) push(ctx, unit.pos, target, unit.id);
    else ctx.events.push({ t: "miss", actor: unit.id, target: target.id, what: "shove" });
  } else if (what === "jump") {
    const from = unit.pos;
    provoke(ctx, unit, aim.at!, budget, () => {});
    if (unit.down) return;
    unit.pos = aim.at!;
    if (budget) budget.move -= JUMP_MOVE_COST;
    ctx.events.push({ t: "jumped", id: unit.id, from, to: unit.pos });
    if (!enterSurface(ctx, unit) && !unit.down) {
      enterWeather(ctx, unit);
      ctx.onStep?.(unit, () => {});
    }
  }
}

/** Join a shanty (checked already): it reaches a hex further, and the one joining gets the lift of joining that kind. */
function joinSong(ctx: Ctx, unit: Unit, aim: Aim, budget: Budget | null): void {
  const { song } = joinable(ctx.state, unit).find((s) => !aim.target || s.bard.id === aim.target)!;
  song.joined = [...(song.joined ?? []), unit.id];
  // Everyone in it gets a little more of what it gives, until the Bard's next turn.
  song.surge = (song.surge ?? 0) + 1;
  if (song.kind === "lively_shanty") addCondition(ctx, unit, "inspired", 2);
  else if (song.kind === "dour_shanty") addCondition(ctx, unit, "guarded", 1);
  // Wind-god's: away on the wind, drawing no blows for the rest of the turn.
  else if (budget) budget.disengaged = true;
  retune(ctx);
}

// ---------- throwing ----------

const carried = (unit: Unit, item: Throwable): number => unit.items[item] ?? 0;
/** Fire bombs slipped into the pack by Contraband (the condition's `amount`): not the hero's own, thrown before any of theirs, and never written home. */
const smuggled = (unit: Unit, item: Throwable): number => (item === SMUGGLED ? (unit.conditions.find((c) => c.kind === "contraband")?.amount ?? 0) : 0);

/** Why `unit` cannot throw this there, in words, or null if it can. */
export function checkThrow(state: ZoneState, unit: Unit, item: Throwable, at: HexPos): string | null {
  if (!THROWABLES[item]) return "No such thing to throw.";
  // A torch already lit in the hand can be thrown with none left in the pack.
  if (carried(unit, item) + smuggled(unit, item) <= 0 && !(THROWABLES[item].light && (unit.torch ?? 0) > 0)) return `You have no ${THROWABLES[item].name.toLowerCase()} left.`;
  if (!tileAt(state.map, at)) return "Pick a hex.";
  if (hexDistance(unit.pos, at) > throwRange(mod(statOf(unit, "str")))) return "Too far to throw.";
  return sees(state.map, unit.pos, at) ? null : "There is no clear line to it.";
}

/** Why `unit` cannot drink this, in words, or null if it can. */
/** Why `unit` cannot light a torch to hold, or null if it can. */
export function checkLight(unit: Unit): string | null {
  if ((unit.torch ?? 0) > 0) return "You already hold a lit torch.";
  return carried(unit, "torch") > 0 ? null : "You have no torch left.";
}

export function checkDrink(unit: Unit, item: Throwable): string | null {
  const def = THROWABLES[item];
  if (!def) return "No such thing to drink.";
  if (!def.drink) return `A ${def.name.toLowerCase()} is not for drinking.`;
  return carried(unit, item) > 0 ? null : `You have no ${def.name.toLowerCase()} left.`;
}

/** Drink something that has passed its check: all of its healing, for the drinker. */
export function drinkItem(ctx: Ctx, unit: Unit, item: Throwable): void {
  const def = THROWABLES[item];
  unit.items[item] = carried(unit, item) - 1;
  ctx.events.push({ t: "used", id: unit.id, what: `drink:${item}`, name: def.name });
  if (def.heal) heal(ctx, unit, rollDice(ctx.rng, def.heal), { actor: unit.id, what: `drink:${item}` });
}

/** Throw something that has passed its check: it lands on `at` and reaches the hexes around it. */
export function throwItem(ctx: Ctx, unit: Unit, item: Throwable, at: HexPos): void {
  const def = THROWABLES[item];
  // Anything thrown gives an Unseen thrower away.
  giveAway(ctx, unit);
  if (def.light) {
    // The torch in the hand if one is lit, burning on for what it has left; else one from the pack, lit as it goes.
    const held = unit.torch ?? 0;
    if (held > 0) letGoTorch(unit);
    else unit.items[item] = carried(unit, item) - 1;
    ctx.events.push({ t: "used", id: unit.id, what: `throw:${item}`, name: def.name, at });
    dropTorch(ctx, at, held > 0 ? held : TORCH_GROUND_ROUNDS, unit.id);
    return;
  }
  const contraband = item === SMUGGLED ? unit.conditions.find((c) => c.kind === "contraband") : undefined;
  if (contraband && (contraband.amount ?? 0) > 0) {
    contraband.amount! -= 1;
    if (contraband.amount! <= 0) removeCondition(unit, "contraband");
  }
  else unit.items[item] = carried(unit, item) - 1;
  ctx.events.push({ t: "used", id: unit.id, what: `throw:${item}`, name: def.name, at });
  const area = blast(ctx.state.map, at, def.radius);
  const keys = new Set(area.map(posKey));
  const caught = ctx.state.units.filter((u) => keys.has(posKey(u.pos)));
  if (def.heal) {
    const amount = rollDice(ctx.rng, def.heal);
    // It heals whoever it splashes, most of all whoever it lands on, and gets a fallen hero up. The enemy's dead stay dead.
    for (const u of caught) {
      if (u.down && u.side !== "hero") continue;
      heal(ctx, u, sameHex(u.pos, at) ? amount : Math.ceil(amount * POTION_EDGE), { actor: unit.id, what: `throw:${item}` });
    }
  }
  if (def.damage) {
    const rolled = rollDice(ctx.rng, def.damage);
    for (const u of caught.filter((c) => !c.down)) {
      const saved = saveRoll(ctx, u, "agi", THROW_SAVE, def.name).ok;
      damage(ctx, u, saved ? Math.floor(rolled / 2) : rolled, { actor: unit.id, what: `throw:${item}` });
      // What it leaves on them (acid's holes) only sticks to those who did not dodge it.
      if (def.condition && !saved && !u.down) addCondition(ctx, u, def.condition.kind, def.condition.rounds);
    }
    for (const box of cratesOn(ctx.state, area)) hurtCrate(ctx, box, rolled, { actor: unit.id, what: `throw:${item}` });
  }
  if (def.surface) placeSurface(ctx, area, def.surface.kind, def.surface.rounds, unit.id);
}
