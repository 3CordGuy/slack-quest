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

/** True for something small enough to sit anywhere in a hex or on a surface. */
export const isSmall = (defId: string): boolean => FURNISHINGS[defId]?.size === "small";

/** The furnishings that are standing in the room, not in storage. */
export function placedFurnishings<T extends Pick<Furnishing, "q" | "r">>(furnishings: T[]): (T & { q: number; r: number })[] {
  return furnishings.filter((f): f is T & { q: number; r: number } => f.q !== null && f.r !== null);
}

export const validFacing = (facing: unknown): facing is number => Number.isInteger(facing) && (facing as number) >= 0 && (facing as number) <= 5;

type Placed = Pick<Furnishing, "q" | "r"> & Partial<Pick<Furnishing, "defId" | "onId">>;

/** A small thing on the floor stays this close to the middle of its hex (whose flat sides are about 0.87 away). */
export const SMALL_REACH = 0.7;
/** The most small things one hex of floor, or one surface, takes. */
export const SMALL_PER_SPOT = 8;

/** Why the floor hex `pos` cannot be stood on by a furnishing, or null. */
function floorProblem(room: WorldMap, pos: HexPos): string | null {
  if (!Number.isInteger(pos.q) || !Number.isInteger(pos.r)) return "That is not a place in the room.";
  const tile = tileAt(room, pos);
  if (!tile) return "That is outside the room.";
  if (tile.biome !== "floor") return "That is a wall.";
  if (poiAt(room, pos)?.kind === "door") return "The doorway has to stay clear.";
  return null;
}

/**
 * Why `defId` cannot be put down on `pos`, or null if it can. One piece of
 * furniture per floor hex, never on the door, a wall or off the map, and not
 * on top of small things left on the floor. To move a piece that is already
 * placed, leave it out of `placed`.
 */
export function placeProblem(room: WorldMap, placed: Placed[], defId: string, pos: HexPos): string | null {
  if (!FURNISHINGS[defId]) return "There is no such furnishing.";
  const floor = floorProblem(room, pos);
  if (floor) return floor;
  const here = placed.filter((f) => f.q === pos.q && f.r === pos.r);
  // Callers that only know positions (older tests, the path finder) count everything as furniture.
  if (here.some((f) => !f.defId || !isSmall(f.defId))) return "Something already stands there.";
  if (here.some((f) => f.onId == null)) return "Clear the small things off that spot first.";
  return null;
}

/** Where a small thing is to go: a spot on a floor hex, or a spot on another piece's surface. */
export type SmallSpot =
  | { on?: undefined; pos: HexPos; x: number; z: number; angle: number }
  | { on: number; x: number; z: number; angle: number };

/**
 * Why the small thing `defId` cannot go on `spot`, or null if it can. On the
 * floor it keeps near the middle of a free hex (no furniture there); on a
 * piece it stands within that piece's top. `others` is everything owned but
 * the thing being moved.
 */
export function smallPlaceProblem(room: WorldMap, others: Furnishing[], defId: string, spot: SmallSpot): string | null {
  if (!isSmall(defId)) return "That is too big to set down there.";
  const nums = [spot.x, spot.z, spot.angle];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return "That is not a place in the room.";
  if (spot.on !== undefined) {
    const base = others.find((f) => f.id === spot.on);
    const top = base && FURNISHINGS[base.defId]?.surface;
    if (!base || base.q === null) return "That is not in the room.";
    if (!top) return "Nothing can stand on that.";
    if (Math.abs(spot.x - (top.x ?? 0)) > top.w / 2 + 1e-6 || Math.abs(spot.z - (top.z ?? 0)) > top.d / 2 + 1e-6) return "That would fall off the edge.";
    if (others.filter((f) => f.onId === base.id).length >= SMALL_PER_SPOT) return "There is no room left on top.";
    return null;
  }
  const floor = floorProblem(room, spot.pos);
  if (floor) return floor;
  if (Math.hypot(spot.x, spot.z) > SMALL_REACH + 1e-6) return "Keep it inside the hex.";
  const here = placedFurnishings(others).filter((f) => f.q === spot.pos.q && f.r === spot.pos.r);
  if (here.some((f) => !isSmall(f.defId))) return "Something already stands there. Set it on top, if it has a top.";
  if (here.filter((f) => f.onId === null).length >= SMALL_PER_SPOT) return "That spot is full.";
  return null;
}

/** How many slots a container has free, given what is already in it (decorations, gear, stacks of materials). */
export function storageFree(defId: string, used: number): number {
  return Math.max(0, (FURNISHINGS[defId]?.storage ?? 0) - used);
}

/** Why `piece` cannot be put into `container`, or null if it can. `used` is how many slots the container already fills. */
export function putInProblem(piece: Pick<Furnishing, "id" | "defId">, container: Pick<Furnishing, "id" | "defId"> | undefined, used: number): string | null {
  if (!container || !FURNISHINGS[container.defId]?.storage) return "That does not hold anything.";
  if (piece.id === container.id) return "It cannot go inside itself.";
  if (FURNISHINGS[piece.defId]?.storage) return "Containers do not go inside other containers.";
  return storageFree(container.defId, used) > 0 ? null : "It is full.";
}

/**
 * The placed furnishings that have no legal spot in a room of `tier`: off the
 * floor, on the doorway, or sharing a hex with an earlier piece. When a hut
 * changes size these go back to storage and the rest stay where they are.
 */
export function displacedFurnishings<T extends Pick<Furnishing, "defId" | "q" | "r"> & Partial<Pick<Furnishing, "id" | "onId">>>(tier: number, furnishings: T[]): T[] {
  const room = hutRoom(tier);
  const kept: { q: number; r: number }[] = [];
  const out: T[] = [];
  const placed = placedFurnishings(furnishings);
  // Furniture first: one to a hex. Then small things: on the floor, the hex
  // must be floor and free of furniture; on a piece, that piece must stay.
  for (const f of placed) {
    if (isSmall(f.defId)) continue;
    if (placeProblem(room, kept, f.defId, f)) out.push(f);
    else kept.push({ q: f.q, r: f.r });
  }
  for (const f of placed) {
    if (!isSmall(f.defId)) continue;
    const lost = f.onId != null
      ? !placed.some((b) => b.id === f.onId) || out.some((b) => b.id === f.onId)
      : floorProblem(room, f) !== null || kept.some((k) => k.q === f.q && k.r === f.r);
    if (lost) out.push(f);
  }
  return out;
}

/** Longest walk the server will accept in one request. */
export const HUT_MAX_PATH = 40;

/** A walkable route between two hexes of the room, or null. Walls and placed furniture are walked around. */
export function hutPath(room: WorldMap, placed: Placed[], from: HexPos, to: HexPos): HexPos[] | null {
  // Small things are stepped over.
  const blocked = new Set(placedFurnishings(placed).filter((f) => !f.defId || !isSmall(f.defId)).map(posKey));
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
  /**
   * Owner only. Put a stored furnishing down, or move a placed one. Furniture
   * goes on hex `to`; a small thing also takes an offset `x`/`z` and an
   * `angle`, and with `on` stands on that piece's top (then `to` is ignored).
   */
  | { type: "place"; id: number; to: HexPos; facing?: number; x?: number; z?: number; angle?: number; on?: number }
  /** Owner only. Into a container. */
  | { type: "put_in"; id: number; into: number }
  /** Owner only. Back into storage. */
  | { type: "pick_up"; id: number }
  /** Owner only. Turn a placed furnishing; one step clockwise unless `facing` (or, for a small thing, `angle`) is given. */
  | { type: "rotate"; id: number; facing?: number; angle?: number };
