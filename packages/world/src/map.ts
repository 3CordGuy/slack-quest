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
 * surface, its streets, its wet ground, and the line of great boulders that
 * bounds it, a low bank heaped with stones (which cannot be climbed). `floor` and `wall` make up the inside of a hut.
 * `cave` and `rock` are the Haunted Caverns: a stone floor, and the living rock around it.
 * `gate` is a locked door across a cave tunnel: it cannot be walked through until it is opened,
 * when it becomes cave floor.
 * `fog` is never part of a real map: it is what a client is sent in place of
 * ground the party has not seen yet.
 */
export type Biome = "plains" | "forest" | "hills" | "water" | "dock" | "cobble" | "mud" | "rampart" | "floor" | "wall" | "cave" | "rock" | "gate" | "fog";

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
  cave: 1,
  rock: Infinity,
  gate: Infinity,
  fog: Infinity,
};

export interface Tile {
  q: number;
  r: number;
  biome: Biome;
  /** Visual height of the hex prism, 0..1. */
  h: number;
  /** A building stands on this hex (part of the ground a Harbor building takes up): it cannot be walked through. */
  built?: boolean;
  /** Something too thick to get through stands on this hex: a stand of old trees in the forest, or a heap of boulders in the hills. */
  blocker?: Blocker;
  /**
   * A dirt path crosses this hex: bit i is set for each side it runs out through, the sides in `HEX_DIRS` order
   * (top right, right, bottom right, bottom left, left, top left). One bit is a path's end; two, a run or a bend;
   * three or more, a junction. It is only drawn: a path costs the same to walk as the ground it is on.
   */
  path?: number;
  /** The grass here is of a set kind, whatever the lie of the land would have grown: tall grass, to wade through. */
  grass?: "tall";
}

/** What can stand on a hex and stop anyone walking onto it: a thicket or a heap of boulders on an island, or one great old oak. */
export type Blocker = "trees" | "boulders" | "oak";

/** What it costs to step onto a tile: its ground's cost, or Infinity where a building or a blocker stands. */
export function tileCost(t: Tile): number {
  return t.built || t.blocker ? Infinity : MOVE_COST[t.biome];
}

/**
 * `landing` is where the party's ship puts in on an island. `pier`, `plot`
 * `board` and `shop` exist only in the Harbor: a moored ship, a crew member's
 * hut, the notice board, the market stall and the pub's contract dealer. `door` is the way out of a hut's room.
 * `gate` is a locked door in the Haunted Caverns, standing on a `gate` tile.
 */
export type PoiKind = "cave" | "landing" | "hut" | "lair" | "shrine" | "cache" | "camp" | "pier" | "plot" | "board" | "shop" | "ring" | "dice" | "door" | "works" | "pub" | "counter" | "shoals" | "crew" | "tide" | "trader" | "rocks" | "wreck" | "lot" | "site" | "ship" | "pickup" | "fishing" | "felling" | "quarry" | "apothecary" | "smithy" | "galley" | "lighthouse" | "gate" | "dealer";

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
  /**
   * For a building in the Harbor: which way it faces, in sixths of a turn. 0 has its door to the south and the
   * building behind it to the north; each step turns it a sixth clockwise as seen from above (see `footing`).
   */
  facing?: number;
  /** For a pickup on an island: what lies there for the taking. */
  find?: ResourceKind;
  /** For a bought plot whose shack is not up yet: how full its resource bin is, 0 to 1. */
  fill?: number;
  /** For a chest in the caverns: an old chest, a strongbox behind a locked door, or the hoard in the deepest chamber. */
  loot?: ChestLoot;
  /** For a chest in the caverns: the id of the band that guards it. It cannot be opened while they stand. */
  guard?: string;
  /** For a chest or a band in the caverns: holds a key to a locked door, found by whoever opens or beats it. */
  key?: boolean;
  /** For a locked door: the step from it into the room it shuts (a neighbour's offset), so it can be drawn across its tunnel. */
  into?: HexPos;
}

export type ChestLoot = "chest" | "vault" | "hoard";

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
const terrainCost: CostFn = tileCost;

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

export const BASE_HEIGHT: Record<Biome, number> = { water: 0.05, plains: 0.3, forest: 0.4, hills: 0.75, dock: 0.1, cobble: 0.26, mud: 0.2, rampart: 0.7, floor: 0.1, wall: 0.9, cave: 0.18, rock: 1.4, gate: 0.18, fog: 0.3 };

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
  placeBlockers(map, seed, landing);
  scatterPickups(map, seed, landing);
  return map;
}

/**
 * Stand old trees in the forest and heap boulders in the hills, on hexes nobody
 * can walk through, clumped so they read as thickets and outcrops. One goes down
 * only where it shuts nothing else off: every hex that could be walked to from
 * the landing before still can be, though perhaps the long way round. None
 * stands on a place, nor right beside the landing. Uses its own random stream,
 * so the rest of the island comes out the same as before blockers existed.
 */
export function placeBlockers(map: WorldMap, seed: string, landing: HexPos) {
  const rng = makeRng(seedFromString(`blockers|${seed}`));
  const candidates = map.tiles.filter(
    (t) =>
      (t.biome === "forest" || t.biome === "hills") &&
      hexDistance(t, landing) >= 2 &&
      map.pois.every((p) => hexDistance(p.pos, t) >= 1),
  );
  // A random order: shuffled, so the clumping below does not always grow from the same corner.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  // Only whether a hex can be got to matters here, not what it costs: a plain flood fill over the
  // tiles' neighbours (worked out once) is much quicker than pathfinding after every try.
  const tiles = map.tiles;
  const index = new Map(tiles.map((t, i) => [posKey(t), i]));
  const near = tiles.map((t) => hexNeighbors(t, map.grid).flatMap((n) => index.get(posKey(n)) ?? []));
  const start = index.get(posKey(landing))!;
  const seen = new Uint8Array(tiles.length);
  const stack = new Int32Array(tiles.length);
  /** How many hexes can be walked to from the landing, counting the landing: as `reachable(map, landing).size`. */
  const walkable = () => {
    seen.fill(0);
    seen[start] = 1;
    stack[0] = start;
    let top = 1;
    let count = 1;
    while (top > 0) {
      const i = stack[--top];
      for (const j of near[i]) {
        if (seen[j] || !Number.isFinite(tileCost(tiles[j]))) continue;
        seen[j] = 1;
        count++;
        stack[top++] = j;
      }
    }
    return count;
  };
  let open = walkable();
  // No more than about a sixth of the land: an island to find a way across, not a maze.
  let left = Math.round(map.tiles.filter((t) => t.biome !== "water").length * 0.17);
  // Two passes: the first seeds a few stands, the second lets them grow into the hexes beside them.
  for (const grow of [false, true]) {
    for (const t of candidates) {
      if (t.blocker) continue;
      if (left <= 0) return;
      const beside = near[index.get(posKey(t))!].some((j) => !!tiles[j].blocker);
      const chance = grow ? (beside ? 0.36 : 0.05) : 0.12;
      if (!rng.chance(chance)) continue;
      t.blocker = t.biome === "forest" ? "trees" : "boulders";
      const now = walkable();
      // It cut something off (or stood somewhere nobody could reach anyway): take it back.
      if (now !== open - 1) {
        delete t.blocker;
        continue;
      }
      open = now;
      left--;
    }
  }
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
 * pickups existed. `gap` is how far a pickup keeps from the map's places (two
 * on an island; the cramped caverns use one).
 */
export function scatterPickups(map: WorldMap, seed: string, landing: HexPos, table: { find: ResourceKind; count: number; ground: Biome[] }[] = PICKUPS, gap = 2) {
  const rng = makeRng(seedFromString(`pickups|${seed}`));
  const onFoot = reachable(map, landing);
  const places = map.pois.map((p) => p.pos);
  const spots: HexPos[] = [];
  for (const { find, count, ground } of table) {
    for (let n = 0; n < count; n++) {
      const open = map.tiles.filter(
        (t) =>
          onFoot.has(posKey(t)) &&
          places.every((p) => hexDistance(p, t) >= gap) &&
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
