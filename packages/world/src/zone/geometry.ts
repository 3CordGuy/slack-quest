// Where things are and what is between them: who stands on a hex, what a
// step costs, what can be reached and seen, and the shapes abilities take.
// The client uses the same functions to draw ranges, so what is lit up is
// exactly what the server will allow.

import { hexDistance, hexNeighbors, inBounds, posKey, type HexPos } from "@gantt-quest/core";
import { MOVE_COST, tileAt, type Tile, type WorldMap } from "../map";
import { crateAt } from "./crates";
import { ENEMY_KIT } from "./kit";
import { propOf } from "./props";
import type { Side, Unit, Weather, ZoneState } from "./types";

/** The six neighbours of a hex, clockwise from the upper right. */
export const HEX_DIRS: readonly HexPos[] = [
  { q: 1, r: -1 },
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
];

export const sameHex = (a: HexPos, b: HexPos): boolean => a.q === b.q && a.r === b.r;

/** How far a hero may be sent in one click while walking freely. */
export const FREE_WALK = 80;

/** The highest a hex stands, in levels. */
export const MAX_ELEV = 5;

/** How many can stand on one hex at once, friend or foe. The fallen take up no room. */
export const HEX_ROOM = 2;

export const elevOf = (map: WorldMap, pos: HexPos): number => tileAt(map, pos)?.elev ?? 0;

/** Ground nobody can stand on, whatever is on it: no ground at all, water or rock, a building, or something standing there that bars the way (props.ts). */
export const solid = (tile: Tile | undefined): boolean => !tile || !!tile.built || !!propOf(tile)?.blocks || !Number.isFinite(MOVE_COST[tile.biome]);

/**
 * Whether a ladder joins two hexes that lie side by side: it stands on the lower one, against the cliff of the
 * higher (`Tile.ladder`, a bit for each side in `HEX_DIRS` order).
 */
export function ladderBetween(map: WorldMap, a: HexPos, b: HexPos): boolean {
  const [ea, eb] = [elevOf(map, a), elevOf(map, b)];
  if (ea === eb) return false;
  const [low, high] = ea < eb ? [a, b] : [b, a];
  const bits = tileAt(map, low)?.ladder ?? 0;
  if (!bits) return false;
  const side = HEX_DIRS.findIndex((d) => low.q + d.q === high.q && low.r + d.r === high.r);
  return side >= 0 && (bits & (1 << side)) !== 0;
}

/**
 * Whether a blow by hand reaches from one hex to another: the same hex or the one beside it, and no cliff
 * between (a level's difference at most), unless a ladder joins them: a fight goes on up and down a ladder.
 */
export function strikes(map: WorldMap, a: HexPos, b: HexPos): boolean {
  if (hexDistance(a, b) > 1) return false;
  return Math.abs(elevOf(map, a) - elevOf(map, b)) <= 1 || ladderBetween(map, a, b);
}

// A shut door (a delve's "gate") blocks the view and the light like the rock round it.
const SIGHT_BLOCKERS: ReadonlySet<string> = new Set(["rock", "wall", "rampart", "fog", "gate"]);
const blockerIndex = new WeakMap<Tile[], Set<string>>();

/** The hexes sight cannot pass: living rock and walls, and whatever stands tall enough to hide behind (props.ts). Trees and water do not block it. */
function sightBlockers(map: WorldMap): Set<string> {
  let set = blockerIndex.get(map.tiles);
  if (!set) {
    set = new Set(map.tiles.filter((t) => SIGHT_BLOCKERS.has(t.biome) || !!propOf(t)?.hides).map(posKey));
    blockerIndex.set(map.tiles, set);
  }
  return set;
}

const relief = new WeakMap<Tile[], boolean>();
/** Whether any of a map stands above the rest: on a flat one, the lie of the land hides nothing. */
function hasRelief(map: WorldMap): boolean {
  let any = relief.get(map.tiles);
  if (any === undefined) {
    any = map.tiles.some((t) => (t.elev ?? 0) > 0);
    relief.set(map.tiles, any);
  }
  return any;
}

function hexRound(fq: number, fr: number): HexPos {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/** The hexes strictly between two others, along the straight line. */
export function hexesBetween(from: HexPos, to: HexPos): HexPos[] {
  const dist = hexDistance(from, to);
  const out: HexPos[] = [];
  // Nudged a hair off the exact line, so a line along an edge between two hexes falls the same way from either end.
  for (let i = 1; i < dist; i++) {
    const t = i / dist;
    out.push(hexRound(from.q + (to.q - from.q) * t + 1e-6, from.r + (to.r - from.r) * t + 1e-6));
  }
  return out;
}

/**
 * Whether a line can be drawn from one hex to another without crossing rock or a wall, or ground that stands
 * higher than both ends of it (a ridge between). Units never block it.
 */
export function sees(map: WorldMap, from: HexPos, to: HexPos): boolean {
  const blocked = sightBlockers(map);
  const hilly = hasRelief(map);
  if (blocked.size === 0 && !hilly) return true;
  const between = hexesBetween(from, to);
  if (between.some((p) => blocked.has(posKey(p)))) return false;
  if (!hilly) return true;
  const top = Math.max(elevOf(map, from), elevOf(map, to));
  return between.every((p) => elevOf(map, p) <= top);
}

/**
 * `sees`, for one of `side`: a wall (Fortify) raised by the other side blocks the view as rock does, and one raised by
 * their own side they see over.
 */
export function seesFor(state: Pick<ZoneState, "map" | "weather">, side: Side, from: HexPos, to: HexPos): boolean {
  if (!sees(state.map, from, to)) return false;
  const walls = (state.weather ?? []).filter((w) => w.kind === "wall" && w.side !== side);
  if (walls.length === 0) return true;
  const blocked = new Set(walls.flatMap((w) => w.hexes.map(posKey)));
  return hexesBetween(from, to).every((p) => !blocked.has(posKey(p)));
}

/**
 * A fallen enemy is dead: its body lies where it fell until the fight is over, but takes up no room. A fallen
 * hero is only down, and keeps their place on their hex: they are brought back to their feet on it.
 */
export const isDead = (unit: Unit): boolean => unit.down && unit.side === "enemy";

/** Everyone on a hex, standing or fallen. */
export const unitsAt = (state: Pick<ZoneState, "units">, pos: HexPos): Unit[] => state.units.filter((u) => sameHex(u.pos, pos));

/** Someone on a hex: one still standing, if anyone there is; else a hero who is down there. Never the dead. */
export const unitAt = (state: Pick<ZoneState, "units">, pos: HexPos): Unit | undefined => {
  const there = unitsAt(state, pos).filter((u) => !isDead(u));
  return there.find((u) => !u.down) ?? there[0];
};

/** Whether there is room on a hex for one more to stand (`but`: someone who does not count, being the one who would). The dead take up none. */
export const roomAt = (state: Pick<ZoneState, "units">, pos: HexPos, but?: string): boolean =>
  state.units.reduce((n, u) => n + (!isDead(u) && u.id !== but && sameHex(u.pos, pos) ? 1 : 0), 0) < HEX_ROOM;

export const unitById = (state: ZoneState, id: string): Unit | undefined => state.units.find((u) => u.id === id);

export const flies = (unit: Unit): boolean => unit.side === "enemy" && !!ENEMY_KIT[unit.kind]?.fly;

export const inFight = (state: ZoneState, id: string): boolean => !!state.encounter?.order.includes(id);

export interface Reached {
  cost: number;
  prev: string | null;
  pos: HexPos;
  /** Whether the walker can end a move here: there is room on the hex for them. */
  stop: boolean;
  /** Reckoned with a course charted: the way here, start excluded (the hexes before it may be best reached some other way). */
  way?: HexPos[];
  /** Reckoned with a course charted: the course's movement still unspent here. */
  courseLeft?: number;
}

/** A course charted for a walk: the marks it heads for, and the movement it has left to spend on steps nearer one of them. */
export interface Course {
  marks: readonly HexPos[];
  left: number;
}

/** Whether a step from one hex to the next brings the walker nearer any of the marks. */
export const nearer = (marks: readonly HexPos[], from: HexPos, to: HexPos): boolean => marks.some((m) => hexDistance(to, m) < hexDistance(from, m));

/** What a step nearer a mark takes from the course's movement (the rest of its cost comes out of the turn's). */
export const courseShare = (course: Course | undefined, from: HexPos, to: HexPos, cost: number): number =>
  course && course.left > 0 && nearer(course.marks, from, to) ? Math.min(course.left, cost) : 0;

/** A chest, strongbox or hoard stands on this hex (it is opened from beside it). */
export const chestAt = (state: Pick<ZoneState, "map">, pos: HexPos): boolean => state.map.pois.some((p) => p.kind === "cache" && p.pos.q === pos.q && p.pos.r === pos.r);

/** The wall (Fortify) standing on this hex, if one is. */
export const wallAt = (state: { weather?: Weather[] }, pos: HexPos): Weather | undefined =>
  state.weather?.find((w) => w.kind === "wall" && w.hexes.some((p) => p.q === pos.q && p.r === pos.r));

/** Something stands on this hex that nobody walks, lands or is shoved onto: a chest of any kind, a crate not yet broken, or a wall. */
export const blockerAt = (state: Pick<ZoneState, "map"> & { weather?: Weather[] }, pos: HexPos): boolean => chestAt(state, pos) || !!crateAt(state, pos) || !!wallAt(state, pos);

/** What squeezing past an enemy on their feet adds to a step onto their hex. */
export const SCOOT_COST = 1;

/**
 * What one step costs `unit`, or Infinity if it cannot be made. Open ground is 1; forest and hills 2;
 * climbing a level 1 more; oil or slime underfoot 1 more. A drop or a climb of two levels or more is a cliff:
 * it is crossed only where a ladder stands (a step more for each level climbed, one more to climb down).
 * Nobody bars the way: a hex is shared, friend or foe, up to `HEX_ROOM` on it (a hero who is down keeps their
 * place; a dead enemy takes up none), and a full one can still be passed through, though not stopped on.
 * Squeezing past an enemy on their feet costs a step more. Chests, crates and whatever else stands in the way bar it.
 */
export function stepCost(state: ZoneState, unit: Unit, from: HexPos, to: HexPos, shut?: ReadonlySet<string>): { cost: number; stop: boolean } {
  const tile = tileAt(state.map, to);
  const air = flies(unit);
  const none = { cost: Infinity, stop: false };
  if (!tile || tile.built || propOf(tile)?.blocks || shut?.has(posKey(to)) || blockerAt(state, to)) return none;
  let cost = air ? (SIGHT_BLOCKERS.has(tile.biome) ? Infinity : 1) : MOVE_COST[tile.biome];
  if (!Number.isFinite(cost)) return none;
  if (!air) {
    const climb = (tile.elev ?? 0) - elevOf(state.map, from);
    if (Math.abs(climb) >= 2) {
      if (!ladderBetween(state.map, from, to)) return none;
      cost += climb > 0 ? climb : 1;
    } else if (climb === 1) cost += 1;
    const underfoot = state.surfaces[posKey(to)]?.kind;
    if (underfoot === "oil" || underfoot === "slime") cost += 1;
  }
  let standing = 0;
  let foes = false;
  for (const u of state.units) {
    if (u.id === unit.id || u.down || !sameHex(u.pos, to)) continue;
    standing += 1;
    if (u.side !== unit.side) foes = true;
  }
  if (foes) cost += SCOOT_COST;
  return { cost, stop: standing < HEX_ROOM };
}

/**
 * Everywhere `unit` can get to within `budget`, cheapest way first (Dijkstra). `shut` closes hexes
 * off altogether: the enemy uses it to look for a way round a burning or poisoned hex. With a `course`
 * (Chart a Course), steps nearer a mark spend its movement first, and `cost` is what is spent of `budget`.
 */
export function zoneReach(state: ZoneState, unit: Unit, budget: number, shut?: ReadonlySet<string>, course?: Course): Map<string, Reached> {
  if (course && course.left > 0 && course.marks.length > 0) return chartedReach(state, unit, budget, course, shut);
  const out = new Map<string, Reached>();
  const origin: Reached = { cost: 0, prev: null, pos: unit.pos, stop: true };
  out.set(posKey(unit.pos), origin);
  const frontier: Reached[] = [origin];
  while (frontier.length > 0) {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].cost < frontier[best].cost) best = i;
    const cur = frontier.splice(best, 1)[0];
    const curKey = posKey(cur.pos);
    if (out.get(curKey)!.cost < cur.cost) continue;
    for (const n of hexNeighbors(cur.pos, state.map.grid)) {
      const step = stepCost(state, unit, cur.pos, n, shut);
      if (!Number.isFinite(step.cost)) continue;
      const cost = cur.cost + step.cost;
      if (cost > budget) continue;
      const key = posKey(n);
      const seen = out.get(key);
      if (seen && seen.cost <= cost) continue;
      const entry: Reached = { cost, prev: curKey, pos: n, stop: step.stop };
      out.set(key, entry);
      frontier.push(entry);
    }
  }
  return out;
}

/**
 * zoneReach with a course charted. Two purses now: the turn's movement and the course's, and the same hex can be
 * worth reaching twice, once cheaply and once with more of the course left for the steps after. So each hex is
 * reached once for each amount of the course left (Dijkstra over the pair), and then each keeps its best: least
 * of `budget` spent, then most of the course left. Its `way` is the way that best was found, whole.
 */
function chartedReach(state: ZoneState, unit: Unit, budget: number, course: Course, shut?: ReadonlySet<string>): Map<string, Reached> {
  interface Label { cost: number; left: number; pos: HexPos; prev: Label | null; stop: boolean }
  const labelKey = (pos: HexPos, left: number) => `${posKey(pos)}|${left}`;
  const labels = new Map<string, Label>();
  const origin: Label = { cost: 0, left: course.left, pos: unit.pos, prev: null, stop: true };
  labels.set(labelKey(unit.pos, course.left), origin);
  const frontier: Label[] = [origin];
  const better = (a: Label, b: Label) => a.cost < b.cost || (a.cost === b.cost && a.left > b.left);
  while (frontier.length > 0) {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) if (better(frontier[i], frontier[best])) best = i;
    const cur = frontier.splice(best, 1)[0];
    if (labels.get(labelKey(cur.pos, cur.left)) !== cur) continue;
    for (const n of hexNeighbors(cur.pos, state.map.grid)) {
      const step = stepCost(state, unit, cur.pos, n, shut);
      if (!Number.isFinite(step.cost)) continue;
      const share = courseShare({ marks: course.marks, left: cur.left }, cur.pos, n, step.cost);
      const cost = cur.cost + step.cost - share;
      if (cost > budget) continue;
      const left = cur.left - share;
      const key = labelKey(n, left);
      const seen = labels.get(key);
      if (seen && seen.cost <= cost) continue;
      const label: Label = { cost, left, pos: n, prev: cur, stop: step.stop };
      labels.set(key, label);
      frontier.push(label);
    }
  }
  const chosen = new Map<string, Label>();
  for (const label of labels.values()) {
    const key = posKey(label.pos);
    const had = chosen.get(key);
    if (!had || better(label, had)) chosen.set(key, label);
  }
  const out = new Map<string, Reached>();
  for (const [key, label] of chosen) {
    const way: HexPos[] = [];
    for (let l: Label | null = label; l && l.prev; l = l.prev) way.unshift(l.pos);
    out.set(key, { cost: label.cost, prev: label.prev ? posKey(label.prev.pos) : null, pos: label.pos, stop: label.stop, way, courseLeft: label.left });
  }
  return out;
}

/** The way to a reached hex, start excluded, or null if it was not reached. */
export function pathIn(reach: Map<string, Reached>, to: HexPos): HexPos[] | null {
  let cur = reach.get(posKey(to));
  if (!cur) return null;
  if (cur.way) return [...cur.way];
  const path: HexPos[] = [];
  while (cur && cur.prev !== null) {
    path.unshift(cur.pos);
    cur = reach.get(cur.prev);
  }
  return path;
}

/** What swallows whoever is knocked into it: deep water, lava (the ashlands' water), or nothing at all, off the edge of the land. */
export type Pit = "water" | "lava" | "void";

/** The pit a hex is, if it is one: water of any kind, or no ground there at all. Nobody walks into one; they are knocked in (combat.ts shift). */
export function pitAt(map: WorldMap, pos: HexPos): Pit | null {
  const tile = tileAt(map, pos);
  if (!tile) return "void";
  if (tile.biome !== "water") return null;
  return tile.clime === "ash" ? "lava" : "water";
}

/** The most that standing above a target adds to how far a shot or a spell reaches: a hex for each level, up to this. */
export const HIGH_REACH = 2;

/** How far a shot or a spell of this range reaches from one hex to another: further from above, a hex for each level up to `HIGH_REACH`. */
export const reachFrom = (map: WorldMap, from: HexPos, to: HexPos, range: number): number => range + Math.max(0, Math.min(HIGH_REACH, elevOf(map, from) - elevOf(map, to)));

/** Whether two hexes lie side by side. */
export const adjacent = (a: HexPos, b: HexPos): boolean => hexDistance(a, b) === 1;

/** Whether two hexes are the same one or lie side by side: near enough to crowd each other, whatever the ground between does. */
export const close = (a: HexPos, b: HexPos): boolean => hexDistance(a, b) <= 1;

/** The direction, of the six, that points most nearly from one hex toward another. */
export function directionToward(from: HexPos, toward: HexPos): HexPos {
  const dq = toward.q - from.q;
  const dr = toward.r - from.r;
  // Compared as flat positions, where the six directions are 60 degrees apart.
  const x = Math.sqrt(3) * (dq + dr / 2);
  const y = 1.5 * dr;
  let best = HEX_DIRS[0];
  let bestDot = -Infinity;
  for (const d of HEX_DIRS) {
    const dot = x * Math.sqrt(3) * (d.q + d.r / 2) + y * 1.5 * d.r;
    if (dot > bestDot) [best, bestDot] = [d, dot];
  }
  return best;
}

/** A straight run of hexes from `from` (not included) toward `toward`, stopping at the map's edge or at rock. */
export function lineFrom(map: WorldMap, from: HexPos, toward: HexPos, length: number): HexPos[] {
  if (sameHex(from, toward)) return [];
  const dir = directionToward(from, toward);
  const blocked = sightBlockers(map);
  const out: HexPos[] = [];
  let cur = from;
  for (let i = 0; i < length; i++) {
    cur = { q: cur.q + dir.q, r: cur.r + dir.r };
    if (!inBounds(cur, map.grid) || blocked.has(posKey(cur))) break;
    out.push(cur);
  }
  return out;
}

/** Every hex within `radius` of `center`, itself included, that is on the map. */
export function blast(map: WorldMap, center: HexPos, radius: number): HexPos[] {
  const out: HexPos[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      const p = { q: center.q + dq, r: center.r + dr };
      if (inBounds(p, map.grid)) out.push(p);
    }
  }
  return out;
}
