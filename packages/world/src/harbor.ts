// The Harbor: a crew's shared, walkable base between voyages.
//
// Unlike an island it is not turn-based and has no reducer: players walk
// freely, and the HarborRoom Durable Object only validates paths and relays
// them. This file holds the fixed map and the message shapes both sides use.

import { allHexesInGrid, type HexGrid, type HexPos } from "@gantt-quest/core";
import type { Outfit } from "./gear";
import type { HarborWorks } from "./projects";
import { findPath, type Biome, type Poi, type PoiKind, type Tile, type WorldMap } from "./map";

/** What the crew's home port is called, wherever its name is shown. */
export const HARBOR_NAME = "Heylets Harbor";

export const HARBOR_GRID: HexGrid = { cols: 13, rows: 11 };

/** Offset column (visual left-to-right index) of an axial hex. */
const colOf = (p: HexPos) => p.q + Math.floor(p.r / 2);
const at = (col: number, r: number): HexPos => ({ q: col - Math.floor(r / 2), r });

/** Where a player appears on arrival: the middle of the plaza. */
export const HARBOR_SPAWN: HexPos = at(6, 6);
/** Pier heads. A moored ship sits in the water just beyond each one. */
export const HARBOR_PIERS: HexPos[] = [at(2, 8), at(6, 8), at(10, 8)];
/** Hut plots, handed out to crew members in the order they joined: front row first, from the middle outward. */
export const HARBOR_PLOTS: HexPos[] = [3, 1].flatMap((r) => [5, 7, 3, 9, 1, 11].map((col) => at(col, r)));
export const HARBOR_BOARD: HexPos = at(6, 4);
/** The market stall, where gear is bought and sold. */
export const HARBOR_SHOP: HexPos = at(9, 5);
/** The sparring ring, where crewmates try out their gear. */
export const HARBOR_RING: HexPos = at(3, 5);
/** Gathering spots at the edges: the west shore, the western tree line, and an outcrop in the east. */
export const HARBOR_GATHER = { fishing: at(0, 7), felling: at(0, 3), quarry: at(12, 2) } as const;
/** The pub: food, drink, the barkeep and the dice table are inside. */
export const HARBOR_PUB: HexPos = at(8, 6);
/** The works: where the crew's shared projects are paid for, and where the lighthouse goes up. */
export const HARBOR_WORKS: HexPos = at(5, 6);

/** Rocks standing out of the water, and the wreck on them. Scenery: nobody can reach them. */
export const HARBOR_ROCKS: HexPos[] = [at(0, 9), at(4, 9), at(8, 10), at(1, 10), at(12, 10)];
export const HARBOR_WRECK: HexPos = at(11, 9);

const HEIGHT: Record<Biome, number> = { water: 0.05, plains: 0.3, forest: 0.42, hills: 0.75, dock: 0.1, cobble: 0.26, mud: 0.2, rampart: 1.25, floor: 0.1, wall: 0.9, fog: 0.3 };

export function harborPoi(id: string, kind: PoiKind, pos: HexPos): Poi {
  return { id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [] };
}

/** A fixed 0..1 value per hex, so the same ground is mud or scrub every time. */
const grit = (col: number, r: number) => {
  const n = Math.sin(col * 127.1 + r * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** The streets: a quay along the shore, a lane between the two rows of huts, the plaza, and the road joining them. */
function isStreet(col: number, r: number): boolean {
  if (r === 7) return col >= 1 && col <= 11;
  if (r === 2) return col >= 1 && col <= 11;
  if (r === 6) return col >= 4 && col <= 9;
  if (r === 5) return col >= 3 && col <= 9;
  return col === 6 && r >= 2 && r <= 7;
}

/**
 * The Harbor map. The same for every crew, and not a tidy rectangle: the sea
 * comes round its back corners and into its sides, and the shore runs out
 * in spits of shingle. An old stone rampart at the back and down the sides,
 * fallen in places; two rows of hut plots with a dirt
 * lane between them; a plaza; a quay along the shore with three piers; and
 * beyond them the sea, with rocks standing out of it and a wreck on the rocks.
 * Only the ground under each place is cobbled; the streets are dirt paths
 * and the rest is grass.
 */
export function generateHarbor(): WorldMap {
  const pierKeys = new Set(HARBOR_PIERS.map((p) => `${p.q},${p.r}`));
  // Only the ground a place stands on is paved; everything else is packed earth and grass, so the town reads quietly.
  const paved = new Set([HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_PUB, HARBOR_WORKS, HARBOR_SPAWN].map((p) => `${p.q},${p.r}`));
  const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
  const tiles: Tile[] = allHexesInGrid(HARBOR_GRID).map((pos) => {
    const col = colOf(pos);
    const last = (pos.r % 2 === 0 ? HARBOR_GRID.cols : HARBOR_GRID.cols - 1) - 1;
    let biome: Biome;
    let h: number | null = null;
    if (pos.r >= 8) biome = pierKeys.has(`${pos.q},${pos.r}`) ? "dock" : "water";
    else if (pos.r === 0) {
      // The back wall, breached in two places where it has come down into rubble.
      biome = col === 3 || col === 9 ? "hills" : "rampart";
    } else if (col === 0 || col >= last) {
      // The sides: trees at the back where the wall never reached, then wall down to the shore, broken low near the water.
      biome = pos.r <= 3 ? "forest" : pos.r <= 6 ? "rampart" : "mud";
      if (biome === "rampart" && pos.r === 6) h = 0.7;
    } else if (paved.has(`${pos.q},${pos.r}`)) biome = "cobble";
    // The old streets are worn dirt paths; off them it is grass, with the odd bare patch near the water.
    else if (isStreet(col, pos.r)) biome = "mud";
    else biome = pos.r >= 6 && grit(col, pos.r) < 0.3 ? "mud" : "plains";
    // The coast is not square. The sea comes round the back corners of the wall and bites into both sides,
    // and between and beyond the piers the shore runs out into shingle.
    if (pos.r === 0 && (col <= 1 || col >= last - 1)) biome = "water";
    if (pos.r === 6 && (col === 0 || col === last)) biome = "water";
    if (pos.r === 8 && biome === "water" && [4, 8, 11, 12].includes(col)) biome = "mud";
    if (biome !== "rampart") h = null;
    // The gathering spots keep the ground they are about.
    if (same(pos, HARBOR_GATHER.quarry)) biome = "hills";
    if (same(pos, HARBOR_GATHER.felling)) biome = "forest";
    if (same(pos, HARBOR_GATHER.fishing)) biome = "mud";
    // A fixed ripple so the ground is not perfectly flat, and a rampart that is not all one height.
    const ripple = ((pos.q * 7 + pos.r * 13) % 5) * 0.012;
    if (biome === "rampart" && h === null) h = HEIGHT.rampart - (grit(col, pos.r) < 0.3 ? 0.3 : 0) + ripple * 4;
    return { q: pos.q, r: pos.r, biome, h: h ?? HEIGHT[biome] + (biome === "plains" || biome === "mud" ? ripple : 0) };
  });
  return {
    grid: HARBOR_GRID,
    tiles,
    pois: [
      harborPoi("board", "board", HARBOR_BOARD), harborPoi("shop", "shop", HARBOR_SHOP), harborPoi("ring", "ring", HARBOR_RING),
      harborPoi("pub", "pub", HARBOR_PUB), harborPoi("works", "works", HARBOR_WORKS),
      harborPoi("fishing", "fishing", HARBOR_GATHER.fishing),
      harborPoi("felling", "felling", HARBOR_GATHER.felling),
      harborPoi("quarry", "quarry", HARBOR_GATHER.quarry),
      ...HARBOR_ROCKS.map((p, i) => harborPoi(`rocks:${i}`, "rocks", p)),
      harborPoi("wreck", "wreck", HARBOR_WRECK),
    ],
  };
}

/** Longest walk the server will accept in one request. */
export const HARBOR_MAX_PATH = 60;

/** A walkable route between two Harbor hexes, or null. Every step costs the same here; the sea and the rampart cannot be crossed. */
export function harborPath(map: WorldMap, from: HexPos, to: HexPos): HexPos[] | null {
  const route = findPath(map, from, to, HARBOR_MAX_PATH, (t) => (t.biome === "water" || t.biome === "rampart" ? Infinity : 1));
  return route && route.path.length > 0 ? route.path : null;
}

// ---------- wire types ----------

export interface HarborPlayer {
  id: string;
  name: string;
  classId: string;
  level: number;
  pos: HexPos;
  /** What they are visibly wearing. */
  outfit?: Outfit;
  /** Where their bedroll is laid out, until they walk off. */
  bedroll?: HexPos;
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
  /** Index into HARBOR_PIERS while moored, else null. */
  pier: number | null;
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

export type HarborServerMessage =
  | ({ type: "snapshot"; you: string; crew: { id: string; name: string }; players: HarborPlayer[] } & HarborBoard)
  | ({ type: "board" } & HarborBoard)
  | { type: "joined"; player: HarborPlayer }
  | { type: "left"; id: string }
  | { type: "moved"; id: string; path: HexPos[] }
  | { type: "said"; id: string; name: string; text: string }
;

export type HarborClientMessage =
  | { type: "move"; to: HexPos }
  | { type: "say"; text: string }
  /** "I changed my gear or level": the server re-reads the sender's character and tells everyone. */
  | { type: "refresh" }
  /** "I have just rested here": lay the sender's bedroll out where they stand, for everyone to see. */
  | { type: "bedroll" };

export const HARBOR_MAX_SAY = 200;
export const MAX_CREW = 40;
