// The Haunted Caverns: a short delve under the rocks at the back of the
// Harbor, played like a voyage but in about half the time.
//
// The map is solid rock with chambers and tunnels carved out of it. From the
// mouth a tunnel climbs to a hub, where the way forks: the west passage runs
// past an old smugglers' camp to a cache, the east passage past a drowned
// shrine to another. Both climb again to the deep chamber where the haunt is
// bound. A short dead end off the hub holds something worth a detour. Like an
// island it is seeded, so a delve can be replayed from its seed.

import { allHexesInGrid, hexDistance, hexNeighbors, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { BASE_HEIGHT, findPath, scatterPickups, tileAt, type Biome, type Poi, type PoiKind, type Tile, type WorldMap } from "./map";
import type { ResourceKind } from "./hut";
import { makeRng, seedFromString, type Rng } from "./rng";

/** Smaller than an island: the delve is meant to take about half as long. */
export const CAVERN_GRID: HexGrid = { cols: 11, rows: 12 };

/** What lies about in the caverns: mushrooms in the damp and loose stone, and the odd vein of copper. */
export const CAVE_PICKUPS: { find: ResourceKind; count: number; ground: Biome[] }[] = [
  { find: "mushrooms", count: 3, ground: ["cave"] },
  { find: "stone", count: 2, ground: ["cave"] },
  { find: "copper", count: 1, ground: ["cave"] },
];

/** Axial position of an offset (column, row), the way the Harbor lays itself out. */
const at = (col: number, r: number): HexPos => ({ q: col - Math.floor(r / 2), r });

/**
 * Where each chamber's middle sits before jitter, as (column, row): the mouth
 * at the bottom, the hub above it, the west and east passages either side,
 * and the deep chamber at the top. `side` is the dead end off the hub.
 */
const LAYOUT = {
  mouth: [5, 10],
  hub: [5, 7],
  west1: [2, 6],
  west2: [2, 3],
  east1: [8, 6],
  east2: [8, 3],
  deep: [5, 1],
  side: [9, 9],
} as const;

type Chamber = keyof typeof LAYOUT;

/** A chamber's middle: its layout spot, nudged a little by the seed, kept inside the grid. */
function chamberAt(rng: Rng, name: Chamber, grid: HexGrid): HexPos {
  const [col, r] = LAYOUT[name];
  // The mouth and the deep chamber stay on the centre line; the rest wander a step.
  const fixed = name === "mouth" || name === "deep";
  const dc = fixed ? 0 : rng.int(-1, 1);
  const dr = fixed ? 0 : rng.int(-1, 1);
  const rr = Math.max(1, Math.min(grid.rows - 2, r + dr));
  const width = rr % 2 === 0 ? grid.cols : grid.cols - 1;
  return at(Math.max(1, Math.min(width - 2, col + dc)), rr);
}

/**
 * Carve a tunnel from `from` to `to`: mostly straight on, now and then a step
 * aside, and every so often a little wider, so it reads as a cave and not a
 * corridor. Never strays more than a step off the straight line, so the two
 * passages stay apart.
 */
function carveTunnel(rng: Rng, open: Set<string>, grid: HexGrid, from: HexPos, to: HexPos) {
  let cur = from;
  for (let guard = 0; guard < 80 && posKey(cur) !== posKey(to); guard++) {
    const steps = hexNeighbors(cur, grid);
    const closer = steps.filter((n) => hexDistance(n, to) < hexDistance(cur, to));
    // Mostly a step closer; sometimes a step sideways, if that keeps the same distance.
    const sideways = steps.filter((n) => hexDistance(n, to) === hexDistance(cur, to));
    cur = rng.chance(0.82) || sideways.length === 0 ? rng.pick(closer) : rng.pick(sideways);
    open.add(posKey(cur));
    if (rng.chance(0.15)) open.add(posKey(rng.pick(hexNeighbors(cur, grid))));
  }
}

/** Carve a chamber: its middle and every hex beside it, and a few beyond for an uneven edge. */
function carveChamber(rng: Rng, open: Set<string>, grid: HexGrid, middle: HexPos, big = false) {
  open.add(posKey(middle));
  for (const n of hexNeighbors(middle, grid)) {
    open.add(posKey(n));
    if (big || rng.chance(0.25)) for (const m of hexNeighbors(n, grid)) if (rng.chance(big ? 0.35 : 0.2)) open.add(posKey(m));
  }
}

const poi = (id: string, kind: PoiKind, pos: HexPos, extra: Partial<Poi> = {}): Poi => ({
  id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [], ...extra,
});

/**
 * Deterministic caverns from a seed string. Uses the same POI ids as an
 * island (`landing`, `camp`, `shrine`, `cache1`, `cache2`, `lair`), so the
 * rules for resting, searching, praying and fighting all apply unchanged.
 */
export function generateCaverns(seed: string, grid: HexGrid = CAVERN_GRID): WorldMap {
  const rng = makeRng(seedFromString(`caverns|${seed}`));
  const c = Object.fromEntries((Object.keys(LAYOUT) as Chamber[]).map((name) => [name, chamberAt(rng, name, grid)])) as Record<Chamber, HexPos>;

  const open = new Set<string>();
  carveChamber(rng, open, grid, c.mouth);
  carveChamber(rng, open, grid, c.hub, true);
  carveChamber(rng, open, grid, c.deep, true);
  for (const name of ["west1", "west2", "east1", "east2", "side"] as const) carveChamber(rng, open, grid, c[name]);
  // The way in, the fork, the two passages up, and the dead end.
  carveTunnel(rng, open, grid, c.mouth, c.hub);
  carveTunnel(rng, open, grid, c.hub, c.west1);
  carveTunnel(rng, open, grid, c.west1, c.west2);
  carveTunnel(rng, open, grid, c.west2, c.deep);
  carveTunnel(rng, open, grid, c.hub, c.east1);
  carveTunnel(rng, open, grid, c.east1, c.east2);
  carveTunnel(rng, open, grid, c.east2, c.deep);
  carveTunnel(rng, open, grid, c.hub, c.side);

  const tiles: Tile[] = allHexesInGrid(grid).map((pos) => {
    const biome: Biome = open.has(posKey(pos)) ? "cave" : "rock";
    // Uneven floors, and rock walls of ragged heights.
    const h = BASE_HEIGHT[biome] + rng.next() * (biome === "rock" ? 0.45 : 0.08);
    return { q: pos.q, r: pos.r, biome, h };
  });
  const map: WorldMap = { grid, tiles, pois: [] };

  // The west passage: the smugglers' old camp, then a cache beyond it. The east: the drowned shrine, then a cache.
  map.pois.push(
    poi("landing", "landing", c.mouth),
    poi("camp", "camp", c.west1, { enemies: ["skeleton", "skeleton"] }),
    poi("cache1", "cache", c.west2),
    poi("shrine", "shrine", c.east1),
    poi("cache2", "cache", c.east2),
    poi("lair", "lair", c.deep, { hidden: true, enemies: ["haunt", "shade"] }),
  );
  // Make sure every place really is reachable on foot (a nudged chamber can leave a seam of rock).
  for (const p of map.pois) {
    if (p.id === "landing") continue;
    const route = findPath(map, c.mouth, p.pos, Infinity, (t) => (t.biome === "rock" ? 40 : 1));
    for (const step of route?.path ?? []) {
      const t = tileAt(map, step)!;
      if (t.biome === "rock") {
        t.biome = "cave";
        t.h = BASE_HEIGHT.cave + 0.04;
      }
    }
  }
  scatterPickups(map, seed, c.mouth, CAVE_PICKUPS);
  return map;
}

/** The chambers in order up each passage, for tests and tools: [hub, first, second, deep] per side. */
export function cavernPassages(map: WorldMap): { west: HexPos[]; east: HexPos[] } {
  const pos = (id: string) => map.pois.find((p) => p.id === id)!.pos;
  return { west: [pos("camp"), pos("cache1"), pos("lair")], east: [pos("shrine"), pos("cache2"), pos("lair")] };
}
