// The inside of a hut: a small hex room its owner furnishes and crewmates
// can visit.
//
// Like the Harbor it has no reducer. People walk freely and the HutRoom
// Durable Object checks each request against the rules here: where the walls
// are, where a furnishing may stand, and that furniture is walked around.

import { allHexesInGrid, posKey, type HexGrid, type HexPos } from "@gantt-quest/core";
import { harborPoi, type HarborPlayer, type XpMessage } from "./harbor";
import { FURNISHINGS, HUT_TIERS, type Furnishing, type HutTier } from "./hut";
import { BASE_HEIGHT, findPath, poiAt, tileAt, type Tile, type WorldMap } from "./map";
import type { Footprint } from "./hut";

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
 * Height of the back and side walls: about twice a hero's height, so there is
 * room to hang things on them (see wallPlaceProblem). Taller than the Harbor's
 * `wall` biome, which only rooms use.
 */
export const ROOM_WALL_HEIGHT = 1.8;
/** How high a wall piece may reach, from the floor. The drawn wall rises a little above it. */
export const WALL_ITEM_TOP = 1.8;
/** How low a wall piece may hang: its bottom stays at least this far off the floor. */
export const WALL_ITEM_BOTTOM = 0.1;

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
    return { q: pos.q, r: pos.r, biome: "wall", h: front ? FRONT_WALL_HEIGHT : ROOM_WALL_HEIGHT };
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

/**
 * Where a new piece can go in a room with these pieces already standing:
 * against the back wall facing the door, as near the middle as it can be, so
 * it is out of the way and in plain sight. Null if the floor is full.
 */
export function freeSpot(room: WorldMap, placed: Placed[], defId: string, door: HexPos): HexPos | null {
  const free = hutFloor(room).filter((p) => !placeProblem(room, placed, defId, p));
  // Rows away from the door first, then sideways from its column.
  const depth = (p: HexPos) => Math.abs(p.r - door.r);
  const side = (p: HexPos) => Math.abs(colOf(p) - colOf(door));
  return free.sort((a, b) => depth(b) - depth(a) || side(a) - side(b) || a.q - b.q)[0] ?? null;
}

/** True for something small enough to sit anywhere in a hex or on a surface. */
export const isSmall = (defId: string): boolean => FURNISHINGS[defId]?.size === "small";
/** True for something that hangs on a wall. */
export const isMounted = (defId: string): boolean => !!FURNISHINGS[defId]?.mount;
/** True for furniture standing on the floor: neither small nor hung on a wall. Each covers its footprint. */
export const isFloorPiece = (defId: string): boolean => !!FURNISHINGS[defId] && !isSmall(defId) && !isMounted(defId);

/** The furnishings that are standing in the room, not in storage. */
export function placedFurnishings<T extends Pick<Furnishing, "q" | "r">>(furnishings: T[]): (T & { q: number; r: number })[] {
  return furnishings.filter((f): f is T & { q: number; r: number } => f.q !== null && f.r !== null);
}

export const validFacing = (facing: unknown): facing is number => Number.isInteger(facing) && (facing as number) >= 0 && (facing as number) <= 5;

const TAU = Math.PI * 2;
/** An angle brought into [0, 2π). */
export const wrapAngle = (a: number): number => ((a % TAU) + TAU) % TAU;
/** How far a piece is turned, in radians: its facing (sixths, from before free turning) plus its angle. */
export const turnOf = (f: Partial<Pick<Furnishing, "facing" | "angle">>): number => wrapAngle((f.facing ?? 0) * (Math.PI / 3) + (f.angle ?? 0));

/**
 * Something already in the room, as the rules need it. Callers that only know
 * positions (older tests) leave out `defId`: such an entry counts as a piece
 * filling its whole hex.
 */
export type Placed = Pick<Furnishing, "q" | "r"> & Partial<Pick<Furnishing, "id" | "defId" | "onId" | "facing" | "x" | "z" | "y" | "angle">>;

// ---------- the room's geometry ----------
//
// The same layout the client draws: pointy-topped hexes one unit from middle
// to corner, x to the right and z toward the camera.

const SQRT3 = Math.sqrt(3);
/** The six neighbours, in the order of a wall piece's `facing`: top right, right, bottom right, bottom left, left, top left. */
export const HEX_DIRS: readonly HexPos[] = [
  { q: 1, r: -1 },
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
];
/** From the middle of a hex to the middle of one of its sides. */
export const HEX_APOTHEM = SQRT3 / 2;

/** The middle of a hex, in room units. */
export function hexCentre(p: HexPos): { x: number; z: number } {
  return { x: SQRT3 * (p.q + p.r / 2), z: 1.5 * p.r };
}

/** The hex a point of the room's floor falls in. */
export function hexAt(x: number, z: number): HexPos {
  const r = z / 1.5;
  const q = x / SQRT3 - r / 2;
  // Round in cube coordinates.
  const s = -q - r;
  let [rq, rr, rs] = [Math.round(q), Math.round(r), Math.round(s)];
  const [dq, dr, ds] = [Math.abs(rq - q), Math.abs(rr - r), Math.abs(rs - s)];
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq + 0, r: rr + 0 };
}

/** A point in a piece's own space (`lx`, `lz`), turned by `turn` and set down at (`x`, `z`). Matches how the client turns models. */
function toRoom(lx: number, lz: number, turn: number, x: number, z: number): { x: number; z: number } {
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  return { x: x + lx * c - lz * s, z: z + lx * s + lz * c };
}

/** Floor furniture with no footprint of its own is taken to fill most of its hex. */
const WHOLE_HEX: Footprint = { w: 0.9, d: 0.9 };
export const footprintOf = (defId: string): Footprint => FURNISHINGS[defId]?.footprint ?? WHOLE_HEX;

/** A floor piece's centre may sit this far from the middle of its hex: always inside it (the sides are about 0.87 away). */
export const BIG_REACH = 0.8;

/** Where a floor piece stands: its hex, its offset from the middle of it, and its whole turn in radians. */
export interface FloorSpot {
  x: number;
  z: number;
  angle: number;
}

/** The four corners of a floor piece's footprint (for a round one, the square around it), in room units, going round. */
export function footprintCorners(defId: string, pos: HexPos, spot: FloorSpot): { x: number; z: number }[] {
  const fp = footprintOf(defId);
  const mid = hexCentre(pos);
  const [hw, hd, cx, cz] = [fp.w / 2, fp.d / 2, fp.x ?? 0, fp.z ?? 0];
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => toRoom(cx + lx, cz + lz, spot.angle, mid.x + spot.x, mid.z + spot.z));
}

type Pt = { x: number; z: number };

/** A floor piece's footprint laid out in the room: a turned rectangle (its corners, going round) or, for a round piece, a circle. */
export type FloorShape = { corners: Pt[] } | { centre: Pt; radius: number };

/** Where a floor piece's footprint lies in the room. */
export function footprintShape(defId: string, pos: HexPos, spot: FloorSpot): FloorShape {
  const fp = footprintOf(defId);
  if (!fp.round) return { corners: footprintCorners(defId, pos, spot) };
  const mid = hexCentre(pos);
  return { centre: toRoom(fp.x ?? 0, fp.z ?? 0, spot.angle, mid.x + spot.x, mid.z + spot.z), radius: fp.w / 2 };
}

/** How far `p` is from a footprint: 0 on or inside it. */
function shapeDistance(s: FloorShape, p: Pt): number {
  return "corners" in s ? distanceTo(s.corners, p) : Math.max(0, Math.hypot(p.x - s.centre.x, p.z - s.centre.z) - s.radius);
}

/** True if `p` is inside a footprint by more than `margin`. */
function shapeContains(s: FloorShape, p: Pt, margin = 0): boolean {
  return "corners" in s ? inside(s.corners, p, margin) : Math.hypot(p.x - s.centre.x, p.z - s.centre.z) < s.radius - margin;
}

/** True if two footprints overlap by more than a touch. */
function shapesOverlap(a: FloorShape, b: FloorShape): boolean {
  if ("corners" in a && "corners" in b) return overlaps(a.corners, b.corners);
  if (!("corners" in a) && !("corners" in b)) return Math.hypot(a.centre.x - b.centre.x, a.centre.z - b.centre.z) < a.radius + b.radius - TOUCH;
  const [rect, round] = "corners" in a ? [a, b as { centre: Pt; radius: number }] : [b as { corners: Pt[] }, a];
  return distanceTo(rect.corners, round.centre) < round.radius - TOUCH;
}

/** Points around a footprint's edge, for checking it stays on the floor. */
function shapeOutline(s: FloorShape): Pt[] {
  if ("corners" in s) return outline(s.corners);
  return Array.from({ length: 12 }, (_, i) => ({ x: s.centre.x + Math.cos((i * Math.PI) / 6) * s.radius, z: s.centre.z + Math.sin((i * Math.PI) / 6) * s.radius }));
}

/** Overlap shorter than this is touching, not overlapping: a stool may be pushed right up against a table. */
const TOUCH = 0.02;

/** True if two convex quadrilaterals overlap by more than a touch (separating axis test). */
function overlaps(a: Pt[], b: Pt[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [p, n] = [poly[i], poly[(i + 1) % poly.length]];
      const ax = -(n.z - p.z);
      const az = n.x - p.x;
      const len = Math.hypot(ax, az) || 1;
      const proj = (pts: Pt[]) => pts.map((v) => (v.x * ax + v.z * az) / len);
      const [pa, pb] = [proj(a), proj(b)];
      if (Math.max(...pa) - TOUCH <= Math.min(...pb) || Math.max(...pb) - TOUCH <= Math.min(...pa)) return false;
    }
  }
  return true;
}

/** True if `p` is inside the convex quadrilateral `poly` (whose corners go round), by more than `margin`. */
function inside(poly: Pt[], p: Pt, margin = 0): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const cross = ((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)) / len;
    const side = Math.sign(cross);
    if (Math.abs(cross) <= margin) return false;
    if (sign === 0) sign = side;
    else if (side !== sign) return false;
  }
  return true;
}

/** Points along a footprint's edges, close enough together that none of a wall hex's corners can poke between them. */
function outline(corners: Pt[]): Pt[] {
  const out: Pt[] = [];
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % corners.length];
    for (let k = 0; k < 4; k++) out.push({ x: a.x + ((b.x - a.x) * k) / 4, z: a.z + ((b.z - a.z) * k) / 4 });
  });
  return out;
}

/** A small thing on the floor stays this close to the middle of its hex (whose flat sides are about 0.87 away). */
export const SMALL_REACH = 0.7;
/** The most small things one hex of floor, or one surface, takes. */
export const SMALL_PER_SPOT = 8;

/** Where a placed floor piece stands, for the rules. */
const spotOf = (f: Placed): FloorSpot => ({ x: f.x ?? 0, z: f.z ?? 0, angle: turnOf(f) });

/** How far `p` is from the convex quadrilateral `poly`: 0 inside it. */
function distanceTo(poly: Pt[], p: Pt): number {
  if (inside(poly, p)) return 0;
  let best = Infinity;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const [ex, ez] = [b.x - a.x, b.z - a.z];
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(a.x + ex * t - p.x, a.z + ez * t - p.z));
  });
  return best;
}

/** A hero standing in a hex takes up about this much room around its middle. */
const STANDING_ROOM = 0.35;

/**
 * The hexes a floor piece keeps people out of: its own, and any neighbour
 * whose middle it comes too close to for anyone to stand there (a bed pushed
 * toward the next hex).
 */
export function coveredHexes(defId: string, pos: HexPos, spot: FloorSpot): HexPos[] {
  const shape = footprintShape(defId, pos, spot);
  const out = [pos];
  for (const d of HEX_DIRS) {
    const n = { q: pos.q + d.q, r: pos.r + d.r };
    if (shapeDistance(shape, hexCentre(n)) < STANDING_ROOM) out.push(n);
  }
  return out;
}

/** Why the floor hex `pos` cannot be stood on by a furnishing, or null. */
function floorProblem(room: WorldMap, pos: HexPos): string | null {
  if (!Number.isInteger(pos.q) || !Number.isInteger(pos.r)) return "That is not a place in the room.";
  const tile = tileAt(room, pos);
  if (!tile) return "That is outside the room.";
  if (tile.biome !== "floor") return "That is a wall.";
  if (poiAt(room, pos)?.kind === "door") return "The doorway has to stay clear.";
  return null;
}

/** The floor pieces among `placed`, with where they stand. Entries without a `defId` are left out (see `Placed`). */
const floorPieces = (placed: Placed[]) => placedFurnishings(placed).filter((f): f is Placed & { q: number; r: number; defId: string } => !!f.defId && isFloorPiece(f.defId));

/** Where a small thing on the floor is, in room units. */
const smallPoint = (f: { q: number; r: number; x?: number; z?: number }): Pt => {
  const mid = hexCentre(f);
  return { x: mid.x + (f.x ?? 0), z: mid.z + (f.z ?? 0) };
};

/**
 * Why `defId` cannot be put down on `pos`, or null if it can. Floor
 * furniture stands anywhere inside its hex (`spot`, default its middle, facing
 * 0) as long as its footprint stays on the floor, off the doorway, clear of
 * the other pieces' footprints and of small things left on the floor. To move
 * a piece that is already placed, leave it out of `placed`.
 */
export function placeProblem(room: WorldMap, placed: Placed[], defId: string, pos: HexPos, spot: FloorSpot = { x: 0, z: 0, angle: 0 }): string | null {
  if (!FURNISHINGS[defId]) return "There is no such furnishing.";
  if (isMounted(defId)) return "That hangs on a wall.";
  const floor = floorProblem(room, pos);
  if (floor) return floor;
  if (![spot.x, spot.z, spot.angle].every((n) => typeof n === "number" && Number.isFinite(n))) return "That is not a place in the room.";
  if (Math.hypot(spot.x, spot.z) > BIG_REACH + 1e-6) return "Keep it inside the hex.";
  // Callers that only know positions count anything in the hex as in the way.
  const here = placedFurnishings(placed).filter((f) => f.q === pos.q && f.r === pos.r);
  if (here.some((f) => !f.defId)) return "Something already stands there.";
  const shape = footprintShape(defId, pos, spot);
  for (const p of shapeOutline(shape)) {
    const problem = floorProblem(room, hexAt(p.x, p.z));
    if (problem === "The doorway has to stay clear.") return problem;
    if (problem) return "It would go through the wall.";
  }
  if (floorPieces(placed).some((f) => shapesOverlap(shape, footprintShape(f.defId, f, spotOf(f))))) return "Something already stands there.";
  const floorSmall = placedFurnishings(placed).filter((f) => f.defId && isSmall(f.defId) && f.onId == null);
  if (floorSmall.some((f) => shapeContains(shape, smallPoint(f)))) return "Clear the small things off that spot first.";
  return null;
}

/** Where a small thing is to go: a spot on a floor hex, or a spot on another piece's surface. */
export type SmallSpot =
  | { on?: undefined; pos: HexPos; x: number; z: number; angle: number }
  | { on: number; x: number; z: number; angle: number };

/**
 * Why the small thing `defId` cannot go on `spot`, or null if it can. On the
 * floor it keeps near the middle of its hex and out from under furniture; on
 * a piece it stands within that piece's top. `others` is everything owned but
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
  const at = smallPoint({ ...spot.pos, x: spot.x, z: spot.z });
  if (floorPieces(others).some((f) => shapeContains(footprintShape(f.defId, f, spotOf(f)), at))) return "Something already stands there. Set it on top, if it has a top.";
  const here = placedFurnishings(others).filter((f) => f.q === spot.pos.q && f.r === spot.pos.r && isSmall(f.defId));
  if (here.filter((f) => f.onId === null).length >= SMALL_PER_SPOT) return "That spot is full.";
  return null;
}

// ---------- on the walls ----------

/** Where a wall piece hangs: the wall hex, which of its sides (toward the floor), how far along that side, and how high. */
export interface WallSpot {
  pos: HexPos;
  side: number;
  x: number;
  y: number;
}

/** How far along its side a wall piece's edge may reach from the middle: a side is one unit long. */
export const WALL_FACE_HALF = 0.5;

/**
 * The middle of side `side` of hex `pos`, the way into the room (`nx`, `nz`,
 * from the wall toward the floor) and along it (`tx`, `tz`, a wall piece's +x
 * as seen from the room).
 */
export function wallFace(pos: HexPos, side: number): { x: number; z: number; nx: number; nz: number; tx: number; tz: number } {
  const mid = hexCentre(pos);
  const d = hexCentre(HEX_DIRS[side]);
  const len = Math.hypot(d.x, d.z);
  const [nx, nz] = [d.x / len, d.z / len];
  return { x: mid.x + nx * HEX_APOTHEM, z: mid.z + nz * HEX_APOTHEM, nx, nz, tx: nz, tz: -nx };
}

/** True for a back or side wall: tall enough to hang things on. The low front wall is not. */
const tallWall = (tile: Tile | undefined) => tile?.biome === "wall" && tile.h >= ROOM_WALL_HEIGHT - 1e-6;

/** Every side of a back or side wall that faces the room's floor (never the doorway), where wall pieces can hang. */
export function wallFaces(room: WorldMap): { pos: HexPos; side: number }[] {
  const out: { pos: HexPos; side: number }[] = [];
  for (const t of room.tiles) {
    if (!tallWall(t)) continue;
    HEX_DIRS.forEach((d, side) => {
      if (!floorProblem(room, { q: t.q + d.q, r: t.r + d.r })) out.push({ pos: { q: t.q, r: t.r }, side });
    });
  }
  return out;
}

/**
 * Why the wall piece `defId` cannot hang at `spot`, or null if it can. Only
 * on a back or side wall, on a side that faces the floor (not the doorway),
 * kept within that side and between the floor and the top of the wall, and
 * not over another wall piece on the same side. `others` is everything owned
 * but the piece being hung.
 */
export function wallPlaceProblem(room: WorldMap, others: Placed[], defId: string, spot: WallSpot): string | null {
  const mount = FURNISHINGS[defId]?.mount;
  if (!mount) return "That does not hang on a wall.";
  if (![spot.pos.q, spot.pos.r, spot.side].every((n) => Number.isInteger(n)) || ![spot.x, spot.y].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return "That is not a place on the wall.";
  }
  if (spot.side < 0 || spot.side > 5) return "That is not a place on the wall.";
  const tile = tileAt(room, spot.pos);
  if (!tile) return "That is outside the room.";
  if (tile.biome !== "wall") return "Hang it on a wall.";
  if (!tallWall(tile)) return "The front wall is too low. Hang it on a back or side wall.";
  const d = HEX_DIRS[spot.side];
  const facing = floorProblem(room, { q: spot.pos.q + d.q, r: spot.pos.r + d.r });
  if (facing === "The doorway has to stay clear.") return facing;
  if (facing) return "That side of the wall does not face the room.";
  if (Math.abs(spot.x) + mount.w / 2 > WALL_FACE_HALF + 1e-6) return "It would hang off the end of the wall.";
  if (spot.y - mount.h / 2 < WALL_ITEM_BOTTOM - 1e-6) return "Hang it higher.";
  if (spot.y + mount.h / 2 > WALL_ITEM_TOP + 1e-6) return "Hang it lower.";
  const sameSide = placedFurnishings(others).filter((f) => f.defId && isMounted(f.defId) && f.q === spot.pos.q && f.r === spot.pos.r && f.facing === spot.side);
  for (const f of sameSide) {
    const m = FURNISHINGS[f.defId!].mount!;
    if (Math.abs((f.x ?? 0) - spot.x) < (m.w + mount.w) / 2 - TOUCH && Math.abs((f.y ?? 0) - spot.y) < (m.h + mount.h) / 2 - TOUCH) return "Something already hangs there.";
  }
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
 * floor, on the doorway, overlapping an earlier piece, or on a wall that is no
 * longer a wall. When a hut changes size these go back to storage and the
 * rest stay where they are.
 */
export function displacedFurnishings<T extends Placed & Pick<Furnishing, "defId">>(tier: number, furnishings: T[]): T[] {
  const room = hutRoom(tier);
  const kept: Placed[] = [];
  const out: T[] = [];
  const placed = placedFurnishings(furnishings);
  // Floor furniture first, then wall pieces, each checked against those kept
  // before it. Then small things: on the floor, the hex must be floor and
  // out from under furniture; on a piece, that piece must stay.
  for (const f of placed) {
    if (!isFloorPiece(f.defId)) continue;
    if (placeProblem(room, kept, f.defId, f, spotOf(f))) out.push(f);
    else kept.push(f);
  }
  for (const f of placed) {
    if (!isMounted(f.defId)) continue;
    if (wallPlaceProblem(room, kept, f.defId, { pos: f, side: f.facing ?? 0, x: f.x ?? 0, y: f.y ?? 0 })) out.push(f);
    else kept.push(f);
  }
  for (const f of placed) {
    if (!isSmall(f.defId)) continue;
    const lost = f.onId != null
      ? !placed.some((b) => b.id === f.onId) || out.some((b) => b.id === f.onId)
      : floorProblem(room, f) !== null || floorPieces(kept).some((k) => shapeContains(footprintShape(k.defId, k, spotOf(k)), smallPoint(f)));
    if (lost) out.push(f);
  }
  return out;
}

/** Longest walk the server will accept in one request. */
export const HUT_MAX_PATH = 40;

/** The hexes nobody can walk onto for the furniture standing on them. Small things are stepped over; wall pieces hang out of the way. */
export function blockedHexes(placed: Placed[]): Set<string> {
  const blocked = new Set<string>();
  for (const f of placedFurnishings(placed)) {
    if (!f.defId) blocked.add(posKey(f));
    else if (isFloorPiece(f.defId)) for (const h of coveredHexes(f.defId, f, spotOf(f))) blocked.add(posKey(h));
  }
  return blocked;
}

/** A walkable route between two hexes of the room, or null. Walls and placed furniture are walked around. */
export function hutPath(room: WorldMap, placed: Placed[], from: HexPos, to: HexPos): HexPos[] | null {
  const blocked = blockedHexes(placed);
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
  | { type: "placed"; id: string; pos: HexPos }
  | { type: "said"; id: string; name: string; text: string }
  /** Sent only to whoever asked for something that was not allowed. */
  | { type: "refused"; reason: string }
  | XpMessage;

export type HutClientMessage =
  | { type: "move"; to: HexPos }
  | { type: "say"; text: string }
  /** Back to the door, for a stuck or lost hero. */
  | { type: "unstick" }
  /**
   * Owner only. Put a stored furnishing down, or move a placed one. On the
   * floor it goes on hex `to` at offset `x`/`z`, turned `angle` radians
   * (`facing`, in sixths, is still taken from older clients); a small thing
   * with `on` stands on that piece's top instead (then `to` is ignored). A
   * wall piece hangs on wall hex `to`, on side `facing`, `x` along it and `y`
   * up from the floor.
   */
  | { type: "place"; id: number; to: HexPos; facing?: number; x?: number; z?: number; y?: number; angle?: number; on?: number }
  /** Owner only. Into a container. */
  | { type: "put_in"; id: number; into: number }
  /** Owner only. Back into storage. */
  | { type: "pick_up"; id: number }
  /**
   * Owner only. Turn a placed floor piece to `angle` radians (or `facing`
   * sixths); without either, one step clockwise: a sixth for furniture, a
   * twenty-fourth for a small thing. Wall pieces do not turn.
   */
  | { type: "rotate"; id: number; facing?: number; angle?: number };
