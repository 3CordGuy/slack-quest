// A hex map: its tiles, the places on it, and weighted pathfinding. The
// Harbor, a hut's room, the caverns and every zone are all one of these.
//
// Geometry (axial coords, brick-shaped bounds, neighbours, distance) comes
// from packages/core/src/hex.ts. hexPath there is unweighted BFS, so the
// terrain-cost search lives here.

import {
  hexDistance,
  hexNeighbors,
  posKey,
  type HexGrid,
  type HexPos,
} from "@gantt-quest/core";
import { makeRng, seedFromString } from "./rng";
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
 * `paved` is laid stone on a zone's map: the floor of a ruin, a courtyard, the walk along the top of a wall.
 */
export type Biome = "plains" | "forest" | "hills" | "water" | "dock" | "cobble" | "mud" | "rampart" | "floor" | "wall" | "cave" | "rock" | "gate" | "fog" | "sand" | "paved";

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
  sand: 1,
  paved: 1,
  rock: Infinity,
  gate: Infinity,
  fog: Infinity,
};

/**
 * The climate a stretch of the world lies in (the atlas lays them out: atlas.ts). The same kinds of ground are
 * found in each (open ground, woods, hills, shore, water), but look nothing alike: the greenwood's grass is the
 * frost's snowfield, the dunes' sand, the mire's moss and the ashlands' cinders.
 */
export type Clime = "greenwood" | "frost" | "dunes" | "mire" | "ash";
export const CLIMES: Clime[] = ["greenwood", "frost", "dunes", "mire", "ash"];

export interface Tile {
  q: number;
  r: number;
  biome: Biome;
  /** The climate it lies in, where that is not the greenwood: it changes how its ground is painted and what grows on it, not what it is. */
  clime?: Clime;
  /** Visual height of the hex prism, 0..1. */
  h: number;
  /** A building stands on this hex (part of the ground a Harbor building takes up): it cannot be walked through. */
  built?: boolean;
  /**
   * A zone map only: how many levels up this hex stands (0 to `MAX_ELEV`). High ground helps a shot; a step of two
   * or more is a cliff, climbed only by a ladder (or jumped, if it is low enough).
   */
  elev?: number;
  /**
   * A zone map only: ladders stand against the cliffs above this hex. Bit i is set for each side (in `HEX_DIRS`
   * order, as for `path`) on which one climbs from here to the higher hex beside it.
   */
  ladder?: number;
  /** A zone map only: what stands on this hex (zone/props.ts): a wall, a pillar, a brazier. It may bar the way, the view, or neither. */
  prop?: string;
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

/** What can stand on a hex and stop anyone walking onto it: a thicket, a heap of boulders, or one great old oak. */
export type Blocker = "trees" | "boulders" | "oak";

/** What it costs to step onto a tile: its ground's cost, or Infinity where a building or a blocker stands. */
export function tileCost(t: Tile): number {
  return t.built || t.blocker ? Infinity : MOVE_COST[t.biome];
}

/**
 * `landing` is the way in to the caverns: the mouth a delve starts at. `camp`, `lair`, `shrine`, `cache` and
 * `pickup` are what the caverns are laid out with (caverns.ts); a delve keeps the chests and makes units of the bands.
 * `gate` is a locked door there, standing on a `gate` tile; `crate` and `glowcap` stand about a delve's floor.
 * `lot`, `site` and `plot` exist only in the Harbor: a plot for sale, one bought with its shack not yet up, and a
 * crew member's hut. `board` and `shop` are its notice board and market stall, and `dealer` is where one stands to
 * deal with whoever keeps a shop, or with the pub's dealer. `door` is the way out of a hut's room.
 */
export type PoiKind = "waygate" | "cave" | "landing" | "lair" | "shrine" | "cache" | "camp" | "plot" | "board" | "shop" | "ring" | "dice" | "door" | "works" | "pub" | "counter" | "shoals" | "crew" | "tide" | "trader" | "rocks" | "wreck" | "lot" | "site" | "pickup" | "fishing" | "felling" | "quarry" | "apothecary" | "smithy" | "galley" | "lighthouse" | "gate" | "dealer" | "crate" | "glowcap" | "lapidary" | "townchest";

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
  /** For a pickup: what lies there for the taking. */
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
  /** For a crate in a delve: what it can still take before it breaks (it is `cleared` once broken), and what it started with. */
  hp?: number;
  maxHp?: number;
}

export type ChestLoot = "chest" | "vault" | "hoard";

export interface WorldMap {
  grid: HexGrid;
  tiles: Tile[];
  pois: Poi[];
}

// ---------- lookups ----------

const tileIndex = new WeakMap<Tile[], Map<string, Tile>>();

/** A map's tiles by key (posKey), for whoever has the key already. Made once for each tiles array and kept with it: the tiles in it are the map's own, and no map gains or loses a tile once it is laid. */
export function tilesByKey(map: WorldMap): Map<string, Tile> {
  let idx = tileIndex.get(map.tiles);
  if (!idx) {
    idx = new Map(map.tiles.map((t) => [posKey(t), t]));
    tileIndex.set(map.tiles, idx);
  }
  return idx;
}

export function tileAt(map: WorldMap, pos: HexPos): Tile | undefined {
  return tilesByKey(map).get(posKey(pos));
}

export function poiAt(map: WorldMap, pos: HexPos): Poi | undefined {
  return map.pois.find((p) => p.pos.q === pos.q && p.pos.r === pos.r);
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

export const BASE_HEIGHT: Record<Biome, number> = { sand: 0.22, water: 0.05, plains: 0.3, forest: 0.4, hills: 0.75, dock: 0.1, cobble: 0.26, mud: 0.2, rampart: 0.7, floor: 0.1, wall: 0.9, cave: 0.18, rock: 1.4, gate: 0.18, fog: 0.3, paved: 0.3 };

/**
 * Lay what `table` lists about a map (how many of each, and which ground each
 * is found on, best first), on ground that can be walked to from `landing`
 * and clear of the map's places. Uses its own random stream, so the rest of
 * the map comes out the same as before pickups existed. `gap` is how far a
 * pickup keeps from the map's places.
 */
export function scatterPickups(map: WorldMap, seed: string, landing: HexPos, table: { find: ResourceKind; count: number; ground: Biome[] }[], gap: number) {
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
