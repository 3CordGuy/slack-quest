import { describe, expect, it } from "vitest";
import { allHexesInGrid, hexDistance, hexNeighbors, hexSegment, inBounds, posKey, type HexGrid } from "./hex";

const GRID: HexGrid = { cols: 9, rows: 11 };

describe("inBounds (brick layout)", () => {
  it("returns true for valid positions on row 0", () => {
    expect(inBounds({ q: 0, r: 0 }, GRID)).toBe(true);
    expect(inBounds({ q: GRID.cols - 1, r: 0 }, GRID)).toBe(true);
  });

  it("odd rows have one fewer hex (brick offset)", () => {
    // Row 1 (odd): valid q in [0, cols-2]; q=cols-1 is OUT.
    expect(inBounds({ q: GRID.cols - 2, r: 1 }, GRID)).toBe(true);
    expect(inBounds({ q: GRID.cols - 1, r: 1 }, GRID)).toBe(false);
  });

  it("axial q shifts left in lower rows (rectangle visual)", () => {
    // Row 2 (even): valid q in [-1, cols-2]; q=-1 is IN, q=cols-1 is OUT.
    expect(inBounds({ q: -1, r: 2 }, GRID)).toBe(true);
    expect(inBounds({ q: GRID.cols - 1, r: 2 }, GRID)).toBe(false);
  });

  it("returns false for out-of-bounds row positions", () => {
    expect(inBounds({ q: 0, r: -1 }, GRID)).toBe(false);
    expect(inBounds({ q: 0, r: GRID.rows }, GRID)).toBe(false);
  });
});

describe("allHexesInGrid", () => {
  it("lists every in-bounds hex once: full even rows, odd rows one short", () => {
    const all = allHexesInGrid(GRID);
    expect(all).toHaveLength(6 * 9 + 5 * 8);
    expect(new Set(all.map(posKey)).size).toBe(all.length);
    expect(all.every((p) => inBounds(p, GRID))).toBe(true);
  });
});

describe("hexDistance", () => {
  it("same hex is distance 0", () => {
    expect(hexDistance({ q: 5, r: 3 }, { q: 5, r: 3 })).toBe(0);
  });

  it("adjacent hexes are distance 1", () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 1, r: 0 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: 0, r: 1 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: 1, r: -1 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: -1, r: 0 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: 0, r: -1 })).toBe(1);
    expect(hexDistance({ q: 0, r: 0 }, { q: -1, r: 1 })).toBe(1);
  });

  it("is symmetric", () => {
    expect(hexDistance({ q: 3, r: 2 }, { q: 7, r: 5 })).toBe(
      hexDistance({ q: 7, r: 5 }, { q: 3, r: 2 }),
    );
  });

  it("counts steps along a row", () => {
    expect(hexDistance({ q: 1, r: 3 }, { q: 11, r: 3 })).toBe(10);
  });

  it("diagonal distance uses cube-coord max", () => {
    // (0,0) to (2,2): dq=2, dr=2, |dq+dr|=4, so max = 4
    expect(hexDistance({ q: 0, r: 0 }, { q: 2, r: 2 })).toBe(4);
  });
});

describe("hexNeighbors", () => {
  // Interior hex of the brick layout (well clear of all edges).
  // q=4, r=5 → row 5 (odd, width 8, rowShift 2), offsetCol=6 → 6 neighbors.
  const interior = { q: 4, r: 5 };

  it("interior hex has 6 neighbors", () => {
    expect(hexNeighbors(interior, GRID)).toHaveLength(6);
  });

  it("corner hex has fewer neighbors", () => {
    // (0,0) has neighbors at (1,0), (0,1), (1,-1) but (1,-1) is out of bounds
    const n = hexNeighbors({ q: 0, r: 0 }, GRID);
    expect(n.length).toBeLessThan(6);
    expect(n.every((p) => inBounds(p, GRID))).toBe(true);
  });

  it("all neighbors are exactly 1 hex away", () => {
    const neighbors = hexNeighbors(interior, GRID);
    for (const n of neighbors) {
      expect(hexDistance(interior, n)).toBe(1);
    }
  });
});

describe("hexSegment", () => {
  it("is the one hex when both ends are the same", () => {
    expect(hexSegment({ q: 2, r: 2 }, { q: 2, r: 2 })).toEqual([{ q: 2, r: 2 }]);
  });

  it("runs from one end to the other, a step at a time", () => {
    const from = { q: 0, r: 0 };
    const to = { q: 3, r: 2 };
    const line = hexSegment(from, to);
    expect(line).toHaveLength(hexDistance(from, to) + 1);
    expect(line[0]).toEqual(from);
    expect(line[line.length - 1]).toEqual(to);
    for (let i = 1; i < line.length; i++) expect(hexDistance(line[i - 1], line[i])).toBe(1);
  });
});
