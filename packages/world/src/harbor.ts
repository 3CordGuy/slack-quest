// The Harbor: a crew's shared, walkable base between voyages.
//
// Unlike an island it is not turn-based and has no reducer: players walk
// freely, and the HarborRoom Durable Object only validates paths and relays
// them. This file holds the fixed map and the message shapes both sides use.

import type { Appearance } from "./appearance";
import { allHexesInGrid, type HexGrid, type HexPos } from "@gantt-quest/core";
import type { Outfit } from "./gear";
import type { FishSpot, Vessel } from "./fishing";
import type { Perk, Resources } from "./hut";
import type { ItemDef } from "./gear";
import type { Stats } from "@gantt-quest/core";
import type { HarborWorks } from "./projects";
import { findPath, tileAt, type Biome, type Poi, type PoiKind, type Tile, type WorldMap } from "./map";

/** What the crew's home port is called, wherever its name is shown. */
export const HARBOR_NAME = "Heylets Harbor";

export const HARBOR_GRID: HexGrid = { cols: 28, rows: 31 };

/** Offset column (visual left-to-right index) of an axial hex. */
const colOf = (p: HexPos) => p.q + Math.floor(p.r / 2);
const at = (col: number, r: number): HexPos => ({ q: col - Math.floor(r / 2), r });
const keyOf = (p: HexPos) => `${p.q},${p.r}`;

/**
 * How much ground a building takes, behind its door. The door is the hex a hero stands on to use the place; the
 * building itself stands on the hexes north of it, which nobody can walk through:
 * a `pair` is the two hexes behind the door (three tiles with the doorstep), a `trio` those and the one behind them
 * (a diamond of four with the doorstep), and a `flower` a whole ring of seven whose two nearest petals touch the door.
 * A `single` is one hex, the one up and to the right of where a hero stands to use it: for a thing rather than a
 * building (the town chest, the notice board, the stonecutter's bench).
 */
export type Footing = "single" | "pair" | "trio" | "flower";

/**
 * The six sides of a hex, clockwise from the top right: the same order as `HEX_DIRS` (hutroom.ts), which a
 * path's bits and a building's facing both count in. Kept here too so this file does not import the hut room's.
 */
export const HARBOR_SIDES: readonly HexPos[] = [{ q: 1, r: -1 }, { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }];
/** An offset turned a sixth clockwise, `times` times: in the order above, each side becomes the next. */
function turned(d: HexPos, times: number): HexPos {
  let { q, r } = d;
  for (let i = 0; i < ((times % 6) + 6) % 6; i++) [q, r] = [-r, q + r];
  return { q, r };
}

/**
 * The hexes a building with its door on `door` stands on. Facing 0 it stands to the north of its door, its front
 * to the south; each step of `facing` turns it a sixth clockwise about the door, so it can front a road running
 * any of the three ways a row of hexes runs.
 */
export function footing(door: HexPos, shape: Footing, facing = 0): HexPos[] {
  const pair = [{ q: 0, r: -1 }, { q: 1, r: -1 }];
  const offsets = shape === "single" ? [{ q: 1, r: -1 }] : shape === "pair" ? pair : shape === "trio" ? [...pair, { q: 1, r: -2 }] : [...pair, { q: 1, r: -2 }, { q: 0, r: -2 }, { q: 2, r: -2 }, { q: 1, r: -3 }, { q: 2, r: -3 }];
  return offsets.map((d) => {
    const t = turned(d, facing);
    return { q: door.q + t.q, r: door.r + t.r };
  });
}

/**
 * The hexes just in front of a door facing `facing`: the two of its sides the front looks out between. A
 * doorstep's path runs out to whichever of them a road is on.
 */
export function frontOf(door: HexPos, facing = 0): HexPos[] {
  return [2, 3].map((side) => {
    const d = HARBOR_SIDES[(side + facing) % 6];
    return { q: door.q + d.q, r: door.r + d.r };
  });
}

/**
 * Where a player appears on arrival: the middle of the square, at the island's heart. The square is this hex and
 * the two rings round it (`HARBOR_SQUARE`), and what a crew uses every day stands on its rim, a step from here:
 * the notice board and the town chest either side of the lane up to the caverns, and the market stall down the
 * west side. The trades are out along the High Street: the smithy, the stonecutter's bench and the sparring
 * ring at its west end, the pub and the apothecary at its east.
 */
export const HARBOR_SPAWN: HexPos = at(13, 15);
/** The square: every hex within two of where everyone arrives. All of it cobbled. */
export const HARBOR_SQUARE: HexPos[] = allHexesInGrid({ cols: 28, rows: 31 }).filter((p) => {
  const dq = p.q - HARBOR_SPAWN.q, dr = p.r - HARBOR_SPAWN.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 <= 2;
});
/** Pier heads, off the south shore: the end of each pier's planking. A moored ship lies in the water beyond each one. */
export const HARBOR_PIERS: HexPos[] = [at(8, 26), at(13, 27), at(18, 26)];
/**
 * Hut plots, handed out to crew members in the order they joined: each is the doorstep of a hut that stands on the
 * two hexes behind it. They line the two dirt lanes that run up from the High Street to the north-west and the
 * north-east, facing the lane from either side, the first few nearest the street; the last few are down by the
 * shore, along the lanes to the fish shack and the lighthouse.
 */
export const HARBOR_PLOTS: HexPos[] = [
  at(10, 12), at(16, 13), at(8, 13), at(9, 18), at(9, 10), at(17, 11),
  at(7, 11), at(20, 10), at(8, 8), at(18, 9), at(8, 20), at(20, 18),
];
/** Which way each hut plot faces (see `footing`), so its hut fronts the lane it stands on. */
export const HARBOR_PLOT_FACING: number[] = [1, 0, 5, 0, 1, 5, 4, 2, 1, 5, 3, 0];
/**
 * The notice board: where a hero stands to read it, at the head of the square. The board itself stands on the
 * square's north-west corner, up and to the left of this hex, on the left of the lane up to the caverns, and
 * faces in.
 */
export const HARBOR_BOARD: HexPos = at(13, 14);
/** The market stall, where gear is bought and sold: its doorstep, on the square's west side. The stall stands west of it and fronts the square. */
export const HARBOR_SHOP: HexPos = at(12, 14);
/** The sparring ring, where crewmates try out their gear: at the west end of the High Street. */
export const HARBOR_RING: HexPos = at(5, 15);
/** Gathering spots at the edges: the fish shack on the south-west shore, the western trees, and an outcrop in the east wall. */
export const HARBOR_GATHER = { fishing: at(6, 23), felling: at(3, 13), quarry: at(20, 6) } as const;
/** Where a fishing sitting can be started: each pier head, and the old spot on the south-west shore. The open sea is reached by boat. */
/** The piers and the shore spot. (Afloat, any water hex is a spot: see waterSpotAt.) */
export type ShoreSpot = "west" | "middle" | "east" | "shore";
export const HARBOR_FISH_SPOTS: Record<ShoreSpot, HexPos> = {
  west: HARBOR_PIERS[0],
  middle: HARBOR_PIERS[1],
  east: HARBOR_PIERS[2],
  shore: HARBOR_GATHER.fishing,
};
/** The fishing spot on a hex, if there is one. */
export function fishSpotAt(pos: HexPos): ShoreSpot | null {
  for (const [id, p] of Object.entries(HARBOR_FISH_SPOTS) as [ShoreSpot, HexPos][]) if (p.q === pos.q && p.r === pos.r) return id;
  return null;
}
/** The pub's door, at the east end of the High Street on its north side, its front to the south: food, drink, the barkeep and the dice table are inside. */
export const HARBOR_PUB: HexPos = at(19, 14);
/** The works: the builders' yard where the crew's shared projects are paid for, on the west road down to the quay. */
export const HARBOR_WORKS: HexPos = at(11, 18);
/**
 * The lighthouse's door: out on the south-east point, over the wreck, where
 * ships pass out of the harbour. Not in the plaza, where a tall tower would
 * hide the town. The tower stands in the middle of the seven hexes behind it:
 * a bare point (then a building site) until the crew has paid for it at the works.
 */
export const HARBOR_LIGHTHOUSE: HexPos = at(21, 24);
/**
 * The stonecutter's bench, where lodestones are cut and worked (stonecraft.ts) before a crew goes out to the
 * atlas with them: where a hero stands to use it, at the west end of the High Street, away from the square.
 * The bench itself stands up and to the left of this hex, in the nook beside the smithy's door: the two
 * trades that work stone and iron, side by side.
 */
export const HARBOR_BENCH: HexPos = at(7, 15);
/**
 * The town chest, the crew's shared store (townchest.ts): where a hero stands to open it, at the head of the
 * square. The chest itself stands on the square's north-east corner, up and to the right of this hex, on the
 * right of the lane up to the caverns (the notice board is on the left), and faces in. Nobody walks through
 * it, and pointing at it is pointing here.
 */
export const HARBOR_CHEST: HexPos = at(14, 14);
/** The apothecary's door, across the High Street from the pub, facing up it from the south side. A building site until the crew has paid for it. */
export const HARBOR_APOTHECARY: HexPos = at(18, 16);
/** The smithy's door, at the west end of the High Street by the sparring ring. A building site until the crew has paid for it. */
export const HARBOR_SMITHY: HexPos = at(6, 14);
/** The galley's door, on the east road down to the quay, where ships take on provisions. A building site until the crew has paid for it. */
export const HARBOR_GALLEY: HexPos = at(15, 21);

/**
 * The oak on the hill: one great old tree on a rise in the open ground at the back of the island, north-east of
 * the plaza, with tall grass all round it. Nobody walks through the oak; the hill itself is to climb.
 */
export const HARBOR_OAK: HexPos = at(15, 7);

/** The mouth of the Haunted Caverns: a way into the rocks through the north wall. */
export const HARBOR_CAVE: HexPos = at(13, 3);

/** Rocks standing out of the water, and the wreck on them. Scenery: nobody can reach them. */
export const HARBOR_ROCKS: HexPos[] = [at(3, 22), at(5, 26), at(23, 25), at(24, 6), at(2, 7)];
export const HARBOR_WRECK: HexPos = at(22, 23);

/**
 * The town's buildings: where each one's door is, how much ground it stands on behind it, and what that ground
 * is. The town's places stand on cobbles; the lighthouse and the fish shack on the bare shore; huts on the grass.
 */
export const HARBOR_BUILDINGS: { id: string; door: HexPos; shape: Footing; ground: Biome; facing?: number }[] = [
  { id: "pub", door: HARBOR_PUB, shape: "trio", ground: "cobble" },
  { id: "lighthouse", door: HARBOR_LIGHTHOUSE, shape: "flower", ground: "mud" },
  { id: "works", door: HARBOR_WORKS, shape: "pair", ground: "cobble", facing: 5 },
  { id: "shop", door: HARBOR_SHOP, shape: "pair", ground: "cobble", facing: 5 },
  { id: "apothecary", door: HARBOR_APOTHECARY, shape: "trio", ground: "cobble", facing: 3 },
  { id: "smithy", door: HARBOR_SMITHY, shape: "trio", ground: "cobble" },
  { id: "galley", door: HARBOR_GALLEY, shape: "trio", ground: "cobble", facing: 4 },
  { id: "fishing", door: HARBOR_GATHER.fishing, shape: "pair", ground: "mud" },
  { id: "townchest", door: HARBOR_CHEST, shape: "single", ground: "cobble" },
  { id: "board", door: HARBOR_BOARD, shape: "single", ground: "cobble", facing: 5 },
  { id: "bench", door: HARBOR_BENCH, shape: "single", ground: "cobble", facing: 5 },
  ...HARBOR_PLOTS.map((door, i) => ({ id: `plot:${i}`, door, shape: "pair" as const, ground: "plains" as const, facing: HARBOR_PLOT_FACING[i] })),
];

/**
 * The town's roads, each a straight run (or a zigzag, for a lane that must head due north or south, which no
 * row of hexes does): where it starts and the sides it steps out through, in `HARBOR_SIDES` order. Cobbled
 * streets are laid as cobble hexes; dirt lanes as paths across the grass, joining wherever they meet.
 */
export interface HarborRoad {
  kind: "cobble" | "dirt";
  from: HexPos;
  steps: number[];
}
const run = (side: number, n: number) => Array<number>(n).fill(side);
const zigzag = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? b : a));
export const HARBOR_ROADS: HarborRoad[] = [
  // The High Street, east and west through the plaza, from the sparring ring to the pub.
  { kind: "cobble", from: at(6, 15), steps: run(1, 14) },
  // The two roads down from the plaza to the quay, the works on the west one and the galley on the east.
  { kind: "cobble", from: at(13, 16), steps: run(3, 6) },
  { kind: "cobble", from: at(14, 16), steps: run(2, 6) },
  // The lane up to the caverns' mouth, due north, so zigzagging.
  { kind: "dirt", from: at(13, 14), steps: zigzag(0, 5, 11) },
  // The hut lanes, up from the High Street to the north-west and the north-east.
  { kind: "dirt", from: at(10, 15), steps: run(5, 6) },
  { kind: "dirt", from: at(16, 15), steps: run(0, 6) },
  // Along the shore from the quay roads: west to the fish shack, east toward the lighthouse.
  { kind: "dirt", from: at(11, 19), steps: run(4, 5) },
  { kind: "dirt", from: at(15, 19), steps: run(1, 5) },
];

/** The hexes a road covers, its start first. */
export function roadHexes(road: HarborRoad): HexPos[] {
  const out = [road.from];
  for (const side of road.steps) {
    const p = out[out.length - 1];
    const d = HARBOR_SIDES[side];
    out.push({ q: p.q + d.q, r: p.r + d.r });
  }
  return out;
}

/** Every hex a building stands on, by the door it belongs to. */
const DOOR_OF = new Map<string, HexPos>(HARBOR_BUILDINGS.flatMap((b) => footing(b.door, b.shape, b.facing).map((p) => [keyOf(p), b.door] as [string, HexPos])));

/**
 * The door of the building standing on a hex, if one does: pointing at any part of a building is pointing at the
 * place, and walking "to" it is walking to its door.
 */
export function harborDoor(pos: HexPos): HexPos | null {
  return DOOR_OF.get(keyOf(pos)) ?? null;
}

const HEIGHT: Record<Biome, number> = { sand: 0.22, water: 0.05, plains: 0.3, forest: 0.42, hills: 0.75, dock: 0.1, cobble: 0.26, mud: 0.2, rampart: 0.7, floor: 0.1, wall: 0.9, cave: 0.18, rock: 1.4, gate: 0.18, fog: 0.3 };

export function harborPoi(id: string, kind: PoiKind, pos: HexPos, facing = 0): Poi {
  return { id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [], ...(facing ? { facing } : {}) };
}

/** A fixed 0..1 value per hex, so the same ground is mud or scrub every time. */
const grit = (col: number, r: number) => {
  const n = Math.sin(col * 127.1 + r * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** The middle of the island, in hex widths across and down, and how far out its coast lies. */
const HEART = { x: 13.5, z: 14 * 0.866 };
const COAST = 10;

/** The six hexes round one. */
const NEIGHBOURS: HexPos[] = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
const around = (p: HexPos) => NEIGHBOURS.map((d) => ({ q: p.q + d.q, r: p.r + d.r }));

/**
 * The Harbor map. The same for every crew: a round island with the sea all
 * about it, its coast a little ragged. A line of great mossy boulders on a low
 * bank curves round the north, gapped in places, with the caverns' mouth in the middle of it; trees
 * stand on the west and east shoulders where the wall never reached; and the
 * south shore is a quay of bare earth with three piers, the sea beyond them
 * dotted with rocks and a wreck. Inland it is grass, with a cobbled plaza at
 * the heart and the town laid out along its roads (HARBOR_ROADS): the High
 * Street east and west through the plaza, two roads down to the quay, and dirt
 * lanes up to the huts and the caverns. Every building fronts a road. At the
 * back, north-east of the plaza, one old oak stands on a hill in tall grass.
 * A building is bigger than the hex its door is on: it stands on the hexes
 * behind the door (see `footing`), which are marked `built` and cannot be walked through.
 */
export function generateHarbor(): WorldMap {
  const tiles: Tile[] = allHexesInGrid(HARBOR_GRID).map((pos) => {
    const col = colOf(pos);
    let biome: Biome;
    // How far this hex is from the island's heart, and which way: 0 is due north, turning either way to π at south.
    const dx = col + (pos.r % 2 ? 0.5 : 0) - HEART.x;
    const dz = pos.r * 0.866 - HEART.z;
    const out = Math.hypot(dx, dz);
    const turn = Math.atan2(dx, -dz);
    const north = Math.abs(turn);
    // The coast: a circle, pushed in and out a little so it is not drawn with a compass.
    const coast = COAST + 0.4 * Math.sin(3 * turn + 1.0) + 0.3 * Math.sin(5 * turn + 2.2);
    if (out > coast) biome = "water";
    // The rim: boulders round the north (a gap of rubble here and there), bare shore to the south.
    else if (out > coast - 1) biome = north < 1.25 ? (grit(col, pos.r) < 0.2 ? "hills" : "rampart") : north < 2 ? "forest" : "mud";
    // Trees stand deeper on the shoulders than the wall is thick.
    else if (out > coast - 2.2 && north >= 1.25 && north < 2) biome = "forest";
    // Inland it is all grass. Only the quay behind the south shore is worn bare.
    else biome = north > 2 && out > coast - 2.6 ? "mud" : "plains";
    // A fixed ripple so the ground is not perfectly flat, and a rampart that is not all one height.
    const ripple = ((pos.q * 7 + pos.r * 13) % 5) * 0.012;
    const h = biome === "rampart" ? HEIGHT.rampart - (grit(col, pos.r) < 0.3 ? 0.3 : 0) + ripple * 4 : HEIGHT[biome] + (biome === "plains" || biome === "mud" ? ripple : 0);
    return { q: pos.q, r: pos.r, biome, h };
  });
  const map: WorldMap = { grid: HARBOR_GRID, tiles, pois: [] };
  const lay = (pos: HexPos, biome: Biome) => {
    const t = tileAt(map, pos);
    if (!t) return undefined;
    t.biome = biome;
    t.h = HEIGHT[biome];
    return t;
  };
  // The square: cobbles under the place everyone arrives and two rings round it. And under the sparring ring.
  for (const p of [...HARBOR_SQUARE, HARBOR_RING]) lay(p, "cobble");
  // The cobbled streets, before the buildings that front them.
  for (const road of HARBOR_ROADS) if (road.kind === "cobble") for (const p of roadHexes(road)) lay(p, "cobble");
  // Each building's ground: its doorstep and the hexes it stands on, all level. Nobody walks through the building.
  for (const b of HARBOR_BUILDINGS) {
    lay(b.door, b.ground);
    for (const p of footing(b.door, b.shape, b.facing)) {
      const t = lay(p, b.ground);
      if (t) t.built = true;
    }
  }
  // The piers: planking from each pier head back to the shore.
  for (const head of HARBOR_PIERS) {
    let p = head;
    for (let i = 0; i < 6 && tileAt(map, p)?.biome === "water"; i++) {
      lay(p, "dock");
      // Straight back toward the land: up-right then up-left, so the planking does not wander off sideways.
      p = i % 2 ? { q: p.q, r: p.r - 1 } : { q: p.q + 1, r: p.r - 1 };
    }
  }
  // The lighthouse's point: bare ground round its doorstep, out into the sea, so the tower can be walked up to.
  for (const p of around(HARBOR_LIGHTHOUSE)) if (tileAt(map, p)?.biome === "water") lay(p, "mud");
  // The caverns' mouth: rubble underfoot where the wall gives way to the rock.
  lay(HARBOR_CAVE, "hills");
  // The gathering spots keep the ground they are about.
  lay(HARBOR_GATHER.quarry, "hills");
  lay(HARBOR_GATHER.felling, "forest");
  raiseOakHill(map);
  layPaths(map);
  map.pois = [
    harborPoi("board", "board", HARBOR_BOARD), harborPoi("shop", "shop", HARBOR_SHOP), harborPoi("ring", "ring", HARBOR_RING),
    harborPoi("pub", "pub", HARBOR_PUB), harborPoi("works", "works", HARBOR_WORKS),
    harborPoi("apothecary", "apothecary", HARBOR_APOTHECARY), harborPoi("smithy", "smithy", HARBOR_SMITHY),
    harborPoi("galley", "galley", HARBOR_GALLEY),
    harborPoi("lighthouse", "lighthouse", HARBOR_LIGHTHOUSE),
    harborPoi("bench", "bench", HARBOR_BENCH),
    harborPoi("townchest", "townchest", HARBOR_CHEST),
    harborPoi("fishing", "fishing", HARBOR_GATHER.fishing),
    harborPoi("felling", "felling", HARBOR_GATHER.felling),
    harborPoi("quarry", "quarry", HARBOR_GATHER.quarry),
    harborPoi("cave", "cave", HARBOR_CAVE),
    ...HARBOR_ROCKS.map((p, i) => harborPoi(`rocks:${i}`, "rocks", p)),
    harborPoi("wreck", "wreck", HARBOR_WRECK),
  ].map((p) => {
    const facing = HARBOR_BUILDINGS.find((b) => b.id === p.id)?.facing;
    return facing ? { ...p, facing } : p;
  });
  return map;
}

/**
 * The oak's hill: its hex raised highest, with the oak on it; the six round it raised half as far; and tall
 * grass over all of them and over the open grass at the hill's foot.
 */
function raiseOakHill(map: WorldMap) {
  const top = tileAt(map, HARBOR_OAK);
  if (!top) return;
  top.h = HEIGHT.plains + 0.62;
  top.blocker = "oak";
  top.grass = "tall";
  const ring = around(HARBOR_OAK);
  for (const p of ring) {
    const t = tileAt(map, p);
    if (!t || t.biome !== "plains" || t.built) continue;
    t.h = HEIGHT.plains + 0.3;
    t.grass = "tall";
  }
  const hill = new Set([HARBOR_OAK, ...ring].map(keyOf));
  for (const p of ring.flatMap(around)) {
    const t = tileAt(map, p);
    if (!t || hill.has(keyOf(p)) || t.biome !== "plains" || t.built) continue;
    t.h = HEIGHT.plains + 0.09;
    t.grass = "tall";
  }
}

/** Ground a dirt path can be trodden into: open grass, not under a building. */
const trodden = (t: Tile | undefined): t is Tile => !!t && t.biome === "plains" && !t.built;
/** Ground a path can run up to and stop at: a street, the bare quay, the woods or the hills it leads into. */
const meets = (t: Tile | undefined) => !!t && !t.built && ["cobble", "mud", "dock", "forest", "hills"].includes(t.biome);

/**
 * Tread the dirt lanes into the grass: each step of a lane joins the two hexes it crosses between, on whichever
 * of them is grass. Then each building on the grass (a hut) gets a short path from its doorstep out to the road
 * in front of it, if one passes there.
 */
function layPaths(map: WorldMap) {
  const join = (a: HexPos, side: number) => {
    const d = HARBOR_SIDES[side];
    const b = { q: a.q + d.q, r: a.r + d.r };
    const ta = tileAt(map, a), tb = tileAt(map, b);
    if (!ta || !tb) return;
    const ok = (t: Tile, other: Tile) => trodden(t) && (trodden(other) || meets(other));
    if (ok(ta, tb)) ta.path = (ta.path ?? 0) | (1 << side);
    if (ok(tb, ta)) tb.path = (tb.path ?? 0) | (1 << ((side + 3) % 6));
  };
  for (const road of HARBOR_ROADS) {
    if (road.kind !== "dirt") continue;
    let p = road.from;
    for (const side of road.steps) {
      join(p, side);
      const d = HARBOR_SIDES[side];
      p = { q: p.q + d.q, r: p.r + d.r };
    }
  }
  for (const b of HARBOR_BUILDINGS) {
    if (!trodden(tileAt(map, b.door))) continue;
    for (const [i, front] of frontOf(b.door, b.facing).entries()) {
      const t = tileAt(map, front);
      if (!t || !(t.path || t.biome === "cobble")) continue;
      join(b.door, ([2, 3][i] + (b.facing ?? 0)) % 6);
      break;
    }
  }
}

/** Longest walk the server will accept in one request. */
export const HARBOR_MAX_PATH = 60;

/**
 * A walkable route between two Harbor hexes, or null. Every step costs the same here; the rampart cannot be
 * crossed, nor a building walked through, nor the water crossed without a boat. A barrel keeps to water beside
 * the land; a rowboat goes anywhere on it. Neither goes onto the rocks or the wreck.
 */
export function harborPath(map: WorldMap, from: HexPos, to: HexPos, vessel: Vessel | null = null): HexPos[] | null {
  const route = findPath(map, from, to, HARBOR_MAX_PATH, (t) => {
    if (t.biome === "rampart" || t.built || t.blocker) return Infinity;
    if (t.biome !== "water") return 1;
    if (!vessel || HAZARDS.has(`${t.q},${t.r}`)) return Infinity;
    return vessel === "rowboat" || coastal(map, t) ? 1 : Infinity;
  });
  return route && route.path.length > 0 ? route.path : null;
}

/** The rocks and the wreck stand in the water: no boat goes onto them. */
const HAZARDS = new Set([...HARBOR_ROCKS, HARBOR_WRECK].map((p) => `${p.q},${p.r}`));

/** Water beside land (or a pier): where a barrel can go. */
export function coastal(map: WorldMap, p: HexPos): boolean {
  return around(p).some((n) => {
    const t = tileAt(map, n);
    return !!t && t.biome !== "water";
  });
}

/** A water hex at the edge of the map: from here a rowboat can row out to the open sea. */
export function seaEdge(map: WorldMap, p: HexPos): boolean {
  return tileAt(map, p)?.biome === "water" && around(p).some((n) => !tileAt(map, n));
}

/**
 * The fishing spot for a hero afloat on a water hex: by the rocks or the wreck; otherwise the coast's water by
 * which side of the island it is on. Null on land.
 */
export function waterSpotAt(map: WorldMap, p: HexPos): Exclude<FishSpot, "west" | "middle" | "east" | "shore" | "sea"> | null {
  if (tileAt(map, p)?.biome !== "water") return null;
  if ([...HAZARDS].some((k) => around(p).some((n) => `${n.q},${n.r}` === k))) return "wreck";
  const col = p.q + Math.floor(p.r / 2);
  const mid = HARBOR_SPAWN.q + Math.floor(HARBOR_SPAWN.r / 2);
  return col <= mid - 4 ? "coast_west" : col >= mid + 5 ? "coast_east" : "coast_south";
}

// ---------- wire types ----------

export interface HarborPlayer {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** XP into their current level, for the bar over their head. Absent from presence saved before it was sent. */
  xp?: number;
  pos: HexPos;
  /** What they are visibly wearing. */
  outfit?: Outfit;
  /** Where their bedroll is laid out, until they walk off. */
  bedroll?: HexPos;
  /** Fishing at the pier they stand on, rod in hand, until they stop or walk off. */
  fishing?: boolean;
  /** The best boat they own: drawn under them whenever they are on the water. */
  vessel?: Vessel | null;
  /** They have filled the Catch Book: their rod is gilded. */
  gilded?: boolean;
  /** In a hut: the bed (a furnishing id) they are lying on after a rest, until they walk off. */
  bed?: number;
}

/**
 * What anyone sharing a crew or a voyage may see of a hero, for the sheet
 * that opens on hovering or clicking them. Game facts only: no email, no
 * gold, nothing in their pack or at home.
 */
export interface PublicHero {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** XP into the current level. */
  xp: number;
  /** Stats without gear, and what the worn gear adds. */
  base: Stats;
  bonus: Partial<Stats>;
  weaponPower: number;
  armor: number;
  /** What they wear, one item per slot. */
  gear: ItemDef[];
  /** What the furniture in their hut gives them on a voyage. */
  hutPerks?: Perk;
  /** How they chose to look, if they did. */
  appearance?: Appearance;
}

export interface HarborMember {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** How big their hut is, so its building can be drawn to match. Absent from boards saved before tiers. */
  hutTier?: number;
  /** Which plot they have bought (an index into HARBOR_PLOTS), or null while they sleep on a bedroll. */
  plot?: number | null;
  /**
   * What is in the resource bin on their plot while the shack is still to be
   * raised. Absent once the shack stands (and on boards saved before bins).
   */
  bin?: Resources;
  /** Out on a zone right now: which one, and whether they are in a fight there (nobody can teleport into one). */
  zone?: { code: string; fighting: boolean };
}

export interface HarborShip {
  code: string;
  captain: string;
  aboard: string[];
  /** lobby: moored and boardable. Anything else: away at an island. */
  phase: string;
  /** Story title once the voyage is under way. */
  title: string | null;
  day: number | null;
  /** Index into HARBOR_PIERS while moored, else null. Never set for a delve, which gathers at the cave mouth. */
  pier: number | null;
  /** A voyage, or a delve into the Haunted Caverns. Absent from boards sent before caverns: a voyage. */
  kind?: "voyage" | "caverns";
}

export interface HarborLogEntry {
  code: string;
  title: string;
  outcome: "victory" | "defeat";
  crew: string[];
  at: number;
}

export interface HarborBoard {
  members: HarborMember[];
  ships: HarborShip[];
  log: HarborLogEntry[];
  /** The crew's shared projects and who gave what lately. */
  works?: HarborWorks;
}

/**
 * A hero just earned XP at the Harbor, in a hut or at the pub. Sent by the
 * server once the award is written, to everyone in the room the hero is in:
 * their new level and XP for the plate, and the amount for the sparkle.
 */
export interface XpMessage {
  type: "xp";
  id: string;
  amount: number;
  level: number;
  xp: number;
  levelsGained: number;
}

export type HarborServerMessage =
  | ({ type: "snapshot"; you: string; crew: { id: string; name: string }; players: HarborPlayer[] } & HarborBoard)
  | ({ type: "board" } & HarborBoard)
  | { type: "joined"; player: HarborPlayer }
  | { type: "left"; id: string }
  | { type: "moved"; id: string; path: HexPos[] }
  /** Someone was put straight onto `pos` (no walk): a stuck hero sent back by "unstick". */
  | { type: "placed"; id: string; pos: HexPos }
  | { type: "said"; id: string; name: string; text: string }
  /** A trade you are part of changed (opened, laid out, accepted, closed): ask the server for your trades again. Sent to that player only. */
  | { type: "trades" }
  | LookMessage
  | XpMessage;

export type HarborClientMessage =
  | { type: "move"; to: HexPos }
  | { type: "say"; text: string }
  | LookRequest
  /** "I changed my gear or level": the server re-reads the sender's character and tells everyone. */
  | { type: "refresh" }
  /** "I have just rested here": lay the sender's bedroll out where they stand, for everyone to see. */
  | { type: "bedroll" }
  /** "I have sat down to fish here" (or stood up again): the sender's hero holds a rod, for everyone to see. */
  | { type: "fishing"; on: boolean }
  /** "I am stuck or lost": put the sender's own hero back where heroes arrive. At most once per UNSTICK_COOLDOWN_MS. */
  | { type: "unstick" };

/**
 * Which way a hero is looking as they stand: toward wherever their player's pointer is on the ground. It is
 * only for show, so it is sent coarsely (one of LOOK_STEPS directions round the compass), at most every
 * LOOK_MIN_MS, relayed to everyone else in the same place and never kept: someone who walks in sees a hero
 * facing the way they last walked until that hero's player next moves the pointer.
 */
export const LOOK_STEPS = 32;
export const LOOK_MIN_MS = 120;
/** "I am looking this way": a step round the compass, 0 toward +z, turning toward +x. */
export type LookRequest = { type: "look"; look: number };
/** "They are looking this way". Not sent back to whoever is looking. */
export type LookMessage = { type: "looked"; id: string; look: number };
/** The step a turn about y, in radians, falls in; and the turn a step stands for. */
export const lookStep = (yaw: number) => ((Math.round((yaw / (Math.PI * 2)) * LOOK_STEPS) % LOOK_STEPS) + LOOK_STEPS) % LOOK_STEPS;
export const lookYaw = (step: number) => (step / LOOK_STEPS) * Math.PI * 2;
/** A look as a client sent it, if it is one: a whole step in range. */
export function validLook(look: unknown): number | null {
  return typeof look === "number" && Number.isInteger(look) && look >= 0 && look < LOOK_STEPS ? look : null;
}

/** How often a hero may ask to be put back where they arrive (Harbor, hut or pub), per connection. */
export const UNSTICK_COOLDOWN_MS = 3000;

export const HARBOR_MAX_SAY = 200;
export const MAX_CREW = 40;
