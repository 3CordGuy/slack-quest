// Overworld map: seeded generation and weighted pathfinding.
//
// Geometry (axial coords, brick-shaped bounds, neighbours, distance) comes
// from packages/core/src/hex.ts. hexPath there is unweighted BFS, so the
// terrain-cost search lives here.

import {
  allHexesInGrid,
  hexDistance,
  hexNeighbors,
  posKey,
  type HexGrid,
  type HexPos,
} from "@gantt-quest/core";
import { makeRng, seedFromString, type Rng } from "./rng";
import type { ResourceKind } from "./hut";

/**
 * `dock`, `cobble`, `mud` and `rampart` belong to the Harbor: the wooden pier
 * surface, its streets, its wet ground, and the old stone wall around it
 * (which cannot be climbed). `floor` and `wall` make up the inside of a hut.
 * `fog` is never part of a real map: it is what a client is sent in place of
 * ground the party has not seen yet.
 */
export type Biome = "plains" | "forest" | "hills" | "water" | "dock" | "cobble" | "mud" | "rampart" | "floor" | "wall" | "fog";

export const MOVE_COST: Record<Biome, number> = {
  plains: 1,
  forest: 2,
  hills: 2,
  water: Infinity,
  dock: 1,
  cobble: 1,
  mud: 1,
  rampart: Infinity,
  floor: 1,
  wall: Infinity,
  fog: Infinity,
};

export interface Tile {
  q: number;
  r: number;
  biome: Biome;
  /** Visual height of the hex prism, 0..1. */
  h: number;
}

/**
 * `landing` is where the party's ship puts in on an island. `pier`, `plot`
 * `board` and `shop` exist only in the Harbor: a moored ship, a crew member's
 * hut, the notice board and the market stall. `door` is the way out of a hut's room.
 */
export type PoiKind = "landing" | "hut" | "lair" | "shrine" | "cache" | "camp" | "pier" | "plot" | "board" | "shop" | "ring" | "dice" | "door" | "works" | "pub" | "counter" | "shoals" | "trader" | "rocks" | "wreck" | "lot" | "site" | "ship" | "pickup" | "fishing" | "felling" | "quarry" | "apothecary" | "smithy";

export interface Poi {
  id: string;
  kind: PoiKind;
  pos: HexPos;
  /** Hidden POIs are stripped from the client view until revealed. */
  hidden: boolean;
  /** Fight won or cache emptied. */
  cleared: boolean;
  /** Hero ids that have used a once-per-hero POI (shrine). */
  usedBy: string[];
  /** Enemy kinds for camp and lair. */
  enemies: string[];
  /** For a hut plot in the Harbor: the hut's tier, which sets how big the building is drawn. */
  tier?: number;
  /** For a pickup on an island: what lies there for the taking. */
  find?: ResourceKind;
  /** For a bought plot whose shack is not up yet: how full its resource bin is, 0 to 1. */
  fill?: number;
}

export interface WorldMap {
  grid: HexGrid;
  tiles: Tile[];
  pois: Poi[];
}

export const MAP_GRID: HexGrid = { cols: 12, rows: 12 };

// ---------- lookups ----------

const tileIndex = new WeakMap<Tile[], Map<string, Tile>>();

export function tileAt(map: WorldMap, pos: HexPos): Tile | undefined {
  let idx = tileIndex.get(map.tiles);
  if (!idx) {
    idx = new Map(map.tiles.map((t) => [posKey(t), t]));
    tileIndex.set(map.tiles, idx);
  }
  return idx.get(posKey(pos));
}

export function poiAt(map: WorldMap, pos: HexPos): Poi | undefined {
  return map.pois.find((p) => p.pos.q === pos.q && p.pos.r === pos.r);
}

export function poiById(map: WorldMap, id: string): Poi | undefined {
  return map.pois.find((p) => p.id === id);
}

/** Compass bearing and hex distance from one hex to another, e.g. "about 6 hexes to the north-east". North is away from the camera. */
export function describeBearing(from: HexPos, to: HexPos): string {
  const dq = to.q - from.q;
  const dr = to.r - from.r;
  const distance = hexDistance(from, to);
  if (distance === 0) return "right here";
  const angle = Math.atan2(Math.sqrt(3) * (dq + dr / 2), -1.5 * dr);
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const dir = names[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
  return `about ${distance} hex${distance === 1 ? "" : "es"} to the ${dir}`;
}

// ---------- pathfinding ----------

type CostFn = (tile: Tile) => number;
const terrainCost: CostFn = (t) => MOVE_COST[t.biome];

interface Reached {
  cost: number;
  prev: string | null;
  pos: HexPos;
}

/**
 * Dijkstra from `from`. The cost of a step is the cost of the tile entered.
 * Returns every hex reachable within `budget`.
 */
export function reachable(
  map: WorldMap,
  from: HexPos,
  budget = Infinity,
  costFn: CostFn = terrainCost,
): Map<string, Reached> {
  const out = new Map<string, Reached>();
  out.set(posKey(from), { cost: 0, prev: null, pos: from });
  // The map is at most a few hundred hexes, so a sorted frontier is plenty.
  const frontier: Reached[] = [out.get(posKey(from))!];
  while (frontier.length > 0) {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].cost < frontier[best].cost) best = i;
    const cur = frontier.splice(best, 1)[0];
    const curKey = posKey(cur.pos);
    if (out.get(curKey)!.cost < cur.cost) continue;
    for (const n of hexNeighbors(cur.pos, map.grid)) {
      const tile = tileAt(map, n);
      if (!tile) continue;
      const step = costFn(tile);
      if (!Number.isFinite(step)) continue;
      const cost = cur.cost + step;
      if (cost > budget) continue;
      const key = posKey(n);
      const seen = out.get(key);
      if (seen && seen.cost <= cost) continue;
      const entry = { cost, prev: curKey, pos: n };
      out.set(key, entry);
      frontier.push(entry);
    }
  }
  return out;
}

/** Cheapest path from `from` to `to` (excluding `from`), or null. */
export function findPath(
  map: WorldMap,
  from: HexPos,
  to: HexPos,
  budget = Infinity,
  costFn: CostFn = terrainCost,
): { path: HexPos[]; cost: number } | null {
  const reached = reachable(map, from, budget, costFn);
  const end = reached.get(posKey(to));
  if (!end) return null;
  const path: HexPos[] = [];
  let cur: Reached | undefined = end;
  while (cur && cur.prev !== null) {
    path.unshift(cur.pos);
    cur = reached.get(cur.prev);
  }
  return { path, cost: end.cost };
}

// ---------- generation ----------

const BIOME_WEIGHTS: [Biome, number][] = [
  ["plains", 4],
  ["forest", 3],
  ["hills", 2],
  ["water", 0.7],
];

function pickBiome(rng: Rng): Biome {
  const total = BIOME_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = rng.next() * total;
  for (const [b, w] of BIOME_WEIGHTS) {
    r -= w;
    if (r <= 0) return b;
  }
  return "plains";
}

export const BASE_HEIGHT: Record<Biome, number> = { water: 0.05, plains: 0.3, forest: 0.4, hills: 0.75, dock: 0.1, cobble: 0.26, mud: 0.2, rampart: 1.25, floor: 0.1, wall: 0.9, fog: 0.3 };

/** Offset-space position of a hex, used for the island outline. */
function flatPos(pos: HexPos): { x: number; y: number } {
  return { x: pos.q + Math.floor(pos.r / 2) + (pos.r % 2) * 0.5, y: pos.r };
}

/**
 * Deterministic island from a seed string: biome regions grown from random
 * centres, sea around the rim, then points of interest placed relative to
 * the landing, then water carved wherever a POI would otherwise be cut off.
 */
export function generateMap(seed: string, grid: HexGrid = MAP_GRID): WorldMap {
  const rng = makeRng(seedFromString(`map|${seed}`));
  const hexes = allHexesInGrid(grid);
  const cx = (grid.cols - 1) / 2;
  const cy = (grid.rows - 1) / 2;

  const centres = Array.from({ length: 11 }, () => ({ pos: rng.pick(hexes), biome: pickBiome(rng) }));
  const tiles: Tile[] = hexes.map((pos) => {
    let best = centres[0];
    let bestD = Infinity;
    for (const c of centres) {
      const d = hexDistance(pos, c.pos) + rng.next() * 1.2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    const { x, y } = flatPos(pos);
    const rim = Math.hypot((x - cx) / (grid.cols / 2), (y - cy) / (grid.rows / 2));
    const biome: Biome = rim > 0.94 + rng.next() * 0.1 ? "water" : best.biome;
    return { q: pos.q, r: pos.r, biome, h: BASE_HEIGHT[biome] + rng.next() * 0.12 };
  });
  const map: WorldMap = { grid, tiles, pois: [] };

  const setBiome = (pos: HexPos, biome: Biome) => {
    const t = tileAt(map, pos)!;
    t.biome = biome;
    t.h = BASE_HEIGHT[biome] + 0.05;
  };
  const land = hexes.filter((p) => tileAt(map, p)!.biome !== "water");
  const taken = (pos: HexPos, gap: number) => map.pois.some((p) => hexDistance(p.pos, pos) < gap);
  const place = (kind: PoiKind, id: string, pos: HexPos, extra: Partial<Poi> = {}) => {
    setBiome(pos, kind === "lair" ? "hills" : "plains");
    map.pois.push({ id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [], ...extra });
  };
  /** Pick the land hex with the best score that keeps `gap` from other POIs. */
  const choose = (score: (pos: HexPos) => number, gap: number): HexPos => {
    let best = land[0];
    let bestScore = -Infinity;
    for (const pos of land) {
      if (taken(pos, gap)) continue;
      const s = score(pos) + rng.next() * 0.9;
      if (s > bestScore) {
        bestScore = s;
        best = pos;
      }
    }
    return best;
  };

  // The ship lands on the western shore; the lair is as far inland and away
  // from it as the island allows.
  const landing = choose((p) => -flatPos(p).x * 2 - Math.abs(flatPos(p).y - cy) * 0.5, 0);
  place("landing", "landing", landing);
  place("lair", "lair", choose((p) => hexDistance(p, landing), 3), { hidden: true, enemies: ["villain", "cultist"] });
  const lair = map.pois[1].pos;
  // The hut sits a short walk from the landing; the camp roughly between hut and lair.
  place("hut", "hut", choose((p) => -Math.abs(hexDistance(p, landing) - 4), 3));
  place(
    "camp",
    "camp",
    choose((p) => -Math.abs(hexDistance(p, landing) - hexDistance(p, lair)) - Math.abs(hexDistance(p, landing) - 6) * 0.5, 3),
    { enemies: rng.chance(0.5) ? ["bandit", "wolf"] : ["bandit", "bandit"] },
  );
  place("shrine", "shrine", choose((p) => -Math.abs(hexDistance(p, lair) - 4), 3));
  place("cache", "cache1", choose((p) => -Math.abs(hexDistance(p, landing) - 3), 2));
  place("cache", "cache2", choose((p) => -Math.abs(hexDistance(p, landing) - 7), 2));

  // Guarantee every POI is reachable on foot: route through water at a steep
  // cost and turn any water on that route into plains.
  const carveCost: CostFn = (t) => (t.biome === "water" ? 40 : MOVE_COST[t.biome]);
  for (const poi of map.pois) {
    if (poi.id === "landing") continue;
    const route = findPath(map, landing, poi.pos, Infinity, carveCost);
    for (const step of route?.path ?? []) {
      if (tileAt(map, step)!.biome === "water") setBiome(step, "plains");
    }
  }
  scatterPickups(map, seed, landing);
  return map;
}

/**
 * What lies about on an island for the taking, by kind: how many, and which
 * ground each is found on, best first. Herbs grow in the open, mushrooms
 * under the trees, wood lies stacked at the forest edge, and stone where the
 * ground rises.
 */
export const PICKUPS: { find: ResourceKind; count: number; ground: Biome[] }[] = [
  { find: "herbs", count: 4, ground: ["plains"] },
  { find: "mushrooms", count: 4, ground: ["forest"] },
  { find: "wood", count: 2, ground: ["forest", "plains"] },
  { find: "stone", count: 2, ground: ["hills", "plains"] },
];

/** Most a single pickup gives; the least is one. */
export const PICKUP_MAX = 3;

/**
 * Lay herbs, mushrooms and piles of wood and stone about the island, on
 * ground a hero can walk to and clear of the story's places. Uses its own
 * random stream, so the rest of the island comes out the same as before
 * pickups existed.
 */
function scatterPickups(map: WorldMap, seed: string, landing: HexPos) {
  const rng = makeRng(seedFromString(`pickups|${seed}`));
  const onFoot = reachable(map, landing);
  const places = map.pois.map((p) => p.pos);
  const spots: HexPos[] = [];
  for (const { find, count, ground } of PICKUPS) {
    for (let n = 0; n < count; n++) {
      const open = map.tiles.filter(
        (t) =>
          onFoot.has(posKey(t)) &&
          places.every((p) => hexDistance(p, t) >= 2) &&
          spots.every((p) => hexDistance(p, t) >= 2),
      );
      // The first kind of ground that has room, else anywhere open.
      const fits = ground.map((b) => open.filter((t) => t.biome === b)).find((list) => list.length > 0) ?? open;
      if (fits.length === 0) return;
      const t = rng.pick(fits);
      const pos = { q: t.q, r: t.r };
      spots.push(pos);
      map.pois.push({ id: `pickup${map.pois.length}`, kind: "pickup", pos, hidden: false, cleared: false, usedBy: [], enemies: [], find });
    }
  }
}
