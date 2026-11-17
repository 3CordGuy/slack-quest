// Where things are and what is between them: who stands on a hex, what a
// step costs, what can be reached and seen, and the shapes abilities take.
// The client uses the same functions to draw ranges, so what is lit up is
// exactly what the server will allow.

import { hexDistance, hexNeighbors, inBounds, posKey, type HexPos } from "@gantt-quest/core";
import { MOVE_COST, tileAt, type Tile, type WorldMap } from "../map";
import { crateAt } from "./crates";
import { ENEMY_KIT } from "./kit";
import type { Unit, ZoneState } from "./types";

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
export const FREE_WALK = 40;

export const elevOf = (map: WorldMap, pos: HexPos): number => tileAt(map, pos)?.elev ?? 0;

/** Ground nobody can stand on, whatever is on it. */
export const solid = (tile: Tile | undefined): boolean => !tile || !!tile.built || !Number.isFinite(MOVE_COST[tile.biome]);

// A shut door (a delve's "gate") blocks the view and the light like the rock round it.
const SIGHT_BLOCKERS: ReadonlySet<string> = new Set(["rock", "wall", "rampart", "fog", "gate"]);
const blockerIndex = new WeakMap<Tile[], Set<string>>();

/** The hexes sight cannot pass: living rock and walls. Trees and water do not block it. */
function sightBlockers(map: WorldMap): Set<string> {
  let set = blockerIndex.get(map.tiles);
  if (!set) {
    set = new Set(map.tiles.filter((t) => SIGHT_BLOCKERS.has(t.biome)).map(posKey));
    blockerIndex.set(map.tiles, set);
  }
  return set;
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

/** Whether a line can be drawn from one hex to another without crossing rock or a wall. Units never block it. */
export function sees(map: WorldMap, from: HexPos, to: HexPos): boolean {
  const blocked = sightBlockers(map);
  if (blocked.size === 0) return true;
  return hexesBetween(from, to).every((p) => !blocked.has(posKey(p)));
}

export const unitAt = (state: ZoneState, pos: HexPos): Unit | undefined => state.units.find((u) => sameHex(u.pos, pos));

export const unitById = (state: ZoneState, id: string): Unit | undefined => state.units.find((u) => u.id === id);

export const flies = (unit: Unit): boolean => unit.side === "enemy" && !!ENEMY_KIT[unit.kind]?.fly;

export const inFight = (state: ZoneState, id: string): boolean => !!state.encounter?.order.includes(id);

export interface Reached {
  cost: number;
  prev: string | null;
  pos: HexPos;
  /** Whether the walker can end a move here: not on a hex somebody else is on. */
  stop: boolean;
}

/** A chest, strongbox or hoard stands on this hex (it is opened from beside it). */
export const chestAt = (state: Pick<ZoneState, "map">, pos: HexPos): boolean => state.map.pois.some((p) => p.kind === "cache" && p.pos.q === pos.q && p.pos.r === pos.r);

/** Something stands on this hex that nobody walks, lands or is shoved onto: a chest of any kind, or a crate not yet broken. */
export const blockerAt = (state: Pick<ZoneState, "map">, pos: HexPos): boolean => chestAt(state, pos) || !!crateAt(state, pos);

/**
 * What one step costs `unit`, or Infinity if it cannot be made. Open ground is 1; forest and hills 2;
 * climbing a level 1 more; oil or slime underfoot 1 more. A drop or a climb of two levels is a cliff. Enemies
 * on their feet bar the way; allies and the fallen can be walked past but not stopped on. Chests and crates bar it.
 */
export function stepCost(state: ZoneState, unit: Unit, from: HexPos, to: HexPos, shut?: ReadonlySet<string>): { cost: number; stop: boolean } {
  const tile = tileAt(state.map, to);
  const air = flies(unit);
  const none = { cost: Infinity, stop: false };
  if (!tile || tile.built || shut?.has(posKey(to)) || blockerAt(state, to)) return none;
  let cost = air ? (SIGHT_BLOCKERS.has(tile.biome) ? Infinity : 1) : MOVE_COST[tile.biome];
  if (!Number.isFinite(cost)) return none;
  if (!air) {
    const climb = (tile.elev ?? 0) - elevOf(state.map, from);
    if (Math.abs(climb) >= 2) return none;
    if (climb === 1) cost += 1;
    const underfoot = state.surfaces[posKey(to)]?.kind;
    if (underfoot === "oil" || underfoot === "slime") cost += 1;
  }
  const there = unitAt(state, to);
  if (there && there.id !== unit.id) {
    if (there.side !== unit.side && !there.down) return none;
    return { cost, stop: false };
  }
  return { cost, stop: true };
}

/**
 * Everywhere `unit` can get to within `budget`, cheapest way first (Dijkstra). `shut` closes hexes
 * off altogether: the enemy uses it to look for a way round a burning or poisoned hex.
 */
export function zoneReach(state: ZoneState, unit: Unit, budget: number, shut?: ReadonlySet<string>): Map<string, Reached> {
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

/** The way to a reached hex, start excluded, or null if it was not reached. */
export function pathIn(reach: Map<string, Reached>, to: HexPos): HexPos[] | null {
  let cur = reach.get(posKey(to));
  if (!cur) return null;
  const path: HexPos[] = [];
  while (cur && cur.prev !== null) {
    path.unshift(cur.pos);
    cur = reach.get(cur.prev);
  }
  return path;
}

/** Whether two units are close enough to strike each other in melee. */
export const adjacent = (a: HexPos, b: HexPos): boolean => hexDistance(a, b) === 1;

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
