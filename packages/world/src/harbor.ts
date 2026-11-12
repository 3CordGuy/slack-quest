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

const HEIGHT: Record<Biome, number> = { water: 0.05, plains: 0.3, forest: 0.42, hills: 0.75, dock: 0.1, floor: 0.1, wall: 0.9 };

export function harborPoi(id: string, kind: PoiKind, pos: HexPos): Poi {
  return { id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [] };
}

/**
 * The Harbor map. The same for every crew: a tree line at the back, a hut
 * district, a plaza with the notice board, then the shore and three piers
 * running out into the sea at the front.
 */
export function generateHarbor(): WorldMap {
  const pierKeys = new Set(HARBOR_PIERS.map((p) => `${p.q},${p.r}`));
  const tiles: Tile[] = allHexesInGrid(HARBOR_GRID).map((pos) => {
    const col = colOf(pos);
    let biome: Biome = "plains";
    if (pos.r === 0) biome = col % 4 === 1 ? "hills" : "forest";
    else if (pos.r >= 8) biome = pierKeys.has(`${pos.q},${pos.r}`) ? "dock" : "water";
    else if ((col === 0 || col >= 12) && pos.r <= 5) biome = "forest";
    if (pos.q === HARBOR_GATHER.quarry.q && pos.r === HARBOR_GATHER.quarry.r) biome = "hills";
    // A fixed ripple so the ground is not perfectly flat.
    const ripple = ((pos.q * 7 + pos.r * 13) % 5) * 0.012;
    return { q: pos.q, r: pos.r, biome, h: HEIGHT[biome] + (biome === "plains" ? ripple : 0) };
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
    ],
  };
}

/** Longest walk the server will accept in one request. */
export const HARBOR_MAX_PATH = 60;

/** A walkable route between two Harbor hexes, or null. Every step costs the same here. */
export function harborPath(map: WorldMap, from: HexPos, to: HexPos): HexPos[] | null {
  const route = findPath(map, from, to, HARBOR_MAX_PATH, (t) => (t.biome === "water" ? Infinity : 1));
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
}

export interface HarborMember {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** How big their hut is, so its building can be drawn to match. Absent from boards saved before tiers. */
  hutTier?: number;
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
;

export const HARBOR_MAX_SAY = 200;
export const MAX_CREW = 40;
