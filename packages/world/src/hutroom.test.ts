import { describe, expect, it } from "vitest";
import { hexNeighbors } from "@gantt-quest/core";
import { HUT_TIERS, hutDoor, hutFloor, hutPath, hutRoom, hutTier, placeProblem, placedFurnishings, poiAt, tileAt, validFacing } from "./index";

const at = (q: number, r: number) => ({ q, r });

describe("hut room", () => {
  it("is the same every time", () => {
    expect(hutRoom(1)).toEqual(hutRoom(1));
  });

  for (const { tier, cols, rows } of HUT_TIERS) {
    describe(`tier ${tier}`, () => {
      const room = hutRoom(tier);
      const door = hutDoor(tier);
      const floor = hutFloor(room);

      it("has a door in the front wall that is marked and walkable", () => {
        expect(tileAt(room, door)!.biome).toBe("floor");
        expect(poiAt(room, door)?.kind).toBe("door");
        expect(door.r).toBe(room.grid.rows - 1);
        expect(room.pois.filter((p) => p.kind === "door")).toHaveLength(1);
      });

      it("lets every floor hex be reached from the door", () => {
        expect(floor.length).toBeGreaterThan(0);
        for (const hex of floor) {
          const path = hutPath(room, [], door, hex);
          expect(path, `${hex.q},${hex.r}`).not.toBeNull();
          expect(path!.at(-1)).toEqual(hex);
          expect(path!.every((p) => tileAt(room, p)!.biome === "floor")).toBe(true);
        }
        // And back out again.
        expect(hutPath(room, [], floor[0], door)).not.toBeNull();
      });

      it("is enclosed by walls", () => {
        // Every floor hex but the door has all six neighbours on the map, so none is on the rim.
        for (const hex of floor) expect(hexNeighbors(hex, room.grid), `${hex.q},${hex.r}`).toHaveLength(6);
        // The rim is wall everywhere except the door.
        const rim = room.tiles.filter((t) => hexNeighbors(t, room.grid).length < 6);
        expect(rim.filter((t) => t.biome !== "wall").map((t) => at(t.q, t.r))).toEqual([door]);
        expect(room.tiles.every((t) => t.biome === "floor" || t.biome === "wall")).toBe(true);
      });

      it("has a floor of the tier's size", () => {
        // Odd rows of the brick-shaped grid are one hex shorter.
        const expected = Array.from({ length: rows }, (_, i) => ((i + 1) % 2 === 0 ? cols : cols - 1)).reduce((a, b) => a + b, 0);
        expect(floor).toHaveLength(expected);
      });
    });
  }

  it("gives a higher tier more floor", () => {
    const sizes = HUT_TIERS.map((t) => hutFloor(hutRoom(t.tier)).length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
  });

  it("treats an unknown tier as the nearest real one", () => {
    expect(hutTier(0).tier).toBe(1);
    expect(hutTier(99).tier).toBe(HUT_TIERS.at(-1)!.tier);
  });
});

describe("placing furnishings", () => {
  const room = hutRoom(1);
  const door = hutDoor(1);
  const [free, other] = hutFloor(room);
  const wall = room.tiles.find((t) => t.biome === "wall")!;

  it("accepts a free floor hex", () => {
    expect(placeProblem(room, [], "table", free)).toBeNull();
    expect(placeProblem(room, [{ q: other.q, r: other.r }], "chair", free)).toBeNull();
    // Stored pieces take up no room.
    expect(placeProblem(room, [{ q: null, r: null }], "chair", free)).toBeNull();
  });

  it("refuses the door, a wall, off the map, an occupied hex and an unknown furnishing", () => {
    expect(placeProblem(room, [], "table", door)).toMatch(/door/i);
    expect(placeProblem(room, [], "table", wall)).toMatch(/wall/i);
    expect(placeProblem(room, [], "table", at(99, 99))).toMatch(/outside/i);
    expect(placeProblem(room, [], "table", at(0.5, 1))).not.toBeNull();
    expect(placeProblem(room, [{ q: free.q, r: free.r }], "chair", free)).toMatch(/already/i);
    expect(placeProblem(room, [], "throne_of_skulls", free)).toMatch(/no such/i);
  });

  it("allows facings 0 to 5 only", () => {
    expect([0, 1, 2, 3, 4, 5].every(validFacing)).toBe(true);
    expect([-1, 6, 1.5, NaN, "2", null, undefined].some(validFacing)).toBe(false);
  });

  it("tells placed furnishings from stored ones", () => {
    expect(placedFurnishings([{ q: 1, r: 1 }, { q: null, r: null }])).toEqual([{ q: 1, r: 1 }]);
  });
});

describe("walking around furniture", () => {
  const room = hutRoom(1);
  const door = hutDoor(1);
  const floor = hutFloor(room);

  it("will not walk onto a placed furnishing, and goes around it", () => {
    const far = floor[0];
    const direct = hutPath(room, [], door, far)!;
    const inTheWay = direct[Math.floor(direct.length / 2)];
    const placed = [{ q: inTheWay.q, r: inTheWay.r }];
    expect(hutPath(room, placed, door, inTheWay)).toBeNull();
    const around = hutPath(room, placed, door, far);
    expect(around).not.toBeNull();
    expect(around!.some((p) => p.q === inTheWay.q && p.r === inTheWay.r)).toBe(false);
    // Furniture in storage is not in anyone's way.
    expect(hutPath(room, [{ q: null, r: null }], door, inTheWay)).not.toBeNull();
  });

  it("refuses walls, off-map hexes and standing still", () => {
    const wall = room.tiles.find((t) => t.biome === "wall")!;
    expect(hutPath(room, [], door, wall)).toBeNull();
    expect(hutPath(room, [], door, at(99, 99))).toBeNull();
    expect(hutPath(room, [], door, door)).toBeNull();
  });

  it("cannot leave a room whose doorway is boxed in", () => {
    const blockers = hexNeighbors(door, room.grid).filter((n) => tileAt(room, n)!.biome === "floor");
    expect(hutPath(room, blockers, door, floor[0])).toBeNull();
  });
});
