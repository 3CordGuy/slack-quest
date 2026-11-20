import { describe, expect, it } from "vitest";
import { allHexesInGrid, posKey, type HexGrid } from "@gantt-quest/core";
import { BASE_HEIGHT, findPath, reachable, tileAt, type Biome, type WorldMap } from "./index";

/**
 * Two rows of ground. The way along the top row is cut by water at (1,0), so the only way east is down through
 * the forest at (0,1) and along the bottom row:
 *
 *   (0,0) plains   (1,0) water    (2,0) plains   (3,0) plains
 *        (0,1) forest   (1,1) plains   (2,1) plains
 */
function strip(): WorldMap {
  const grid: HexGrid = { cols: 4, rows: 2 };
  const ground: Record<string, Biome> = { "1,0": "water", "0,1": "forest" };
  const tiles = allHexesInGrid(grid).map((p) => {
    const biome = ground[posKey(p)] ?? "plains";
    return { q: p.q, r: p.r, biome, h: BASE_HEIGHT[biome] };
  });
  return { grid, tiles, pois: [] };
}

describe("finding a way", () => {
  const from = { q: 0, r: 0 };
  const to = { q: 3, r: 0 };

  it("charges each step the cost of the ground it steps onto, and never crosses water", () => {
    const map = strip();
    const route = findPath(map, from, to)!;
    expect(route.path.at(-1)).toEqual(to);
    expect(route.path).toHaveLength(4);
    // Forest costs two, so the way costs more than its length.
    expect(route.cost).toBe(5);
    expect(route.path.every((p) => tileAt(map, p)!.biome !== "water")).toBe(true);
    expect(findPath(map, from, { q: 1, r: 0 })).toBeNull();
  });

  it("goes no further than its budget", () => {
    const map = strip();
    expect(findPath(map, from, to, 4)).toBeNull();
    expect(findPath(map, from, to, 5)).not.toBeNull();
    expect([...reachable(map, from, 2).keys()].sort()).toEqual(["0,0", "0,1"]);
  });
});
