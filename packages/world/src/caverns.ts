// The Haunted Caverns: a short delve under the rocks at the back of the
// Harbor. No story: the crew goes down, explores, and climbs back out with
// whatever they found before their torches burn down.
//
// Every delve is carved fresh from its seed. A handful of chambers are
// scattered through the rock and joined by tunnels into a tree, sometimes
// with a loop. Things lurk in some chambers, old chests sit in others, and
// the deepest chamber holds a hoard with something terrible guarding it. Now
// and then a dead-end chamber is shut behind a locked door: a key to it lies
// in a chest or is carried by a band somewhere on the near side, or the door
// can be forced.

import { allHexesInGrid, hexDistance, hexNeighbors, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { BASE_HEIGHT, findPath, reachable, scatterPickups, tileAt, type Biome, type Poi, type PoiKind, type Tile, type WorldMap } from "./map";
import type { ResourceKind } from "./hut";
import { makeRng, seedFromString, type Rng } from "./rng";

export const CAVERN_GRID: HexGrid = { cols: 12, rows: 12 };

/** How many chambers a delve has besides the mouth, fewest to most. */
export const CAVERN_CHAMBERS: [number, number] = [6, 8];

/** What lies about in the caverns: mushrooms in the damp, loose stone, old bones, and the odd vein of copper or iron. */
export const CAVE_PICKUPS: { find: ResourceKind; count: number; ground: Biome[] }[] = [
  { find: "mushrooms", count: 3, ground: ["cave"] },
  { find: "stone", count: 3, ground: ["cave"] },
  { find: "bone", count: 2, ground: ["cave"] },
  { find: "copper", count: 2, ground: ["cave"] },
  { find: "iron", count: 1, ground: ["cave"] },
];

/** Who lurks in a chamber: the fights the caverns' balance is pitched on (balance.ts). */
export const LURKERS: string[][] = [
  ["skeleton", "skeleton"],
  ["skeleton", "bat", "bat"],
  ["skeleton", "slime"],
  ["bat", "bat", "bat"],
  ["shade", "shade"],
];

/** What guards the hoard in the deepest chamber. */
export const HOARD_GUARDS: string[][] = [
  ["haunt", "shade"],
  ["haunt", "skeleton"],
];

/** Axial position of an offset (column, row), the way the Harbor lays itself out. */
const at = (col: number, r: number): HexPos => ({ q: col - Math.floor(r / 2), r });

/**
 * Carve a tunnel from `from` to `to`: mostly straight on, now and then a step
 * aside, and (unless `narrow`) every so often a little wider, so it reads as
 * a cave and not a corridor.
 */
function carveTunnel(rng: Rng, open: Set<string>, grid: HexGrid, from: HexPos, to: HexPos, narrow = false) {
  let cur = from;
  for (let guard = 0; guard < 80 && posKey(cur) !== posKey(to); guard++) {
    const steps = hexNeighbors(cur, grid);
    const closer = steps.filter((n) => hexDistance(n, to) < hexDistance(cur, to));
    const sideways = steps.filter((n) => hexDistance(n, to) === hexDistance(cur, to));
    cur = rng.chance(0.82) || sideways.length === 0 ? rng.pick(closer) : rng.pick(sideways);
    open.add(posKey(cur));
    if (!narrow && rng.chance(0.15)) open.add(posKey(rng.pick(hexNeighbors(cur, grid))));
  }
}

/**
 * Carve a chamber: its middle and every hex beside it, and (unless `tight`) a
 * few beyond for an uneven edge. A big chamber spreads further.
 */
function carveChamber(rng: Rng, open: Set<string>, grid: HexGrid, middle: HexPos, shape: "big" | "tight" | "plain" = "plain") {
  open.add(posKey(middle));
  for (const n of hexNeighbors(middle, grid)) {
    open.add(posKey(n));
    if (shape === "tight") continue;
    if (shape === "big" || rng.chance(0.25)) for (const m of hexNeighbors(n, grid)) if (rng.chance(shape === "big" ? 0.35 : 0.2)) open.add(posKey(m));
  }
}

/** The same items in a shuffled order (Fisher-Yates). */
function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const poi = (id: string, kind: PoiKind, pos: HexPos, extra: Partial<Poi> = {}): Poi => ({
  id, kind, pos: { q: pos.q, r: pos.r }, hidden: false, cleared: false, usedBy: [], enemies: [], ...extra,
});

/** Scatter chamber middles through the rock, at least three hexes apart, the mouth first at the bottom. */
function placeChambers(rng: Rng, grid: HexGrid): HexPos[] {
  const mouth = at(Math.floor(grid.cols / 2) - 1 + rng.int(0, 1), grid.rows - 2);
  const out = [mouth];
  const want = 1 + rng.int(CAVERN_CHAMBERS[0], CAVERN_CHAMBERS[1]);
  for (let tries = 0; tries < 600 && out.length < want; tries++) {
    // The bottom rows are the way in: chambers start a little above the mouth.
    const r = rng.int(1, grid.rows - 4);
    const width = r % 2 === 0 ? grid.cols : grid.cols - 1;
    const p = at(rng.int(1, width - 2), r);
    if (out.every((c) => hexDistance(c, p) >= 3)) out.push(p);
  }
  return out;
}

/**
 * Join the chambers into a tree, nearest first from the mouth (with a little
 * jitter so two delves with similar chambers still branch differently).
 * Returns each chamber's parent; the mouth's is -1.
 */
function spanningTree(rng: Rng, chambers: HexPos[]): number[] {
  const parent = chambers.map(() => -1);
  const inTree = new Set([0]);
  const jitter = chambers.map(() => chambers.map(() => rng.next()));
  while (inTree.size < chambers.length) {
    let best: [number, number, number] | null = null;
    for (const a of inTree) {
      for (let b = 0; b < chambers.length; b++) {
        if (inTree.has(b)) continue;
        const d = hexDistance(chambers[a], chambers[b]) + jitter[a][b] * 1.5;
        if (!best || d < best[2]) best = [a, b, d];
      }
    }
    parent[best![1]] = best![0];
    inTree.add(best![1]);
  }
  return parent;
}

/** Whether `to` can be walked to from `from` with the hexes in `shut` closed off. */
function connected(map: WorldMap, from: HexPos, to: HexPos, shut: Set<string>): boolean {
  return reachable(map, from, Infinity, (t) => (shut.has(posKey(t)) || t.biome !== "cave" ? Infinity : 1)).has(posKey(to));
}

/**
 * Deterministic caverns from a seed string. The mouth is `landing`, so
 * resting and being carried back work as on an island. Bands that lurk in a
 * chamber are `camp`s, the hoard's guardians a `lair`, chests `cache`s and
 * locked doors `gate`s.
 */
export function generateCaverns(seed: string, grid: HexGrid = CAVERN_GRID): WorldMap {
  const rng = makeRng(seedFromString(`caverns|${seed}`));
  const chambers = placeChambers(rng, grid);
  const parent = spanningTree(rng, chambers);
  const children = chambers.map((_, i) => parent.filter((p) => p === i).length);

  // How far each chamber is from the mouth along the tunnels; the deepest holds the hoard.
  const depth = chambers.map(() => 0);
  const depthOf = (i: number): number => (i === 0 ? 0 : (depth[i] ||= depthOf(parent[i]) + hexDistance(chambers[i], chambers[parent[i]])));
  chambers.forEach((_, i) => depthOf(i));
  const deepest = depth.indexOf(Math.max(...depth));

  // Dead ends that may be shut behind a locked door: none, often one, now and then two. Only a room that
  // stands well apart from every other can be shut off by a single door.
  const apart = (i: number) => chambers.every((c, j) => j === i || hexDistance(c, chambers[i]) >= (j === parent[i] ? 3 : 4));
  const leaves = chambers.map((_, i) => i).filter((i) => i !== 0 && children[i] === 0 && apart(i));
  const doorCount = Math.min(leaves.length, rng.pick([0, 1, 1, 1, 2]));
  const doors = new Set<number>();
  for (const i of shuffled(rng, leaves)) if (doors.size < doorCount) doors.add(i);

  const open = new Set<string>();
  chambers.forEach((c, i) => carveChamber(rng, open, grid, c, doors.has(i) ? "tight" : i === deepest ? "big" : "plain"));
  for (let i = 1; i < chambers.length; i++) carveTunnel(rng, open, grid, chambers[parent[i]], chambers[i], doors.has(i));
  // Sometimes a second way round: a tunnel between two chambers that are near but not yet joined.
  if (rng.chance(0.6)) {
    const pairs: [number, number][] = [];
    for (let a = 1; a < chambers.length; a++) {
      for (let b = a + 1; b < chambers.length; b++) {
        if (doors.has(a) || doors.has(b) || parent[a] === b || parent[b] === a) continue;
        if (hexDistance(chambers[a], chambers[b]) <= 5) pairs.push([a, b]);
      }
    }
    if (pairs.length > 0) {
      const [a, b] = rng.pick(pairs);
      carveTunnel(rng, open, grid, chambers[a], chambers[b]);
    }
  }

  const tiles: Tile[] = allHexesInGrid(grid).map((pos) => {
    const biome: Biome = open.has(posKey(pos)) ? "cave" : "rock";
    // Uneven floors, and rock walls of ragged heights.
    const h = BASE_HEIGHT[biome] + rng.next() * (biome === "rock" ? 0.45 : 0.08);
    return { q: pos.q, r: pos.r, biome, h };
  });
  const map: WorldMap = { grid, tiles, pois: [] };
  const mouth = chambers[0];

  // Make sure every chamber really is reachable on foot (a tunnel can leave a seam of rock).
  for (const c of chambers.slice(1)) {
    const route = findPath(map, mouth, c, Infinity, (t) => (t.biome === "rock" ? 40 : 1));
    for (const step of route?.path ?? []) {
      const t = tileAt(map, step)!;
      if (t.biome === "rock") {
        t.biome = "cave";
        t.h = BASE_HEIGHT.cave + 0.04;
      }
    }
  }

  // Each door goes where its tunnel meets the room, and the rock is closed up round the rest of the room so
  // the door is the only way in. Kept only if the rest of the caverns can still all be walked.
  const gates: { at: HexPos; room: number; into: HexPos }[] = [];
  for (const i of doors) {
    const c = chambers[i];
    const room = new Set([posKey(c), ...hexNeighbors(c, grid).map(posKey)]);
    const route = findPath(map, chambers[parent[i]], c, Infinity, (t) => (t.biome === "cave" ? 1 : Infinity));
    const steps = route?.path ?? [];
    const into = steps.findIndex((p) => room.has(posKey(p)));
    const door = into > 0 ? steps[into - 1] : null;
    if (!door || hexDistance(door, chambers[parent[i]]) === 0) continue;
    const border = map.tiles.filter((t) => t.biome === "cave" && !room.has(posKey(t)) && posKey(t) !== posKey(door) && [...room].some((k) => {
      const [q, r] = k.split(",").map(Number);
      return hexDistance(t, { q, r }) === 1;
    }));
    for (const t of border) t.biome = "rock";
    const shut = new Set([...gates.map((g) => posKey(g.at)), posKey(door)]);
    const sealed = !connected(map, mouth, c, shut) && connected(map, mouth, c, new Set(gates.map((g) => posKey(g.at))));
    const rest = chambers.every((other, j) => j === i || gates.some((g) => g.room === j) || connected(map, mouth, other, shut));
    if (sealed && rest) {
      gates.push({ at: door, room: i, into: { q: steps[into].q - door.q, r: steps[into].r - door.r } });
      for (const t of border) t.h = BASE_HEIGHT.rock + 0.2;
    } else {
      for (const t of border) t.biome = "cave";
    }
  }
  const behindDoor = new Set(gates.map((g) => g.room));
  for (const g of gates) {
    const t = tileAt(map, g.at)!;
    t.biome = "gate";
    t.h = BASE_HEIGHT.gate;
  }

  // What is in each chamber. The mouth is the way out; the deepest holds the hoard; a locked room a strongbox.
  map.pois.push(poi("landing", "landing", mouth));
  const spot = (c: HexPos, taken: HexPos[]) => {
    const near = hexNeighbors(c, grid).filter((n) => tileAt(map, n)?.biome === "cave" && taken.every((t) => posKey(t) !== posKey(n)));
    return near.length > 0 ? rng.pick(near) : null;
  };
  let bands = 0;
  let chests = 0;
  const add = (p: Poi) => map.pois.push(p);
  const room = (i: number, role: "hoard" | "vault" | "lurk" | "lurk_chest" | "chest" | "shrine") => {
    const c = chambers[i];
    if (role === "hoard") {
      add(poi("lair", "lair", c, { enemies: rng.pick(HOARD_GUARDS) }));
      const s = spot(c, [c]);
      if (s) add(poi("hoard", "cache", s, { loot: "hoard", guard: "lair" }));
    } else if (role === "vault") {
      add(poi(`vault${++chests}`, "cache", c, { loot: "vault" }));
    } else if (role === "shrine") {
      add(poi("shrine", "shrine", c));
    } else if (role === "chest") {
      add(poi(`chest${++chests}`, "cache", c, { loot: "chest" }));
    } else {
      const id = `band${++bands}`;
      add(poi(id, "camp", c, { enemies: [...rng.pick(LURKERS)] }));
      const s = role === "lurk_chest" ? spot(c, [c]) : null;
      if (s) add(poi(`chest${++chests}`, "cache", s, { loot: "chest", guard: id }));
    }
  };
  room(deepest, "hoard");
  for (const i of behindDoor) if (i !== deepest) room(i, "vault");
  const rest = shuffled(rng, chambers.map((_, i) => i).filter((i) => i !== 0 && i !== deepest && !behindDoor.has(i)));
  const lurks = Math.max(2, Math.ceil(rest.length * 0.55));
  rest.forEach((i, n) => {
    if (n < lurks) room(i, rng.chance(0.5) ? "lurk_chest" : "lurk");
    else if (n === lurks && rest.length - lurks >= 2 && rng.chance(0.6)) room(i, "shrine");
    else room(i, "chest");
  });
  for (const [n, g] of gates.entries()) add(poi(`gate${n + 1}`, "gate", g.at, { into: g.into }));

  // A key to each door lies on the near side: in a chest, or carried by one of the bands.
  const near = reachable(map, mouth);
  const holders = map.pois.filter((p) => (p.kind === "cache" && p.loot === "chest") || p.kind === "camp").filter((p) => near.has(posKey(p.pos)));
  for (let n = 0; n < gates.length && holders.length > 0; n++) {
    const pick = holders.splice(rng.int(0, holders.length - 1), 1)[0];
    pick.key = true;
  }

  scatterPickups(map, seed, mouth, CAVE_PICKUPS, 1);
  return map;
}

/**
 * Days of torchlight a delve starts with: there and back to the hoard at the
 * slowest hero's pace, with half again for detours, and a few days to open
 * chests and rest. `pace` is hexes a turn.
 */
export function torchDays(map: WorldMap, pace: number): number {
  const mouth = map.pois.find((p) => p.id === "landing")!.pos;
  const hoard = map.pois.find((p) => p.id === "lair")?.pos ?? mouth;
  const cost = findPath(map, mouth, hoard, Infinity, (t) => (t.biome === "cave" || t.biome === "gate" ? 1 : Infinity))?.cost ?? 10;
  return Math.max(10, Math.ceil(((2 * cost) / pace) * 1.5) + 3);
}
