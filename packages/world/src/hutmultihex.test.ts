// Pieces bigger than a hex (a long table, a four-poster, a runner), and flat
// floor decor that furniture stands on (see hutroom.ts, coveredHexes and isFlat).

import { describe, expect, it } from "vitest";
import { posKey, type HexPos } from "@gantt-quest/core";
import {
  FURNISHINGS,
  HEX_DIRS,
  PERK_CAPS,
  blockedHexes,
  buyFurnitureProblem,
  coveredHexes,
  craftProblem,
  displacedFurnishings,
  footprintCentre,
  hexCentre,
  hexSpan,
  hutDoor,
  hutFloor,
  hutPath,
  hutRoom,
  isFlat,
  lieDownProblem,
  placeProblem,
  smallPlaceProblem,
  tileAt,
  turnOf,
  useOf,
  type Furnishing,
} from "./index";

let next = 1;
const piece = (defId: string, at: HexPos | null, more: Partial<Furnishing> = {}): Furnishing => ({
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

const step = (p: HexPos, dir: number, n = 1): HexPos => ({ q: p.q + HEX_DIRS[dir].q * n, r: p.r + HEX_DIRS[dir].r * n });
const keys = (hexes: HexPos[]) => hexes.map(posKey).sort();
const at = (facing: number) => ({ x: 0, z: 0, angle: turnOf({ facing }) });

const room = hutRoom(2);
const floor = hutFloor(room);
const isFloor = (p: HexPos) => floor.some((f) => f.q === p.q && f.r === p.r);
/** A floor hex with floor all round it, and two steps out to the right, below and left: room for a long piece most ways it turns. */
const middle = floor.find((p) => HEX_DIRS.every((_, d) => isFloor(step(p, d))) && [1, 2, 3].every((d) => isFloor(step(p, d, 2))))!;

const TWO_HEX = ["long_table", "long_bench", "four_poster", "great_bookcase"];

describe("pieces bigger than a hex", () => {
  it("knows how many hexes each piece spans", () => {
    for (const id of TWO_HEX) expect(hexSpan(id)).toBe(2);
    expect(hexSpan("runner_rug")).toBe(3);
    expect(hexSpan("round_rug")).toBe(3);
    // Everything that was already in the catalogue still covers one hex.
    for (const id of ["table", "chair", "rug", "bed", "chest", "hearth", "bookshelf", "fireplace", "workbench", "trophy_relic"]) expect(hexSpan(id)).toBe(1);
  });

  it("anchors on its own hex and reaches across the neighbour it is turned toward", () => {
    expect(middle).toBeDefined();
    for (let facing = 0; facing < 6; facing++) {
      // Facing 0 reaches right (HEX_DIRS[1]); each sixth of a turn moves round to the next neighbour.
      expect(keys(coveredHexes("long_table", middle, at(facing)))).toEqual(keys([middle, step(middle, (1 + facing) % 6)]));
    }
    // A runner reaches two hexes along; a round rug covers its hex and the two next to it.
    expect(keys(coveredHexes("runner_rug", middle, at(0)))).toEqual(keys([middle, step(middle, 1), step(middle, 1, 2)]));
    expect(keys(coveredHexes("round_rug", middle, at(0)))).toEqual(keys([middle, step(middle, 1), step(middle, 2)]));
  });

  it("puts its middle between the hexes it covers", () => {
    const c = footprintCentre("long_table", middle, at(0));
    const [a, b] = [hexCentre(middle), hexCentre(step(middle, 1))];
    expect(c.x).toBeCloseTo((a.x + b.x) / 2);
    expect(c.z).toBeCloseTo((a.z + b.z) / 2);
  });

  it("fits across two free floor hexes", () => {
    for (const id of TWO_HEX) expect(placeProblem(room, [], id, middle)).toBeNull();
    expect(placeProblem(room, [], "runner_rug", middle)).toBeNull();
    expect(placeProblem(room, [], "round_rug", middle)).toBeNull();
  });

  it("will not reach into a wall, or out of the room", () => {
    // The right-most floor hex of a row: its anchor is fine, its far end is in the side wall.
    const edge = floor.find((p) => !isFloor(step(p, 1)) && tileAt(room, step(p, 1))?.biome === "wall")!;
    expect(placeProblem(room, [], "chair", edge)).toBeNull();
    expect(placeProblem(room, [], "long_table", edge, at(0))).toBe("It would go through the wall.");
    // Turned to reach left instead, it fits.
    expect(placeProblem(room, [], "long_table", edge, at(3))).toBeNull();
    // Off the map altogether.
    expect(placeProblem(room, [], "long_table", { q: 99, r: 99 })).toBe("That is outside the room.");
  });

  it("will not reach onto the doorway", () => {
    const door = hutDoor(2);
    // Anchored on the floor just inside the door, turned to reach out onto it.
    const dir = HEX_DIRS.findIndex((d) => isFloor({ q: door.q - d.q, r: door.r - d.r }));
    const anchor = { q: door.q - HEX_DIRS[dir].q, r: door.r - HEX_DIRS[dir].r };
    const facing = (dir + 5) % 6;
    expect(keys(coveredHexes("long_bench", anchor, at(facing)))).toContain(posKey(door));
    expect(placeProblem(room, [], "long_bench", anchor, at(facing))).toBe("The doorway has to stay clear.");
    // Turned to reach back into the room, it fits.
    expect(placeProblem(room, [], "long_bench", anchor, at((facing + 3) % 6))).toBeNull();
  });

  it("will not overlap a piece standing on any hex it covers", () => {
    const far = step(middle, 1);
    const stool = piece("chair", far);
    expect(placeProblem(room, [stool], "long_table", middle, at(0))).toBe("Something already stands there.");
    // Turned away from the stool, it fits.
    expect(placeProblem(room, [stool], "long_table", middle, at(3))).toBeNull();
    // And a stool cannot go under the far end of a placed table.
    const table = piece("long_table", middle);
    expect(placeProblem(room, [table], "chair", far)).toBe("Something already stands there.");
    // Two long pieces side by side on the row below are fine.
    expect(placeProblem(room, [table], "long_bench", step(middle, 2), at(0))).toBeNull();
  });

  it("re-checks every covered hex when it is turned", () => {
    const table = piece("long_table", middle);
    const crate = piece("crate", step(middle, 2));
    // Facing 0 it is clear of the crate; turned a sixth it would swing into it.
    expect(placeProblem(room, [crate], table.defId, middle, at(0))).toBeNull();
    expect(placeProblem(room, [crate], table.defId, middle, at(1))).toBe("Something already stands there.");
  });

  it("keeps people off every hex it covers, and they walk around it", () => {
    const table = piece("long_table", middle);
    const blocked = blockedHexes([table]);
    expect(blocked.has(posKey(middle))).toBe(true);
    expect(blocked.has(posKey(step(middle, 1)))).toBe(true);
    const door = hutDoor(2);
    expect(hutPath(room, [table], door, step(middle, 1))).toBeNull();
    const beyond = step(middle, 0, 1);
    const route = hutPath(room, [table], door, beyond);
    expect(route).not.toBeNull();
    expect(route!.some((p) => blocked.has(posKey(p)))).toBe(false);
  });

  it("goes back to storage when a smaller room cannot hold it", () => {
    const small = hutRoom(1);
    // One table whose far end only the Cottage's floor holds, and one that fits the Shack too.
    const onlyBig = floor.find((p) => !placeProblem(room, [], "long_table", p) && placeProblem(small, [], "long_table", p))!;
    const both = floor.find((p) => !placeProblem(room, [], "long_table", p) && !placeProblem(small, [], "long_table", p) && Math.abs(p.r - onlyBig.r) > 1)!;
    expect(onlyBig).toBeDefined();
    expect(both).toBeDefined();
    const [lost, kept] = [piece("long_table", onlyBig), piece("long_table", both)];
    expect(displacedFurnishings(1, [lost, kept])).toEqual([lost]);
    expect(displacedFurnishings(2, [lost, kept])).toEqual([]);
  });
});

describe("flat floor decor", () => {
  it("marks rugs flat and nothing else", () => {
    for (const def of Object.values(FURNISHINGS)) expect(isFlat(def.id)).toBe(["rug", "runner_rug", "round_rug"].includes(def.id));
  });

  it("lets furniture stand on a rug, and a rug go under furniture", () => {
    const rug = piece("round_rug", middle);
    expect(placeProblem(room, [rug], "long_table", middle)).toBeNull();
    expect(placeProblem(room, [rug], "chair", step(middle, 2))).toBeNull();
    const table = piece("long_table", middle);
    const stool = piece("chair", step(middle, 2));
    expect(placeProblem(room, [table, stool], "round_rug", middle)).toBeNull();
    expect(placeProblem(room, [table], "rug", step(middle, 1))).toBeNull();
    // Together they are a legal layout, kept when the room changes.
    expect(displacedFurnishings(2, [rug, table, stool])).toEqual([]);
  });

  it("keeps rugs from overlapping each other", () => {
    const runner = piece("runner_rug", middle);
    expect(placeProblem(room, [runner], "rug", step(middle, 1))).toBe("There is already a rug there.");
    expect(placeProblem(room, [runner], "round_rug", middle)).toBe("There is already a rug there.");
    expect(placeProblem(room, [runner], "rug", step(middle, 3, 2))).toBeNull();
  });

  it("still keeps rugs on the floor and off the doorway", () => {
    const door = hutDoor(2);
    const beside = floor.find((p) => HEX_DIRS.some((d) => p.q + d.q === door.q && p.r + d.r === door.r))!;
    const reaches = [0, 1, 2, 3, 4, 5].find((f) => coveredHexes("runner_rug", beside, at(f)).some((h) => h.q === door.q && h.r === door.r));
    expect(reaches).toBeDefined();
    expect(placeProblem(room, [], "runner_rug", beside, at(reaches!))).toMatch(/doorway|wall/);
  });

  it("lets small things stand on a rug", () => {
    const rug = piece("runner_rug", middle);
    expect(smallPlaceProblem(room, [rug], "candle", { pos: step(middle, 1), x: 0, z: 0, angle: 0 })).toBeNull();
    // A small thing already on the floor does not stop a rug going down over it.
    const candle = piece("candle", step(middle, 1));
    expect(placeProblem(room, [candle], "runner_rug", middle)).toBeNull();
  });

  it("is walked over", () => {
    const rug = piece("runner_rug", middle);
    expect(blockedHexes([rug]).size).toBe(0);
    expect(hutPath(room, [rug], hutDoor(2), step(middle, 1))).not.toBeNull();
    // A table on the rug still blocks its own hexes.
    expect(blockedHexes([rug, piece("long_table", middle)]).size).toBe(2);
  });
});

describe("the new big pieces in the catalogue", () => {
  it("sleeps in a four-poster like a bunk", () => {
    expect(useOf("four_poster")).toBe("rest");
    const bed = piece("four_poster", middle);
    const beside = step(middle, 0);
    expect(lieDownProblem(room, [bed], bed.id, beside, true)).toBeNull();
    expect(lieDownProblem(room, [bed], bed.id, beside, false)).toMatch(/sleeps here/);
    // The far end counts as beside it too.
    expect(lieDownProblem(room, [bed], bed.id, step(step(middle, 1), 1), true)).toBeNull();
  });

  it("keeps perks modest and inside the caps", () => {
    for (const id of [...TWO_HEX, "runner_rug", "round_rug"]) {
      const perk = FURNISHINGS[id].perk ?? {};
      for (const [k, v] of Object.entries(perk)) expect(v).toBeLessThanOrEqual(PERK_CAPS[k as keyof typeof PERK_CAPS]);
      expect(FURNISHINGS[id].price ?? FURNISHINGS[id].recipe).toBeDefined();
    }
  });

  it("only sells or crafts the biggest pieces for a hut that has outgrown the Shack", () => {
    const plenty = { wood: 99, fur: 99, bone: 99, herbs: 99 };
    for (const id of ["four_poster", "great_bookcase"]) {
      expect(FURNISHINGS[id].minTier).toBe(2);
      expect(craftProblem(id, [], plenty, 1)).toBe("That needs a bigger hut: a Cottage.");
      expect(craftProblem(id, [], plenty, 2)).toBeNull();
      expect(craftProblem(id, [], plenty, 3)).toBeNull();
    }
    // The rest fit a Shack.
    expect(craftProblem("long_table", [], plenty, 1)).toBeNull();
    expect(buyFurnitureProblem("long_table", 999, 1)).toBeNull();
    expect(buyFurnitureProblem("runner_rug", 999, 1)).toBeNull();
  });
});
