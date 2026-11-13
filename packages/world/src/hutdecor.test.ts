// Taller walls with things hung on them, floor pieces turned to any angle,
// and furniture set anywhere inside its hex (see hutroom.ts).

import { describe, expect, it } from "vitest";
import {
  BIG_REACH,
  FURNISHINGS,
  HEX_DIRS,
  HUT_TIERS,
  ROOM_WALL_HEIGHT,
  blockedHexes,
  coveredHexes,
  displacedFurnishings,
  footprintCorners,
  hexAt,
  hexCentre,
  hutDoor,
  hutFloor,
  hutPath,
  hexSpan,
  hutRoom,
  isFloorPiece,
  isMounted,
  placeProblem,
  smallPlaceProblem,
  tileAt,
  turnOf,
  wallFace,
  wallFaces,
  wallPlaceProblem,
  type Furnishing,
} from "./index";

let next = 1;
const piece = (defId: string, at: { q: number; r: number } | null, more: Partial<Furnishing> = {}): Furnishing => ({
  id: next++,
  defId,
  label: defId,
  q: at?.q ?? null,
  r: at?.r ?? null,
  facing: 0,
  x: 0,
  z: 0,
  y: 0,
  angle: 0,
  onId: null,
  inId: null,
  ...more,
});

const room = hutRoom(1);
const door = hutDoor(1);
/** A floor hex with floor on every side: the middle of the room. */
const middle = hutFloor(room).find((p) => HEX_DIRS.every((d) => hutFloor(room).some((f) => f.q === p.q + d.q && f.r === p.r + d.r)))!;
/** A floor hex against the back wall, and the side of it that faces that wall. */
const backFloor = hutFloor(room).find((p) => p.r === 1)!;
const toBackWall = HEX_DIRS.findIndex((d) => tileAt(room, { q: backFloor.q + d.q, r: backFloor.r + d.r })?.biome === "wall");

describe("the room's walls", () => {
  it("raises the back and side walls but keeps the front wall low", () => {
    for (const { tier } of HUT_TIERS) {
      const r = hutRoom(tier);
      const walls = r.tiles.filter((t) => t.biome === "wall");
      const front = walls.filter((t) => t.r === r.grid.rows - 1);
      expect(front.length).toBeGreaterThan(0);
      for (const t of front) expect(t.h).toBeLessThan(0.5);
      for (const t of walls.filter((w) => w.r < r.grid.rows - 1)) expect(t.h).toBe(ROOM_WALL_HEIGHT);
    }
  });

  it("finds wall faces only on back and side walls, facing the floor, never the doorway", () => {
    for (const { tier } of HUT_TIERS) {
      const r = hutRoom(tier);
      const d = hutDoor(tier);
      const faces = wallFaces(r);
      expect(faces.length).toBeGreaterThan(0);
      for (const f of faces) {
        expect(tileAt(r, f.pos)!.h).toBe(ROOM_WALL_HEIGHT);
        const n = { q: f.pos.q + HEX_DIRS[f.side].q, r: f.pos.r + HEX_DIRS[f.side].r };
        expect(tileAt(r, n)!.biome).toBe("floor");
        expect(n).not.toEqual(d);
      }
    }
  });

  it("puts a wall face between the wall's middle and the floor's, pointing into the room", () => {
    const [{ pos, side }] = wallFaces(room);
    const face = wallFace(pos, side);
    const wall = hexCentre(pos);
    const floor = hexCentre({ q: pos.q + HEX_DIRS[side].q, r: pos.r + HEX_DIRS[side].r });
    expect(face.x).toBeCloseTo((wall.x + floor.x) / 2);
    expect(face.z).toBeCloseTo((wall.z + floor.z) / 2);
    expect(face.nx * (floor.x - wall.x) + face.nz * (floor.z - wall.z)).toBeGreaterThan(0);
    expect(face.nx * face.tx + face.nz * face.tz).toBeCloseTo(0);
  });
});

describe("hanging things on the walls", () => {
  const [face, other] = wallFaces(room);
  const spot = { pos: face.pos, side: face.side, x: 0, y: 1.1 };

  it("knows which pieces hang on walls, and that they are not floor furniture", () => {
    const wall = Object.values(FURNISHINGS).filter((f) => f.mount);
    expect(wall.map((f) => f.id)).toEqual(expect.arrayContaining(["wall_shelf", "painting", "wall_chart", "sconce", "wall_lantern", "ship_wheel", "crossed_blades", "mounted_fish"]));
    for (const f of wall) {
      expect(isMounted(f.id)).toBe(true);
      expect(isFloorPiece(f.id)).toBe(false);
      expect(f.size).toBeUndefined();
      expect(f.mount!.h).toBeLessThan(1.6);
      expect(f.mount!.w).toBeLessThanOrEqual(1);
    }
    expect(FURNISHINGS.sconce.light).toBeTruthy();
    expect(FURNISHINGS.wall_lantern.light).toBeTruthy();
    expect(FURNISHINGS.wall_shelf.surface).toBeTruthy();
  });

  it("hangs a wall piece on a back or side wall facing the room", () => {
    expect(wallPlaceProblem(room, [], "painting", spot)).toBeNull();
    expect(wallPlaceProblem(room, [], "painting", { ...spot, x: 0.15 })).toBeNull();
  });

  it("refuses floor hexes, the low front wall, sides facing away and the doorway", () => {
    expect(wallPlaceProblem(room, [], "painting", { ...spot, pos: middle })).toMatch(/wall/i);
    const front = room.tiles.find((t) => t.biome === "wall" && t.r === room.grid.rows - 1)!;
    expect(wallPlaceProblem(room, [], "painting", { ...spot, pos: front, side: 5 })).toMatch(/front wall/i);
    const away = HEX_DIRS.findIndex((d) => !tileAt(room, { q: face.pos.q + d.q, r: face.pos.r + d.r }));
    expect(wallPlaceProblem(room, [], "painting", { ...spot, side: away })).toMatch(/does not face/);
    expect(wallPlaceProblem(room, [], "painting", { ...spot, side: 6 })).not.toBeNull();
    expect(wallPlaceProblem(room, [], "painting", { ...spot, side: 1.5 })).not.toBeNull();
    // No tall wall in any hut faces the doorway.
    for (const { tier } of HUT_TIERS) {
      const d = hutDoor(tier);
      for (const f of wallFaces(hutRoom(tier))) expect({ q: f.pos.q + HEX_DIRS[f.side].q, r: f.pos.r + HEX_DIRS[f.side].r }).not.toEqual(d);
    }
  });

  it("keeps a wall piece on its side of the wall, off the floor and below the top", () => {
    expect(wallPlaceProblem(room, [], "painting", { ...spot, x: 0.3 })).toMatch(/off the end/);
    expect(wallPlaceProblem(room, [], "painting", { ...spot, y: 0.2 })).toMatch(/higher/);
    expect(wallPlaceProblem(room, [], "painting", { ...spot, y: 1.7 })).toMatch(/lower/);
    expect(wallPlaceProblem(room, [], "painting", { ...spot, y: Number.NaN })).not.toBeNull();
  });

  it("refuses floor furniture, small things and unknown pieces", () => {
    expect(wallPlaceProblem(room, [], "table", spot)).toMatch(/does not hang/);
    expect(wallPlaceProblem(room, [], "candle", spot)).toMatch(/does not hang/);
    expect(wallPlaceProblem(room, [], "nope", spot)).toMatch(/does not hang/);
    expect(placeProblem(room, [], "painting", middle)).toMatch(/hangs on a wall/);
  });

  it("does not hang one piece over another on the same side, but stacks them or uses other sides", () => {
    const painting = piece("painting", face.pos, { facing: face.side, x: 0, y: 1.1 });
    expect(wallPlaceProblem(room, [painting], "sconce", { ...spot, y: 1.2 })).toMatch(/already hangs/);
    expect(wallPlaceProblem(room, [painting], "sconce", { ...spot, y: 0.5 })).toBeNull();
    expect(wallPlaceProblem(room, [painting], "painting", { pos: other.pos, side: other.side, x: 0, y: 1.1 })).toBeNull();
    // Moving it: leave it out of the others.
    expect(wallPlaceProblem(room, [], "painting", { ...spot, y: 1.2 })).toBeNull();
  });

  it("lets small things stand on a wall shelf", () => {
    const shelf = piece("wall_shelf", face.pos, { facing: face.side, y: 1.0 });
    expect(smallPlaceProblem(room, [shelf], "candle", { on: shelf.id, x: 0.2, z: 0.12, angle: 0 })).toBeNull();
    expect(smallPlaceProblem(room, [shelf], "candle", { on: shelf.id, x: 0.2, z: 0.4, angle: 0 })).toMatch(/fall off/);
  });

  it("never blocks walking", () => {
    const painting = piece("painting", face.pos, { facing: face.side, y: 1.1 });
    expect(blockedHexes([painting]).size).toBe(0);
  });

  it("sends wall pieces home when their wall stops being a wall", () => {
    // The right-hand wall of a Shack is floor in a Cottage.
    const right = wallFaces(room).find((f) => tileAt(hutRoom(2), f.pos)?.biome === "floor")!;
    const lost = piece("painting", right.pos, { facing: right.side, y: 1.1 });
    const kept = piece("painting", face.pos, { facing: face.side, y: 1.1 });
    const mug = piece("mug", right.pos, { onId: lost.id });
    expect(displacedFurnishings(1, [lost, kept, mug])).toEqual([]);
    expect(displacedFurnishings(2, [lost, kept, mug]).map((f) => f.id).sort()).toEqual([lost.id, mug.id].sort());
  });
});

describe("turning floor pieces freely", () => {
  it("reads a turn as its old facing plus its angle", () => {
    expect(turnOf({ facing: 0, angle: 0 })).toBe(0);
    expect(turnOf({ facing: 2, angle: 0 })).toBeCloseTo((2 * Math.PI) / 3);
    expect(turnOf({ facing: 1, angle: 0.25 })).toBeCloseTo(Math.PI / 3 + 0.25);
    expect(turnOf({ facing: 0, angle: -0.5 })).toBeCloseTo(2 * Math.PI - 0.5);
  });

  it("turns a footprint the same way the client turns a model", () => {
    // A quarter turn takes the piece's own +x toward +z (Three.js: rotation.y = -turn).
    const [a, b] = footprintCorners("bed", { q: 0, r: 0 }, { x: 0, z: 0, angle: Math.PI / 2 });
    const fp = FURNISHINGS.bed.footprint!;
    // Corner 0 is (-w/2, z0 - d/2) in its own space, so after a quarter turn it is at (-(z0 - d/2), -w/2).
    expect(a.x).toBeCloseTo(-((fp.z ?? 0) - fp.d / 2));
    expect(a.z).toBeCloseTo(-fp.w / 2);
    expect(b.z).toBeCloseTo(fp.w / 2);
  });

  it("lets furniture face any angle where it fits", () => {
    for (const angle of [0, 0.1, Math.PI / 7, 1, 2.5, 4, 6]) expect(placeProblem(room, [], "chair", middle, { x: 0, z: 0, angle })).toBeNull();
    expect(placeProblem(room, [], "chair", middle, { x: 0, z: 0, angle: Number.POSITIVE_INFINITY })).not.toBeNull();
  });

  it("keeps every old layout legal: each one-hex footprint fits its own hex at every facing", () => {
    for (const def of Object.values(FURNISHINGS).filter((f) => isFloorPiece(f.id) && hexSpan(f.id) === 1)) {
      for (let facing = 0; facing < 6; facing++) {
        for (const c of footprintCorners(def.id, { q: 0, r: 0 }, { x: 0, z: 0, angle: turnOf({ facing }) })) expect(hexAt(c.x, c.z)).toEqual({ q: 0, r: 0 });
      }
    }
  });
});

describe("furniture anywhere inside its hex", () => {
  const dir = HEX_DIRS[1];
  const right = { q: middle.q + dir.q, r: middle.r + dir.r };

  it("pushes a stool toward the edge of its hex, but no further than its hex", () => {
    expect(placeProblem(room, [], "chair", middle, { x: 0.6, z: 0, angle: 0 })).toBeNull();
    expect(placeProblem(room, [], "chair", middle, { x: BIG_REACH + 0.05, z: 0, angle: 0 })).toMatch(/inside the hex/);
  });

  it("puts a stool right up against a wall but not through it", () => {
    const toWall = hexCentre(HEX_DIRS[toBackWall]);
    const len = Math.hypot(toWall.x, toWall.z);
    const at = (d: number) => ({ x: (toWall.x / len) * d, z: (toWall.z / len) * d, angle: 0 });
    // The stool is half a unit across, and the wall's side about 0.87 from the middle: square to it, the stool can come to about 0.5.
    expect(placeProblem(room, [], "chair", backFloor, at(0.5))).toBeNull();
    expect(placeProblem(room, [], "chair", backFloor, at(0.75))).toMatch(/through the wall/);
  });

  it("keeps big pieces off the doorway", () => {
    const inside = { q: door.q, r: door.r - 1 };
    const down = hexCentre({ q: 0, r: 1 });
    const len = Math.hypot(down.x, down.z);
    expect(placeProblem(room, [], "bed", inside, { x: 0, z: 0, angle: 0 })).toBeNull();
    expect(placeProblem(room, [], "bed", inside, { x: (down.x / len) * 0.6, z: (down.z / len) * 0.6, angle: 0 })).toMatch(/doorway/);
  });

  it("lets two pieces share a hex when they do not overlap, and refuses them when they do", () => {
    const table = piece("table", middle, { z: -0.25 });
    // A stool tucked in front of the table, in the same hex.
    expect(placeProblem(room, [table], "chair", middle, { x: 0, z: 0.35, angle: 0 })).toBeNull();
    expect(placeProblem(room, [table], "chair", middle, { x: 0, z: 0, angle: 0 })).toMatch(/already stands/);
    // A table pushed toward the next hex gets in the way of a piece there.
    const pushed = piece("table", middle, { x: 0.75 });
    expect(placeProblem(room, [pushed], "chair", right, { x: -0.6, z: 0, angle: 0 })).toMatch(/already stands/);
    expect(placeProblem(room, [pushed], "chair", right, { x: 0.3, z: 0, angle: 0 })).toBeNull();
  });

  it("lets a piece touch another without overlapping it", () => {
    const table = piece("table", middle);
    // The table's front edge is at z = 0.35; a stool half a unit across, centred at 0.6, touches it.
    expect(placeProblem(room, [table], "chair", middle, { x: 0, z: 0.6, angle: 0 })).toBeNull();
  });

  it("tucks a round stool against a table at any angle: turning it does not make it bigger", () => {
    const table = piece("table", middle);
    for (const angle of [0, 0.7, 2.2, 4]) expect(placeProblem(room, [table], "chair", middle, { x: 0, z: 0.6, angle })).toBeNull();
    // A square piece the same size, turned to its corner, would reach the table.
    expect(placeProblem(room, [table], "side_table", middle, { x: 0, z: 0.62, angle: Math.PI / 4 })).toMatch(/already stands/);
  });

  it("keeps small things out from under furniture, but beside it in the same hex", () => {
    const table = piece("table", middle, { z: -0.3 });
    expect(smallPlaceProblem(room, [table], "candle", { pos: middle, x: 0, z: -0.3, angle: 0 })).toMatch(/already stands/);
    expect(smallPlaceProblem(room, [table], "candle", { pos: middle, x: 0, z: 0.5, angle: 0 })).toBeNull();
    const candle = piece("candle", middle, { z: 0.5 });
    expect(placeProblem(room, [candle], "table", middle, { x: 0, z: -0.3, angle: 0 })).toBeNull();
    expect(placeProblem(room, [candle], "table", middle, { x: 0, z: 0.3, angle: 0 })).toMatch(/small things/);
  });

  it("blocks walking on its own hex and on any neighbour whose middle it covers", () => {
    const centred = piece("bed", middle, { angle: Math.PI / 2 });
    expect(coveredHexes("bed", middle, { x: 0, z: 0, angle: Math.PI / 2 })).toEqual([middle]);
    // A long bed, turned lengthways and pushed toward the next hex, leaves no room to stand there.
    const pushed = { x: 0.75, z: 0, angle: Math.PI / 2 };
    expect(coveredHexes("bed", middle, pushed)).toContainEqual(right);
    expect(blockedHexes([centred]).size).toBe(1);
    const bed = piece("bed", middle, pushed);
    expect(hutPath(room, [bed], door, right)).toBeNull();
  });

  it("keeps an offset, turned layout across a bigger room, and sends back what overlaps", () => {
    const table = piece("table", middle, { x: 0.2, angle: 0.4 });
    const stool = piece("chair", middle, { x: -0.1, z: 0.62, angle: 1.2 });
    const clash = piece("chair", middle, { x: 0.2 });
    expect(displacedFurnishings(1, [table, stool])).toEqual([]);
    expect(displacedFurnishings(2, [table, stool])).toEqual([]);
    expect(displacedFurnishings(1, [table, stool, clash])).toEqual([clash]);
  });
});
