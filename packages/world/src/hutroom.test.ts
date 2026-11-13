import { describe, expect, it } from "vitest";
import { hexNeighbors } from "@gantt-quest/core";
import { FURNISHINGS, HUT_TIERS, SMALL_PER_SPOT, STORAGE_CHEST, displacedFurnishings, freeSpot, hutDoor, hutFloor, hutPath, hutRoom, hutTier, HEX_DIRS, besideHexes, isBeside, lieDownProblem, useOf, useProblem, placeProblem, placedFurnishings, poiAt, putInProblem, smallPlaceProblem, tileAt, validFacing, type Furnishing } from "./index";

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

describe("a hut changing size", () => {
  it("keeps every piece where it stands when the room grows", () => {
    for (const tier of HUT_TIERS.slice(0, -1)) {
      const full = hutFloor(hutRoom(tier.tier)).map((pos) => ({ defId: "chair", ...pos }));
      expect(displacedFurnishings(tier.tier, full)).toEqual([]);
      expect(displacedFurnishings(tier.tier + 1, full)).toEqual([]);
    }
  });

  it("sends back pieces the new room has no place for", () => {
    const big = hutFloor(hutRoom(3)).map((pos) => ({ defId: "chair", ...pos }));
    const out = displacedFurnishings(1, big);
    expect(out.length).toBeGreaterThan(0);
    const small = hutRoom(1);
    for (const f of big) expect(out.includes(f)).toBe(placeProblem(small, [], f.defId, f) !== null);
    // Two pieces on one hex: the later one goes. Stored pieces are never touched.
    const spot = hutFloor(small)[0];
    const twin = [{ defId: "table", ...spot }, { defId: "rug", ...spot }, { defId: "bed", q: null, r: null }];
    expect(displacedFurnishings(1, twin)).toEqual([twin[1]]);
  });
});

describe("the free storage chest", () => {
  it("is a free container with no perk, never sold or crafted", () => {
    const def = FURNISHINGS[STORAGE_CHEST];
    expect(def.kind).toBe("furniture");
    expect(def.storage).toBeGreaterThan(0);
    expect(def.price ?? def.recipe ?? def.perk).toBeUndefined();
  });

  it("finds a legal spot away from the door, and none on a full floor", () => {
    for (const { tier } of HUT_TIERS) {
      const room = hutRoom(tier);
      const door = hutDoor(tier);
      const spot = freeSpot(room, [], STORAGE_CHEST, door)!;
      expect(placeProblem(room, [], STORAGE_CHEST, spot)).toBeNull();
      const full = hutFloor(room).map((p) => ({ ...p }));
      expect(freeSpot(room, full, STORAGE_CHEST, door)).toBeNull();
    }
  });

  it("goes around what already stands", () => {
    const room = hutRoom(1);
    const door = hutDoor(1);
    const first = freeSpot(room, [], STORAGE_CHEST, door)!;
    const second = freeSpot(room, [first], STORAGE_CHEST, door)!;
    expect(second).not.toEqual(first);
  });
});

describe("small things and containers", () => {
  const room = hutRoom(1);
  const [a, b] = hutFloor(room).filter((p) => poiAt(room, p)?.kind !== "door");
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

  it("puts a small thing anywhere near the middle of a free hex", () => {
    expect(smallPlaceProblem(room, [], "candle", { pos: a, x: 0.3, z: -0.4, angle: 1 })).toBeNull();
    expect(smallPlaceProblem(room, [], "candle", { pos: a, x: 0.8, z: 0.2, angle: 0 })).toMatch(/inside the hex/);
    expect(smallPlaceProblem(room, [], "table", { pos: a, x: 0, z: 0, angle: 0 })).toMatch(/too big/);
    expect(smallPlaceProblem(room, [], "candle", { pos: a, x: Number.NaN, z: 0, angle: 0 })).not.toBeNull();
  });

  it("stands a small thing on a top, within its edges, but not on something without one", () => {
    const table = piece("table", a);
    const stool = piece("chair", b);
    const top = FURNISHINGS.table.surface!;
    expect(smallPlaceProblem(room, [table], "mug", { on: table.id, x: top.w / 2 - 0.01, z: 0, angle: 0 })).toBeNull();
    expect(smallPlaceProblem(room, [table], "mug", { on: table.id, x: top.w, z: 0, angle: 0 })).toMatch(/edge/);
    expect(smallPlaceProblem(room, [stool], "mug", { on: stool.id, x: 0, z: 0, angle: 0 })).toMatch(/Nothing can stand/);
    // Nor on a hex furniture stands on.
    expect(smallPlaceProblem(room, [table], "mug", { pos: a, x: 0, z: 0, angle: 0 })).toMatch(/already stands/);
    // A top fills up.
    const full = Array.from({ length: SMALL_PER_SPOT }, () => piece("candle", a, { onId: table.id }));
    expect(smallPlaceProblem(room, [table, ...full], "mug", { on: table.id, x: 0, z: 0, angle: 0 })).toMatch(/no room/);
  });

  it("keeps furniture off small things on the floor, but not off what stands on it", () => {
    const candle = piece("candle", a);
    expect(placeProblem(room, [candle], "table", a)).toMatch(/Clear the small things/);
    const table = piece("table", b);
    const mug = piece("mug", b, { onId: table.id });
    expect(placeProblem(room, [mug], "chair", b)).toBeNull();
  });

  it("lets people step over small things", () => {
    const door = hutDoor(1);
    const candle = piece("candle", a);
    const path = hutPath(room, [candle], door, a);
    expect(path?.at(-1)).toEqual(a);
  });

  it("only lets containers take things, never themselves or other containers, and only while there is room", () => {
    const chest = piece("chest", a);
    const crate = piece("crate", null);
    const candle = piece("candle", null);
    expect(putInProblem(candle, chest, 0)).toBeNull();
    expect(putInProblem(candle, chest, FURNISHINGS.chest.storage!)).toMatch(/full/);
    expect(putInProblem(crate, chest, 0)).toMatch(/other containers/);
    expect(putInProblem(chest, chest, 0)).not.toBeNull();
    expect(putInProblem(candle, piece("table", b), 0)).toMatch(/does not hold/);
  });

  it("sends small things home with the furniture they stood on when the room shrinks around it", () => {
    const table = piece("table", { q: 99, r: 99 });
    const mug = piece("mug", { q: 99, r: 99 }, { onId: table.id });
    const candle = piece("candle", a);
    const out = displacedFurnishings(1, [table, mug, candle]);
    expect(out.map((f) => f.id).sort()).toEqual([table.id, mug.id].sort());
  });
});

describe("using pieces outside edit mode", () => {
  const room = hutRoom(2);
  const floor = hutFloor(room).filter((p) => poiAt(room, p)?.kind !== "door");
  // A hex in the middle of the room, every neighbour of it floor too.
  const mid = floor.find((p) => HEX_DIRS.map((d) => ({ q: p.q + d.q, r: p.r + d.r })).every((n) => tileAt(room, n)?.biome === "floor" && poiAt(room, n)?.kind !== "door"))!;
  let next = 100;
  const piece = (defId: string, at: { q: number; r: number } | null, more: Partial<Furnishing> = {}): Furnishing => ({
    id: next++, defId, label: defId, q: at?.q ?? null, r: at?.r ?? null, facing: 0, x: 0, z: 0, y: 0, angle: 0, onId: null, inId: null, ...more,
  });

  it("rests in a bed, opens containers, warms up at a fire, reads books and otherwise looks", () => {
    expect(useOf("bed")).toBe("rest");
    for (const id of ["chest", "storage_chest", "dresser", "crate", "barrel", "cupboard"]) expect(useOf(id), id).toBe("open");
    expect(useOf("hearth")).toBe("warm");
    expect(useOf("fireplace")).toBe("warm");
    expect(useOf("bookshelf")).toBe("read");
    expect(useOf("chair")).toBe("look");
    expect(useOf("nonsense")).toBe("look");
  });

  it("keeps the bed and the chests to the owner, and lets visitors use the rest", () => {
    expect(useProblem("bed", true)).toBeNull();
    expect(useProblem("storage_chest", true)).toBeNull();
    expect(useProblem("bed", false, "Ada")).toMatch(/Only Ada sleeps here/);
    expect(useProblem("chest", false)).toMatch(/can open/);
    expect(useProblem("dresser", false)).not.toBeNull();
    expect(useProblem("hearth", false)).toBeNull();
    expect(useProblem("bookshelf", false)).toBeNull();
    expect(useProblem("chair", false)).toBeNull();
  });

  it("is used from beside it: never from a wall, a blocked hex or across the room", () => {
    const bed = piece("bed", mid);
    const beside = besideHexes(room, [bed], bed);
    expect(beside.length).toBeGreaterThan(0);
    for (const h of beside) {
      expect(tileAt(room, h)?.biome).toBe("floor");
      expect(h).not.toEqual(mid);
    }
    const far = floor.find((p) => !beside.some((h) => h.q === p.q && h.r === p.r) && (p.q !== mid.q || p.r !== mid.r))!;
    expect(isBeside(room, [bed], bed, far)).toBe(false);
    expect(isBeside(room, [bed], bed, beside[0])).toBe(true);
    // A small thing on a table is reached from beside the table.
    const table = piece("table", mid);
    const mug = piece("mug", mid, { onId: table.id });
    expect(besideHexes(room, [table, mug], mug)).toEqual(besideHexes(room, [table, mug], table));
    // Something stored is nowhere.
    expect(besideHexes(room, [piece("bed", null)], piece("bed", null))).toEqual([]);
  });

  it("lets only the owner lie down, on a placed bed, standing next to it", () => {
    const bed = piece("bed", mid);
    const chair = piece("chair", floor.find((p) => p.q !== mid.q || p.r !== mid.r)!);
    const stored = piece("bed", null);
    const all = [bed, chair, stored];
    const near = besideHexes(room, all, bed)[0];
    const far = floor.find((p) => !isBeside(room, all, bed, p) && (p.q !== mid.q || p.r !== mid.r))!;
    expect(lieDownProblem(room, all, bed.id, near, true)).toBeNull();
    expect(lieDownProblem(room, all, bed.id, near, false)).toMatch(/sleeps here/);
    expect(lieDownProblem(room, all, bed.id, far, true)).toMatch(/Walk over/);
    expect(lieDownProblem(room, all, chair.id, near, true)).toMatch(/no bed/);
    expect(lieDownProblem(room, all, stored.id, near, true)).toMatch(/no bed/);
    expect(lieDownProblem(room, all, 9999, near, true)).toMatch(/no bed/);
  });
});
