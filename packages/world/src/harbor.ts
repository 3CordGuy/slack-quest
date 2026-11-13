// The Harbor: a crew's shared, walkable base between voyages.
//
// Unlike an island it is not turn-based and has no reducer: players walk
// freely, and the HarborRoom Durable Object only validates paths and relays
// them. This file holds the fixed map and the message shapes both sides use.

import { allHexesInGrid, type HexGrid, type HexPos } from "@gantt-quest/core";
import type { Outfit } from "./gear";
import type { FishSpot } from "./fishing";
import type { Perk, Resources } from "./hut";
import type { ItemDef } from "./gear";
import type { Stats } from "@gantt-quest/core";
import type { HarborWorks } from "./projects";
import { findPath, type Biome, type Poi, type PoiKind, type Tile, type WorldMap } from "./map";

/** What the crew's home port is called, wherever its name is shown. */
export const HARBOR_NAME = "Heylets Harbor";

export const HARBOR_GRID: HexGrid = { cols: 16, rows: 17 };

/** Offset column (visual left-to-right index) of an axial hex. */
const colOf = (p: HexPos) => p.q + Math.floor(p.r / 2);
const at = (col: number, r: number): HexPos => ({ q: col - Math.floor(r / 2), r });

/** Where a player appears on arrival: the middle of the plaza, at the island's heart. */
export const HARBOR_SPAWN: HexPos = at(7, 7);
/** Pier heads, off the south shore. A moored ship sits in the water just beyond each one. */
export const HARBOR_PIERS: HexPos[] = [at(5, 14), at(8, 14), at(11, 14)];
/**
 * Hut plots, handed out to crew members in the order they joined. Scattered round the island the way a village
 * grows, not laid out in rows: the first few near the plaza, the later ones out toward the trees and the shore.
 */
export const HARBOR_PLOTS: HexPos[] = [
  at(6, 3), at(9, 4), at(5, 5), at(8, 3), at(10, 5), at(4, 4),
  at(6, 9), at(11, 8), at(3, 8), at(9, 2), at(10, 10), at(5, 10),
];
export const HARBOR_BOARD: HexPos = at(7, 5);
/** The market stall, where gear is bought and sold. */
export const HARBOR_SHOP: HexPos = at(10, 6);
/** The sparring ring, where crewmates try out their gear. */
export const HARBOR_RING: HexPos = at(4, 7);
/** Gathering spots at the edges: the south-west shore, the western trees, and an outcrop in the east wall. */
export const HARBOR_GATHER = { fishing: at(4, 12), felling: at(1, 7), quarry: at(12, 5) } as const;
/** Where a fishing sitting can be started: each pier head, and the old spot on the south-west shore. The open sea is reached by boat. */
export const HARBOR_FISH_SPOTS: Record<Exclude<FishSpot, "sea">, HexPos> = {
  west: HARBOR_PIERS[0],
  middle: HARBOR_PIERS[1],
  east: HARBOR_PIERS[2],
  shore: HARBOR_GATHER.fishing,
};
/** The fishing spot on a hex, if there is one. */
export function fishSpotAt(pos: HexPos): Exclude<FishSpot, "sea"> | null {
  for (const [id, p] of Object.entries(HARBOR_FISH_SPOTS) as [Exclude<FishSpot, "sea">, HexPos][]) if (p.q === pos.q && p.r === pos.r) return id;
  return null;
}
/** The pub: food, drink, the barkeep and the dice table are inside. */
export const HARBOR_PUB: HexPos = at(9, 8);
/** The works: the builders' yard where the crew's shared projects are paid for. */
export const HARBOR_WORKS: HexPos = at(5, 8);
/**
 * The lighthouse's spot: out on the south-east point, over the wreck, where
 * ships pass out of the harbour. Not in the plaza, where a tall tower would
 * hide the town. A bare point (then a building site) until the crew has paid
 * for it at the works.
 */
export const HARBOR_LIGHTHOUSE: HexPos = at(12, 11);
/** The apothecary's spot, beside the market stall. A building site until the crew has paid for it. */
export const HARBOR_APOTHECARY: HexPos = at(11, 6);
/** The smithy's spot, beside the sparring ring. A building site until the crew has paid for it. */
export const HARBOR_SMITHY: HexPos = at(4, 6);
/** The galley's spot, above the quay between the middle and east piers, where ships take on provisions. A building site until the crew has paid for it. */
export const HARBOR_GALLEY: HexPos = at(10, 11);

/** The mouth of the Haunted Caverns: a way into the rocks through the north wall. */
export const HARBOR_CAVE: HexPos = at(7, 1);

/** Rocks standing out of the water, and the wreck on them. Scenery: nobody can reach them. */
export const HARBOR_ROCKS: HexPos[] = [at(2, 11), at(3, 13), at(13, 13), at(13, 3), at(2, 4)];
export const HARBOR_WRECK: HexPos = at(13, 12);

const HEIGHT: Record<Biome, number> = { water: 0.05, plains: 0.3, forest: 0.42, hills: 0.75, dock: 0.1, cobble: 0.26, mud: 0.2, rampart: 1.25, floor: 0.1, wall: 0.9, cave: 0.18, rock: 1.4, gate: 0.18, fog: 0.3 };

export function harborPoi(id: string, kind: PoiKind, pos: HexPos): Poi {
  return { id, kind, pos, hidden: false, cleared: false, usedBy: [], enemies: [] };
}

/** A fixed 0..1 value per hex, so the same ground is mud or scrub every time. */
const grit = (col: number, r: number) => {
  const n = Math.sin(col * 127.1 + r * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

/** The middle of the island, in hex widths across and down. */
const HEART = { x: 7.5, z: 7 * 0.866 };

/**
 * The Harbor map. The same for every crew: a round island with the sea all
 * about it, its coast a little ragged. An old stone rampart curves round the
 * north, fallen in places, with the caverns' mouth in the middle of it; trees
 * stand on the west and east shoulders where the wall never reached; and the
 * south shore is a quay of bare earth with three piers, the sea beyond them
 * dotted with rocks and a wreck. Inland it is grass, with a plaza at the
 * heart, the crew's places round it, and hut plots scattered between.
 * Only the ground under each place is cobbled.
 */
export function generateHarbor(): WorldMap {
  const pierKeys = new Set(HARBOR_PIERS.map((p) => `${p.q},${p.r}`));
  // Only the ground a place stands on is paved; everything else is packed earth and grass, so the town reads quietly.
  const paved = new Set([HARBOR_BOARD, HARBOR_SHOP, HARBOR_RING, HARBOR_PUB, HARBOR_WORKS, HARBOR_APOTHECARY, HARBOR_SMITHY, HARBOR_GALLEY, HARBOR_SPAWN].map((p) => `${p.q},${p.r}`));
  const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
  const tiles: Tile[] = allHexesInGrid(HARBOR_GRID).map((pos) => {
    const col = colOf(pos);
    let biome: Biome;
    let h: number | null = null;
    // How far this hex is from the island's heart, and which way: 0 is due north, turning either way to π at south.
    const dx = col + (pos.r % 2 ? 0.5 : 0) - HEART.x;
    const dz = pos.r * 0.866 - HEART.z;
    const out = Math.hypot(dx, dz);
    const turn = Math.atan2(dx, -dz);
    const north = Math.abs(turn);
    // The coast: a circle, pushed in and out a little so it is not drawn with a compass.
    const coast = 5.9 + 0.25 * Math.sin(3 * turn + 1.0) + 0.2 * Math.sin(5 * turn + 2.2);
    if (out > coast) biome = pierKeys.has(`${pos.q},${pos.r}`) ? "dock" : "water";
    else if (out > coast - 1) {
      // The rim: wall round the north (rubble where it has come down), trees on the shoulders, bare shore to the south.
      biome = north < 1.25 ? (grit(col, pos.r) < 0.2 ? "hills" : "rampart") : north < 2 ? "forest" : "mud";
    } else if (paved.has(`${pos.q},${pos.r}`)) biome = "cobble";
    // Inland it is all grass. Only the quay behind the south shore is worn bare.
    else biome = north > 2 && out > coast - 2 ? "mud" : "plains";
    // The caverns' mouth: rubble underfoot where the wall gives way to the rock.
    if (same(pos, HARBOR_CAVE)) biome = "hills";
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
      harborPoi("apothecary", "apothecary", HARBOR_APOTHECARY), harborPoi("smithy", "smithy", HARBOR_SMITHY),
      harborPoi("galley", "galley", HARBOR_GALLEY),
      harborPoi("lighthouse", "lighthouse", HARBOR_LIGHTHOUSE),
      harborPoi("fishing", "fishing", HARBOR_GATHER.fishing),
      harborPoi("felling", "felling", HARBOR_GATHER.felling),
      harborPoi("quarry", "quarry", HARBOR_GATHER.quarry),
      harborPoi("cave", "cave", HARBOR_CAVE),
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
  /** XP into their current level, for the bar over their head. Absent from presence saved before it was sent. */
  xp?: number;
  pos: HexPos;
  /** What they are visibly wearing. */
  outfit?: Outfit;
  /** Where their bedroll is laid out, until they walk off. */
  bedroll?: HexPos;
  /** Fishing at the pier they stand on, rod in hand, until they stop or walk off. */
  fishing?: boolean;
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
  | XpMessage;

export type HarborClientMessage =
  | { type: "move"; to: HexPos }
  | { type: "say"; text: string }
  /** "I changed my gear or level": the server re-reads the sender's character and tells everyone. */
  | { type: "refresh" }
  /** "I have just rested here": lay the sender's bedroll out where they stand, for everyone to see. */
  | { type: "bedroll" }
  /** "I have sat down to fish here" (or stood up again): the sender's hero holds a rod, for everyone to see. */
  | { type: "fishing"; on: boolean }
  /** "I am stuck or lost": put the sender's own hero back where heroes arrive. At most once per UNSTICK_COOLDOWN_MS. */
  | { type: "unstick" };

/** How often a hero may ask to be put back where they arrive (Harbor, hut or pub), per connection. */
export const UNSTICK_COOLDOWN_MS = 3000;

export const HARBOR_MAX_SAY = 200;
export const MAX_CREW = 40;
