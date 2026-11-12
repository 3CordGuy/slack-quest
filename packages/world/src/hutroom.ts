// The inside of a hut: a small hex room its owner furnishes and crewmates
// can visit.
//
// Like the Harbor it has no reducer. People walk freely and the HutRoom
// Durable Object checks each request against the rules here: where the walls
// are, where a furnishing may stand, and that furniture is walked around.

import { allHexesInGrid, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { harborPoi, type HarborPlayer } from "./harbor";
import { FURNISHINGS, HUT_TIERS, type Furnishing, type HutTier } from "./hut";
import { BASE_HEIGHT, findPath, poiAt, tileAt, type Tile, type WorldMap } from "./map";

/** The tier's entry in HUT_TIERS; an unknown tier is treated as the nearest real one. */
export function hutTier(tier: number): HutTier {
  return HUT_TIERS.find((t) => t.tier === tier) ?? (tier > HUT_TIERS.length ? HUT_TIERS[HUT_TIERS.length - 1] : HUT_TIERS[0]);
}

/** The room's grid: the tier's floor with one ring of wall around it. */
export function hutGrid(tier: number): HexGrid {
  const t = hutTier(tier);
  return { cols: t.cols + 2, rows: t.rows + 2 };
}

const rowWidth = (grid: HexGrid, r: number) => (r % 2 === 0 ? grid.cols : grid.cols - 1);
const colOf = (p: HexPos) => p.q + Math.floor(p.r / 2);

/** The door: a gap in the middle of the front wall. People arrive standing in it. */
export function hutDoor(tier: number): HexPos {
  const grid = hutGrid(tier);
  const r = grid.rows - 1;
  return { q: Math.floor(rowWidth(grid, r) / 2) - Math.floor(r / 2), r };
}

/** Height of the low front wall, so it does not hide the room from the camera. */
const FRONT_WALL_HEIGHT = 0.22;

/**
 * A room on `grid`: floor hexes ringed by wall, with the door (a `door` POI on
 * a floor hex) in the middle of the front wall. Huts and the pub are both built this way.
 */
export function buildRoom(grid: HexGrid): WorldMap {
  const r = grid.rows - 1;
  const door = { q: Math.floor(rowWidth(grid, r) / 2) - Math.floor(r / 2), r };
  const tiles: Tile[] = allHexesInGrid(grid).map((pos) => {
    const col = colOf(pos);
    const front = pos.r === grid.rows - 1;
    const edge = pos.r === 0 || front || col === 0 || col === rowWidth(grid, pos.r) - 1;
    if (!edge || (pos.q === door.q && pos.r === door.r)) return { q: pos.q, r: pos.r, biome: "floor", h: BASE_HEIGHT.floor };
    return { q: pos.q, r: pos.r, biome: "wall", h: front ? FRONT_WALL_HEIGHT : BASE_HEIGHT.wall };
  });
  return { grid, tiles, pois: [harborPoi("door", "door", door)] };
}

/** The room for a hut of this tier. The same every time. */
export function hutRoom(tier: number): WorldMap {
  return buildRoom(hutGrid(tier));
}

/** Floor hexes a furnishing could stand on: every floor hex but the door. */
export function hutFloor(room: WorldMap): HexPos[] {
  return room.tiles.filter((t) => t.biome === "floor" && poiAt(room, t)?.kind !== "door").map((t) => ({ q: t.q, r: t.r }));
}

/** The furnishings that are standing in the room, not in storage. */
export function placedFurnishings<T extends Pick<Furnishing, "q" | "r">>(furnishings: T[]): (T & { q: number; r: number })[] {
  return furnishings.filter((f): f is T & { q: number; r: number } => f.q !== null && f.r !== null);
}

export const validFacing = (facing: unknown): facing is number => Number.isInteger(facing) && (facing as number) >= 0 && (facing as number) <= 5;

/**
 * Why `defId` cannot be put down on `pos`, or null if it can. One furnishing
 * per floor hex, never on the door, a wall or off the map. To move a piece
 * that is already placed, leave it out of `placed`.
 */
export function placeProblem(room: WorldMap, placed: Pick<Furnishing, "q" | "r">[], defId: string, pos: HexPos): string | null {
  if (!FURNISHINGS[defId]) return "There is no such furnishing.";
  if (!Number.isInteger(pos.q) || !Number.isInteger(pos.r)) return "That is not a place in the room.";
  const tile = tileAt(room, pos);
  if (!tile) return "That is outside the room.";
  if (tile.biome !== "floor") return "That is a wall.";
  if (poiAt(room, pos)?.kind === "door") return "The doorway has to stay clear.";
  if (placed.some((f) => f.q === pos.q && f.r === pos.r)) return "Something already stands there.";
  return null;
}

/**
 * The placed furnishings that have no legal spot in a room of `tier`: off the
 * floor, on the doorway, or sharing a hex with an earlier piece. When a hut
 * changes size these go back to storage and the rest stay where they are.
 */
export function displacedFurnishings<T extends Pick<Furnishing, "defId" | "q" | "r">>(tier: number, furnishings: T[]): T[] {
  const room = hutRoom(tier);
  const kept: { q: number; r: number }[] = [];
  const out: T[] = [];
  for (const f of placedFurnishings(furnishings)) {
    if (placeProblem(room, kept, f.defId, f)) out.push(f);
    else kept.push({ q: f.q, r: f.r });
  }
  return out;
}

/** Longest walk the server will accept in one request. */
export const HUT_MAX_PATH = 40;

/** A walkable route between two hexes of the room, or null. Walls and placed furniture are walked around. */
export function hutPath(room: WorldMap, placed: Pick<Furnishing, "q" | "r">[], from: HexPos, to: HexPos): HexPos[] | null {
  const blocked = new Set(placedFurnishings(placed).map(posKey));
  const route = findPath(room, from, to, HUT_MAX_PATH, (t) => (t.biome !== "floor" || blocked.has(posKey(t)) ? Infinity : 1));
  return route && route.path.length > 0 ? route.path : null;
}

// ---------- wire types ----------

export type HutServerMessage =
  | {
      type: "snapshot";
      you: string;
      owner: { id: string; name: string };
      tier: number;
      /** True for the owner, who may move the furniture. */
      canEdit: boolean;
      players: HarborPlayer[];
      furnishings: Furnishing[];
    }
  /** The owner's whole list, placed and stored, after any change. */
  | { type: "furnishings"; tier: number; furnishings: Furnishing[] }
  | { type: "joined"; player: HarborPlayer }
  | { type: "left"; id: string }
  | { type: "moved"; id: string; path: HexPos[] }
  | { type: "said"; id: string; name: string; text: string }
  /** Sent only to whoever asked for something that was not allowed. */
  | { type: "refused"; reason: string };

export type HutClientMessage =
  | { type: "move"; to: HexPos }
  | { type: "say"; text: string }
  /** Owner only. Put a stored furnishing down, or move a placed one. */
  | { type: "place"; id: number; to: HexPos; facing?: number }
  /** Owner only. Back into storage. */
  | { type: "pick_up"; id: number }
  /** Owner only. Turn a placed furnishing; one step clockwise unless `facing` is given. */
  | { type: "rotate"; id: number; facing?: number };
